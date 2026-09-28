/**
 * Characterization of `usePrStatus`, the PR/MR pill's data source in the
 * prompt footer and the branch segment.
 *
 * The code host's CLI is the boundary. Stand-ins for `gh`, `glab` and `tea`
 * sit first on PATH: each records its working directory and arguments, then
 * prints what the test put in its reply file. The session sits in a real
 * repository on a feature branch, with git kept away from the user's config.
 *
 * Time: the 2 s cadence, the spacing after a re-run and the slow-answer limit
 * run on the real clock, so they hold whichever clock the hook measures an
 * ask with (spec, finding 8). The idle hour and the lastUpdated stamps are
 * wall-clock rules, reached by freezing Date at a chosen instant
 * (setSystemTime), which moves Date.now() without moving timers.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  getCwdState,
  setCwdState,
  updateLastInteractionTime,
} from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { hostHook, stopAllHooks, until } from 'src/vcs/diff/hooks/__testutils__/hookHost.js'
import { isolateGitEnv, type IsolatedGitEnv } from 'src/vcs/git/__testutils__/isolatedGitEnv.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import { getIsGit } from 'src/vcs/git/git.js'
import { type PrStatusState, usePrStatus } from 'src/vcs/hooks/usePrStatus.js'

type Cli = 'gh' | 'glab' | 'tea'
type CliCall = { cli: string; cwd: string; args: string[] }

const EMPTY_PILL: PrStatusState = {
  number: null,
  url: null,
  reviewState: null,
  label: null,
  lastUpdated: 0,
}

const GH_VIEW = ['pr', 'view', '--json', 'number,url,reviewDecision,isDraft,headRefName,state']
const GLAB_VIEW = ['mr', 'view', '-F', 'json']
const TEA_LIST = [
  'pr', 'list', '-o', 'json', '--state', 'open', '--limit', '100',
  '--fields', 'index,state,head,url,title',
]

/**
 * Fake forge CLIs. A reply can be set for one subcommand (`glab mr list`) or
 * for the CLI as a whole. `holdNextCall` makes the next call of that CLI wait,
 * after it has read its reply and logged itself, until `release()`.
 */
class ForgeClis {
  readonly bin: string
  private readonly box: string
  private readonly seenAt: number[] = []

  constructor(root: string) {
    this.bin = join(root, 'bin')
    this.box = join(root, 'box')
    mkdirSync(this.bin)
    mkdirSync(this.box)
    for (const cli of ['gh', 'glab', 'tea'] as const) {
      const path = join(this.bin, cli)
      writeFileSync(path, this.script(cli))
      chmodSync(path, 0o755)
    }
  }

  private script(cli: Cli): string {
    const box = this.box
    return [
      '#!/bin/sh',
      `box='${box}'`,
      `reply=$(cat "$box/${cli}.$1.$2.out" 2>/dev/null || cat "$box/${cli}.out" 2>/dev/null)`,
      `status=$(cat "$box/${cli}.status" 2>/dev/null || echo 0)`,
      'held=no',
      `if mv "$box/${cli}.hold" "$box/${cli}.held.$$" 2>/dev/null; then held=yes; fi`,
      `printf '%s\\t%s\\t%s\\n' '${cli}' "$(pwd -P)" "$(printf '%s\\037' "$@")" >> "$box/calls"`,
      'if [ "$held" = yes ]; then',
      '  while [ ! -e "$box/release" ]; do sleep 0.02; done',
      'fi',
      `printf '%s' "$reply"`,
      `printf '%s\\n' '${cli}' >> "$box/exits"`,
      'exit "$status"',
      '',
    ].join('\n')
  }

  reply(cli: Cli, stdout: unknown, options: { status?: number; subcommand?: string } = {}): void {
    const text = typeof stdout === 'string' ? stdout : JSON.stringify(stdout)
    const name = options.subcommand ? `${cli}.${options.subcommand.replace(' ', '.')}` : cli
    writeFileSync(join(this.box, `${name}.out`), text)
    writeFileSync(join(this.box, `${cli}.status`), String(options.status ?? 0))
  }

  silence(cli: Cli): void {
    rmSync(join(this.box, `${cli}.out`), { force: true })
  }

  holdNextCall(cli: Cli): void {
    writeFileSync(join(this.box, `${cli}.hold`), '')
  }

  release(): void {
    writeFileSync(join(this.box, 'release'), '')
  }

  calls(): CliCall[] {
    const file = join(this.box, 'calls')
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const now = performance.now()
    while (this.seenAt.length < lines.length) this.seenAt.push(now)
    return lines.map(line => {
      const [cli = '', cwd = '', joined = ''] = line.split('\t')
      return { cli, cwd, args: joined.split('\u001f').slice(0, -1) }
    })
  }

  exits(): number {
    const file = join(this.box, 'exits')
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
  }

  /** Waits for the nth call (1-based) and returns when it was first seen. */
  async nthCall(n: number, withinMs = 3_000): Promise<number> {
    await until(`call #${n} of a forge CLI`, () => this.calls().length >= n, withinMs)
    return this.seenAt[n - 1] as number
  }

  /** Waits until n processes have exited, plus time for the hook to read the reply. */
  async settled(n: number): Promise<void> {
    await until(`${n} forge CLI exits`, () => this.exits() >= n)
    await Bun.sleep(150)
  }
}

let scratch: ScratchGit
let env: IsolatedGitEnv
let forge: ForgeClis
let sessionCwdBefore: string
let hostsBefore: ReturnType<typeof getGlobalConfig>['prStatusHosts']

beforeEach(() => {
  scratch = new ScratchGit()
  env = isolateGitEnv(scratch.tempDir('home'))
  env.set('CLAUDIN_CONFIG_DIR', scratch.tempDir('config'))
  forge = new ForgeClis(scratch.tempDir('forge'))
  env.set('PATH', `${forge.bin}:${process.env.PATH ?? ''}`)
  sessionCwdBefore = getCwdState()
  hostsBefore = getGlobalConfig().prStatusHosts
})

afterEach(() => {
  stopAllHooks()
  setSystemTime()
  saveGlobalConfig(config => ({ ...config, prStatusHosts: hostsBefore }))
  setCwdState(sessionCwdBefore)
  getIsGit.cache.clear()
  env.restore()
  scratch.cleanup()
})

/** A repository on `branch` (after one commit on main), with `origin` when given. */
function checkout(origin: string | null, branch = 'feature/pill'): string {
  const repo = scratch.repo('pr', 'main')
  if (branch !== 'main') scratch.run(repo, 'checkout', '-q', '-b', branch)
  if (origin) scratch.run(repo, 'remote', 'add', 'origin', origin)
  return repo
}

function sessionIn(dir: string): void {
  setCwdState(dir)
  getIsGit.cache.clear()
}

type HostSetting = 'github' | 'gitlab' | 'gitea' | 'none'

function configureHosts(hosts: Record<string, HostSetting>): void {
  saveGlobalConfig(config => ({ ...config, prStatusHosts: hosts }))
}

type PillArgs = { loading: boolean; enabled?: boolean }

function mountPill(args: PillArgs) {
  return hostHook(
    (a: PillArgs) => (a.enabled === undefined ? usePrStatus(a.loading) : usePrStatus(a.loading, a.enabled)),
    args,
  )
}

/** Freezes Date at a round instant near the real one and returns it. */
function freezeClock(): number {
  const at = Math.floor(Date.now() / 1000) * 1000
  setSystemTime(new Date(at))
  updateLastInteractionTime(true)
  return at
}

function moveClockTo(at: number): void {
  setSystemTime(new Date(at))
}

function ghOpenPr(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    url: 'https://github.com/acme/widgets/pull/42',
    reviewDecision: 'REVIEW_REQUIRED',
    isDraft: false,
    headRefName: 'feature/pill',
    state: 'OPEN',
    ...fields,
  }
}

describe('what it asks the code host, and how it reads the answer', () => {
  const hosts: Array<{
    name: string
    origin: string
    configured?: Record<string, HostSetting>
    cli: Cli
    reply: unknown
    args: string[]
    pill: Partial<PrStatusState>
  }> = [
    {
      name: 'a github.com origin asks gh for the pull request of the branch',
      origin: 'https://github.com/acme/widgets.git',
      cli: 'gh',
      reply: ghOpenPr({ reviewDecision: 'CHANGES_REQUESTED' }),
      args: GH_VIEW,
      pill: {
        number: 42,
        url: 'https://github.com/acme/widgets/pull/42',
        reviewState: 'changes_requested',
        label: 'PR',
      },
    },
    {
      name: 'a gitlab.com origin asks glab for the merge request',
      origin: 'git@gitlab.com:acme/widgets.git',
      cli: 'glab',
      reply: {
        iid: 7,
        web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/7',
        state: 'opened',
        draft: false,
        source_branch: 'feature/pill',
        approvals_left: 0,
      },
      args: GLAB_VIEW,
      pill: {
        number: 7,
        url: 'https://gitlab.com/acme/widgets/-/merge_requests/7',
        reviewState: 'approved',
        label: 'MR',
      },
    },
    {
      name: 'a codeberg.org origin asks tea for the open pull requests and picks the branch',
      origin: 'https://codeberg.org/acme/widgets.git',
      cli: 'tea',
      reply: [
        { index: '80', state: 'open', head: 'other', url: 'https://codeberg.org/acme/widgets/pulls/80' },
        { index: '81', state: 'open', head: 'feature/pill', url: 'https://codeberg.org/acme/widgets/pulls/81' },
      ],
      args: TEA_LIST,
      pill: {
        number: 81,
        url: 'https://codeberg.org/acme/widgets/pulls/81',
        reviewState: 'pending',
        label: 'PR',
      },
    },
    {
      name: 'a host the configuration maps to gitea asks tea',
      origin: 'https://forge.corp.example/acme/widgets.git',
      configured: { 'forge.corp.example': 'gitea' },
      cli: 'tea',
      reply: [{ index: 5, state: 'open', head: 'feature/pill', url: 'https://forge.corp.example/acme/widgets/pulls/5', draft: true }],
      args: TEA_LIST,
      pill: {
        number: 5,
        url: 'https://forge.corp.example/acme/widgets/pulls/5',
        reviewState: 'draft',
        label: 'PR',
      },
    },
    {
      name: 'the configuration overrides a well-known host',
      origin: 'https://github.com/acme/widgets.git',
      configured: { 'github.com': 'gitlab' },
      cli: 'glab',
      reply: {
        iid: 9,
        web_url: 'https://github.com/acme/widgets/-/merge_requests/9',
        state: 'opened',
        draft: true,
        source_branch: 'feature/pill',
      },
      args: GLAB_VIEW,
      pill: {
        number: 9,
        url: 'https://github.com/acme/widgets/-/merge_requests/9',
        reviewState: 'draft',
        label: 'MR',
      },
    },
  ]

  for (const row of hosts) {
    test(row.name, async () => {
      const repo = checkout(row.origin)
      if (row.configured) configureHosts(row.configured)
      forge.reply(row.cli, row.reply)
      sessionIn(repo)

      const pill = await mountPill({ loading: false })
      await until('the pill to fill in', () => pill.current().number !== null)

      expect(forge.calls()).toEqual([{ cli: row.cli, cwd: repo, args: row.args }])
      expect(pill.current()).toMatchObject(row.pill)
    })
  }

  test('an unknown host is probed with all three CLIs, then asked through the one that owns it', async () => {
    const host = `git-${process.pid}-${Math.floor(performance.now())}.corp.example`
    const repo = checkout(`https://${host}/acme/widgets.git`)
    forge.reply('glab', [], { subcommand: 'mr list' })
    forge.reply('glab', {
      iid: 3,
      web_url: `https://${host}/acme/widgets/-/merge_requests/3`,
      state: 'opened',
      source_branch: 'feature/pill',
    }, { subcommand: 'mr view' })
    sessionIn(repo)

    const pill = await mountPill({ loading: false })
    await until('the pill to fill in', () => pill.current().number !== null)

    const calls = forge.calls()
    const probes = calls.slice(0, 3).map(call => `${call.cli} ${call.args.join(' ')}`).sort()
    expect(probes).toEqual([
      'gh repo view --json nameWithOwner',
      'glab mr list -F json',
      `tea ${TEA_LIST.join(' ')}`,
    ])
    expect(calls.slice(3)).toEqual([{ cli: 'glab', cwd: repo, args: GLAB_VIEW }])
    expect(pill.current()).toMatchObject({ number: 3, reviewState: 'pending', label: 'MR' })
  })

  const reviewStates = [
    { reply: { isDraft: true, reviewDecision: 'APPROVED' }, reviewState: 'draft' },
    { reply: { reviewDecision: 'APPROVED' }, reviewState: 'approved' },
    { reply: { reviewDecision: 'CHANGES_REQUESTED' }, reviewState: 'changes_requested' },
    { reply: { reviewDecision: 'REVIEW_REQUIRED' }, reviewState: 'pending' },
    { reply: { reviewDecision: '' }, reviewState: 'pending' },
  ]

  for (const row of reviewStates) {
    test(`gh ${JSON.stringify(row.reply)} reads as ${row.reviewState}`, async () => {
      const repo = checkout('https://github.com/acme/widgets.git')
      forge.reply('gh', ghOpenPr(row.reply))
      sessionIn(repo)

      const pill = await mountPill({ loading: false })
      await until('the pill to fill in', () => pill.current().number !== null)

      expect(pill.current().reviewState).toBe(row.reviewState as PrStatusState['reviewState'])
    })
  }

  const noPullRequest = [
    { name: 'gh prints nothing and fails (no PR for the branch)', reply: '', status: 1 },
    { name: 'the PR was merged', reply: ghOpenPr({ state: 'MERGED' }), status: 0 },
    { name: 'the PR was closed', reply: ghOpenPr({ state: 'CLOSED' }), status: 0 },
    { name: 'the PR comes from the default branch', reply: ghOpenPr({ headRefName: 'main' }), status: 0 },
    { name: 'the reply is not JSON', reply: 'gh: not logged in', status: 0 },
  ]

  for (const row of noPullRequest) {
    test(`no pill when ${row.name}`, async () => {
      const repo = checkout('https://github.com/acme/widgets.git')
      forge.reply('gh', row.reply, { status: row.status })
      sessionIn(repo)

      const pill = await mountPill({ loading: false })
      await forge.settled(1)

      expect(forge.calls()).toHaveLength(1)
      expect(pill.current()).toEqual(EMPTY_PILL)
    })
  }

  const nothingAsked = [
    {
      name: 'the session is not in a repository',
      session: () => scratch.tempDir('plain'),
    },
    {
      name: 'the branch is the default branch',
      session: () => checkout('https://github.com/acme/widgets.git', 'main'),
    },
    {
      name: 'the configuration maps the host to none',
      session: () => {
        configureHosts({ 'github.com': 'none' })
        return checkout('https://github.com/acme/widgets.git')
      },
    },
  ]

  for (const row of nothingAsked) {
    test(`no CLI runs when ${row.name}`, async () => {
      forge.reply('gh', ghOpenPr())
      sessionIn(row.session())

      const pill = await mountPill({ loading: false })
      await Bun.sleep(400)

      expect(forge.calls()).toEqual([])
      expect(pill.current()).toEqual(EMPTY_PILL)
    })
  }
})

describe('the state it returns', () => {
  test('starts empty, and stamps an answer with the time it changed the state', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    sessionIn(repo)
    const frozenAt = freezeClock()

    const pill = await mountPill({ loading: false })
    expect(pill.renders[0]).toEqual(EMPTY_PILL)
    await until('the pill to fill in', () => pill.current().number !== null)

    expect(pill.current()).toEqual({
      number: 42,
      url: 'https://github.com/acme/widgets/pull/42',
      reviewState: 'pending',
      label: 'PR',
      lastUpdated: frozenAt,
    })
  })

  test('the same answer again leaves the state object as it was; a new one replaces it', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    sessionIn(repo)
    const t0 = freezeClock()

    const pill = await mountPill({ loading: false })
    await until('the first answer', () => pill.current().number !== null)
    const first = pill.current()

    moveClockTo(t0 + 2_000)
    pill.rerender({ loading: true })
    await forge.settled(2)
    expect(pill.current()).toBe(first)

    forge.reply('gh', ghOpenPr({ reviewDecision: 'APPROVED' }))
    moveClockTo(t0 + 4_000)
    pill.rerender({ loading: false })
    await until('the new review state', () => pill.current().reviewState === 'approved')
    expect(pill.current()).toEqual({ ...first, reviewState: 'approved', lastUpdated: t0 + 4_000 })
  })

  test('a pull request that goes away empties the pill and stamps the change', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    sessionIn(repo)
    const t0 = freezeClock()

    const pill = await mountPill({ loading: false })
    await until('the first answer', () => pill.current().number !== null)

    forge.reply('gh', ghOpenPr({ state: 'MERGED' }))
    moveClockTo(t0 + 3_000)
    pill.rerender({ loading: true })
    await until('the pill to empty', () => pill.current().number === null)

    expect(pill.current()).toEqual({ ...EMPTY_PILL, lastUpdated: t0 + 3_000 })
  })
})

describe('when it asks', () => {
  test('at once on mount, then 2 s after each answer, and never after unmount', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    sessionIn(repo)

    const pill = await mountPill({ loading: false })
    const first = await forge.nthCall(1, 1_000)
    const second = await forge.nthCall(2, 3_500)
    const gap = second - first
    expect(gap).toBeGreaterThanOrEqual(1_990)
    expect(gap).toBeLessThanOrEqual(2_800)

    await forge.settled(2)
    pill.stop()
    await Bun.sleep(2_400)
    expect(forge.calls()).toHaveLength(2)
  }, 15_000)

  test('a re-run within 2 s of the last ask waits out the rest of the 2 s', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    sessionIn(repo)

    const pill = await mountPill({ loading: false })
    const firstAsk = await forge.nthCall(1, 1_000)
    await until('the first answer', () => pill.current().number !== null)

    await Bun.sleep(Math.max(0, firstAsk + 1_000 - performance.now()))
    const rerunAt = performance.now()
    pill.rerender({ loading: true })
    const secondAsk = await forge.nthCall(2, 2_500)

    expect(secondAsk - rerunAt).toBeGreaterThanOrEqual(700)
    expect(secondAsk - firstAsk).toBeGreaterThanOrEqual(1_900)
    expect(secondAsk - firstAsk).toBeLessThanOrEqual(2_600)
  }, 10_000)

  test('enabled=false never asks; enabling asks at once; disabling keeps the last state', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    sessionIn(repo)
    const t0 = freezeClock()

    const pill = await mountPill({ loading: false, enabled: false })
    await Bun.sleep(400)
    expect(forge.calls()).toEqual([])
    expect(pill.current()).toEqual(EMPTY_PILL)

    pill.rerender({ loading: false, enabled: true })
    await until('the pill to fill in', () => pill.current().number === 42)

    moveClockTo(t0 + 5_000)
    pill.rerender({ loading: false, enabled: false })
    pill.rerender({ loading: true, enabled: false })
    await Bun.sleep(400)
    expect(forge.calls()).toHaveLength(1)
    expect(pill.current().number).toBe(42)
  }, 10_000)

  test('after an hour with no interaction it stops; a re-run starts it again', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    sessionIn(repo)
    const t0 = freezeClock()
    const hour = 60 * 60_000

    const pill = await mountPill({ loading: false })
    // The clock moves only once an answer is in: moved mid-ask, it would make
    // that ask look an hour long, which is the slow-answer rule instead.
    await until('the first answer', () => pill.current().number !== null)

    moveClockTo(t0 + hour - 1)
    await forge.nthCall(2, 3_500)
    await forge.settled(2)

    moveClockTo(t0 + hour)
    await Bun.sleep(2_500)
    expect(forge.calls()).toHaveLength(2)

    moveClockTo(t0 + hour + 2_000)
    pill.rerender({ loading: true })
    await forge.nthCall(3, 1_000)
  }, 15_000)

  test('an interaction during the hour keeps it asking', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    sessionIn(repo)
    const t0 = freezeClock()

    const pill = await mountPill({ loading: false })
    await until('the first answer', () => pill.current().number !== null)

    moveClockTo(t0 + 2 * 60 * 60_000)
    updateLastInteractionTime(true)
    await forge.nthCall(2, 3_500)
  }, 10_000)

  test('an answer slower than 4 s is shown, and then it never asks again', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    forge.holdNextCall('gh')
    sessionIn(repo)

    const pill = await mountPill({ loading: false })
    await forge.nthCall(1, 1_000)
    await Bun.sleep(4_150)
    forge.release()
    await until('the slow answer', () => pill.current().number === 42)

    await Bun.sleep(2_400)
    expect(forge.calls()).toHaveLength(1)

    pill.rerender({ loading: true })
    await Bun.sleep(400)
    expect(forge.calls()).toHaveLength(1)
  }, 15_000)

  test('an answer that takes about 3 s does not stop it', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    forge.holdNextCall('gh')
    sessionIn(repo)

    const pill = await mountPill({ loading: false })
    await forge.nthCall(1, 1_000)
    await Bun.sleep(3_200)
    forge.release()
    await until('the answer', () => pill.current().number === 42)

    pill.rerender({ loading: true })
    await forge.nthCall(2, 1_000)
  }, 10_000)

  test('an answer from an ask that a re-run superseded is dropped', async () => {
    const repo = checkout('https://github.com/acme/widgets.git')
    forge.reply('gh', ghOpenPr())
    forge.holdNextCall('gh')
    sessionIn(repo)

    const pill = await mountPill({ loading: false })
    await forge.nthCall(1, 1_000)

    forge.reply('gh', ghOpenPr({ number: 43, url: 'https://github.com/acme/widgets/pull/43' }))
    pill.rerender({ loading: true })
    await until('the newer answer', () => pill.current().number === 43)

    forge.release()
    await forge.settled(2)
    expect(forge.calls()).toHaveLength(2)
    expect(pill.current().number).toBe(43)
  }, 10_000)
})
