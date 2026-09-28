/**
 * Characterization of the tmux side of worktrees, pinned for the clean-base
 * rewrite (docs/tech/rewrite/vcs/worktree.md): session names, install hints,
 * the small session helpers, and the `--worktree --tmux` fast path.
 *
 * tmux runs for real, on a private server per test (see tmuxLab.ts), and the
 * tests that need it are skipped when tmux is not on PATH. The fast path is
 * made to launch a recorder instead of the CLI by pointing `process.execPath`
 * at it, so what tmux ran, where, and under which session name is read back
 * from the recorder.
 *
 * Three of the fast path's tmux calls inherit the environment the process
 * started with (tmuxLab.ts explains why), so anything that depends on them,
 * `has-session`, `switch-client` and the attaching branch, is driven in a
 * fresh process whose startup environment points at the private server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { basename, join } from 'path'

import { getPlatform } from 'src/shared/proc/platform.js'
import {
  IN_PROCESS_TMUX_IS_PRIVATE,
  openTmuxLab,
  TMUX_ON_PATH,
  waitUntil,
  type ClientView,
  type Recorder,
  type TmuxLab,
} from 'src/vcs/git/__testutils__/tmuxLab.js'
import {
  openWorktreeLab,
  recordingHook,
  registeredWorktrees,
  type WorktreeLab,
} from 'src/vcs/git/__testutils__/worktreeLab.js'
import {
  createAgentWorktree,
  createTmuxSessionForWorktree,
  execIntoTmuxWorktree,
  generateTmuxSessionName,
  getTmuxInstallInstructions,
  isTmuxAvailable,
  killTmuxSession,
} from 'src/vcs/git/worktree.js'

const worktreesOf = (root: string): string => join(root, '.claudin', 'worktrees')

function closeBoth(tmuxLab: TmuxLab | null, lab: WorktreeLab): void {
  try {
    tmuxLab?.close()
  } finally {
    lab.close()
  }
}

describe('generateTmuxSessionName', () => {
  const names: Array<[string, string, string]> = [
    ['/home/dev/src/shop', 'main', 'shop_main'],
    ['/home/dev/src/shop/', 'main', 'shop_main'],
    ['shop', 'worktree-login', 'shop_worktree-login'],
    ['/srv/web.app', 'worktree-v2.1', 'web_app_worktree-v2_1'],
    ['/srv/api', 'feature/deep/path', 'api_feature_deep_path'],
    ['/srv/api', 'worktree-team+api', 'api_worktree-team+api'],
    ['/srv/my repo', 'x:y', 'my repo_x:y'],
    ['/', 'main', '_main'],
  ]
  for (const [repo, branch, expected] of names) {
    test(`${repo} + ${branch} -> ${expected}`, () => {
      expect(generateTmuxSessionName(repo, branch)).toBe(expected)
    })
  }
})

describe('getTmuxInstallInstructions', () => {
  afterEach(() => {
    getPlatform.cache.clear?.()
  })

  const hints: Array<[string, string[], string[]]> = [
    ['macos', ['brew install tmux'], ['apt', 'Windows']],
    ['linux', ['sudo apt install tmux', 'sudo dnf install tmux', 'Debian/Ubuntu', 'Fedora/RHEL'], ['brew']],
    ['wsl', ['sudo apt install tmux', 'sudo dnf install tmux'], ['brew']],
    ['windows', ['not natively available on Windows', 'WSL', 'Cygwin'], ['install tmux']],
    ['unknown', ['package manager'], ['brew', 'apt', 'dnf']],
  ]
  for (const [platform, present, absent] of hints) {
    test(platform, () => {
      getPlatform.cache.set(undefined, platform)
      const hint = getTmuxInstallInstructions()
      for (const fact of present) expect(hint).toContain(fact)
      for (const fact of absent) expect(hint).not.toContain(fact)
    })
  }
})

describe.skipIf(!TMUX_ON_PATH)('the session helpers', () => {
  let lab: WorktreeLab
  let tmuxLab: TmuxLab
  beforeEach(() => {
    lab = openWorktreeLab()
    tmuxLab = openTmuxLab(lab)
  })
  afterEach(() => {
    closeBoth(tmuxLab, lab)
  })

  test('isTmuxAvailable asks the tmux on PATH', async () => {
    expect(await isTmuxAvailable()).toBe(true)
    const path = process.env.PATH
    lab.env.set('PATH', lab.git.tempDir('no-tools'))
    try {
      expect(await isTmuxAvailable()).toBe(false)
    } finally {
      lab.env.set('PATH', path)
    }
  })

  test('createTmuxSessionForWorktree starts a detached session in the worktree', async () => {
    const place = lab.git.tempDir('place')
    expect(await createTmuxSessionForWorktree('shop_worktree-a', place)).toEqual({ created: true })
    expect(tmuxLab.sessions()).toEqual(['keeper', 'shop_worktree-a'])
    const shown = tmuxLab.tmux('display-message', '-p', '-t', '=shop_worktree-a:', '#{pane_current_path}\t#{session_attached}')
    expect(shown.stdout).toBe(`${place}\t0`)
  })

  test("createTmuxSessionForWorktree reports a name already taken, with tmux's words", async () => {
    const place = lab.git.tempDir('place')
    await createTmuxSessionForWorktree('shop_worktree-b', place)
    const again = await createTmuxSessionForWorktree('shop_worktree-b', place)
    expect(again.created).toBe(false)
    expect(again.error).toContain('duplicate session')
    expect(tmuxLab.sessions()).toEqual(['keeper', 'shop_worktree-b'])
  })

  test('killTmuxSession ends a session and reports whether one was there', async () => {
    const place = lab.git.tempDir('place')
    await createTmuxSessionForWorktree('shop_worktree-c', place)
    expect(await killTmuxSession('shop_worktree-c')).toBe(true)
    expect(tmuxLab.sessions()).toEqual(['keeper'])
    expect(await killTmuxSession('shop_worktree-c')).toBe(false)
  })
})

describe('execIntoTmuxWorktree refusals', () => {
  let lab: WorktreeLab
  let tmuxLab: TmuxLab | null = null
  beforeEach(() => {
    lab = openWorktreeLab()
    if (TMUX_ON_PATH) tmuxLab = openTmuxLab(lab)
  })
  afterEach(() => {
    closeBoth(tmuxLab, lab)
    tmuxLab = null
  })

  test('on Windows, before looking at anything else', async () => {
    const { clone } = lab.upstream('win')
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    let outcome: { handled: boolean; error?: string }
    try {
      outcome = await lab.inSession(clone, () => execIntoTmuxWorktree(['--worktree', 'bad name', '--tmux']))
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
    expect(outcome.handled).toBe(false)
    expect(outcome.error).toStartWith('Error: ')
    expect(outcome.error).toContain('--tmux')
    expect(outcome.error).toContain('Windows')
  })

  describe.skipIf(!TMUX_ON_PATH)('once tmux is there', () => {
    type Refusal = [label: string, args: string[], where: 'clone' | 'anchor', facts: string[]]
    const refusals: Refusal[] = [
      ['an invalid name', ['-w', 'two words', '--tmux'], 'clone', ['"two words"']],
      ['a name that climbs out', ['--worktree=../up', '--tmux'], 'clone', ['"../up"']],
      ['no git repository and no hook', ['--worktree', 'x', '--tmux'], 'anchor', ['--worktree', 'git repository']],
      ['a pull request origin does not have', ['--worktree', '#12', '--tmux'], 'clone', ['Failed to fetch PR #12']],
    ]
    for (const [label, args, where, facts] of refusals) {
      test(label, async () => {
        const { clone } = lab.upstream('refuse')
        const cwd = where === 'clone' ? clone : lab.anchor
        const outcome = await lab.inSession(cwd, () => execIntoTmuxWorktree(args))
        expect(outcome.handled).toBe(false)
        expect(outcome.error).toStartWith('Error: ')
        for (const fact of facts) expect(outcome.error).toContain(fact)
        expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
        expect(tmuxLab?.sessions()).toEqual(['keeper'])
      })
    }

    test('a failing WorktreeCreate hook', async () => {
      const { clone } = lab.upstream('hookfail')
      lab.writeSettings({
        hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: 'exit 4' }] }] },
      })
      const outcome = await lab.inSession(clone, () => execIntoTmuxWorktree(['-w', 'h', '--tmux']))
      expect(outcome.handled).toBe(false)
      expect(outcome.error).toStartWith('Error: ')
      expect(outcome.error).toContain('WorktreeCreate hook failed')
      expect(tmuxLab?.sessions()).toEqual(['keeper'])
    })
  })
})

describe.skipIf(!TMUX_ON_PATH)('execIntoTmuxWorktree without tmux on PATH', () => {
  let lab: WorktreeLab
  let tmuxLab: TmuxLab
  let answers: Record<string, { handled: boolean; error?: string }>

  beforeAll(async () => {
    lab = openWorktreeLab()
    tmuxLab = openTmuxLab(lab)
    const result = await tmuxLab.runDriver({
      cwd: lab.anchor,
      program: '/nonexistent/cli',
      inPane: false,
      env: { PATH: lab.git.tempDir('no-tools'), TMUX: null },
      body: [
        'const answers: Record<string, unknown> = {}',
        "for (const platform of ['linux', 'darwin']) {",
        "  const original = Object.getOwnPropertyDescriptor(process, 'platform')",
        "  Object.defineProperty(process, 'platform', { value: platform, configurable: true })",
        '  try {',
        "    answers[platform] = await unit.execIntoTmuxWorktree(['--worktree', 'bad name', '--tmux'])",
        '  } finally {',
        "    if (original) Object.defineProperty(process, 'platform', original)",
        '  }',
        '}',
        'return answers',
      ].join('\n'),
    })
    answers = result.outcome as typeof answers
  }, 60_000)

  afterAll(() => {
    closeBoth(tmuxLab, lab)
  })

  const hints: Array<[string, string]> = [
    ['linux', 'sudo apt install tmux'],
    ['darwin', 'brew install tmux'],
  ]
  for (const [platform, hint] of hints) {
    test(`says so before judging the name, with an install hint (${platform})`, () => {
      const answer = answers[platform]
      expect(answer?.handled).toBe(false)
      expect(answer?.error).toStartWith('Error: tmux is not installed.')
      expect(answer?.error).toContain(hint)
    })
  }
})

describe.skipIf(!IN_PROCESS_TMUX_IS_PRIVATE)('execIntoTmuxWorktree inside tmux, in this process', () => {
  let lab: WorktreeLab
  let tmuxLab: TmuxLab
  let recorder: Recorder
  let logs: string[]

  beforeEach(() => {
    lab = openWorktreeLab()
    tmuxLab = openTmuxLab(lab)
    recorder = tmuxLab.recorder('inside')
    lab.env.set('TMUX', tmuxLab.insideValue())
    logs = []
  })

  afterEach(() => {
    recorder.release()
    closeBoth(tmuxLab, lab)
  })

  async function fastPath(cwd: string, args: string[]): Promise<{ handled: boolean; error?: string }> {
    const spy = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(' '))
    })
    const realProgram = process.execPath
    process.execPath = recorder.program
    try {
      return await lab.inSession(cwd, () => execIntoTmuxWorktree(args))
    } finally {
      process.execPath = realProgram
      spy.mockRestore()
    }
  }

  test('creates the worktree and launches the CLI there, in a new detached session', async () => {
    const { clone } = lab.upstream('inside')
    const outcome = await fastPath(clone, [
      'first',
      '--worktree',
      'feat/v1.2',
      '--tmux',
      '',
      '--model',
      'opus',
      '-w',
      '--tmux=classic',
      'last',
    ])
    expect(outcome).toEqual({ handled: true })
    const tree = join(worktreesOf(clone), 'feat+v1.2')
    const recording = await recorder.waitForRecording()
    expect(recording.cwd).toBe(tree)
    expect(recording.session).toBe('repo_worktree-feat+v1_2')
    expect(recording.args.slice(-4)).toEqual(['first', '--model', 'opus', 'last'])
    for (const dropped of ['--worktree', 'feat/v1.2', '--tmux', '-w', '--tmux=classic', '']) {
      expect(recording.args).not.toContain(dropped)
    }
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone, tree])
    expect(lab.git.run(clone, 'config', '--get', 'core.hooksPath')).toBe(join(clone, '.git', 'hooks'))
    expect(tmuxLab.tmux('display-message', '-p', '-t', '=repo_worktree-feat+v1_2:', '#{session_attached}').stdout).toBe('0')
    const created = logs.filter(line => line.includes(tree))
    expect(created).toHaveLength(1)
    expect(created[0]).toContain('origin/main')
  })

  test('the --worktree=<name> form', async () => {
    const { clone } = lab.upstream('equals')
    await fastPath(clone, ['--worktree=eq-form', '--tmux'])
    const recording = await recorder.waitForRecording()
    expect(recording.cwd).toBe(join(worktreesOf(clone), 'eq-form'))
    expect(recording.session).toBe('repo_worktree-eq-form')
    expect(recording.args).not.toContain('--worktree=eq-form')
  })

  test('a pull request reference becomes pr-<n>, based on the fetched pull request', async () => {
    const { origin, clone } = lab.upstream('pull')
    const holder = lab.git.tempDir('contributor')
    lab.git.run(holder, 'clone', '-q', origin, 'work')
    const proposed = lab.git.commit(join(holder, 'work'), 'proposal')
    lab.git.run(join(holder, 'work'), 'push', '-q', 'origin', 'HEAD:refs/pull/31/head')
    await fastPath(clone, ['--worktree', 'https://github.com/acme/widgets/pull/31', '--tmux'])
    const recording = await recorder.waitForRecording()
    const tree = join(worktreesOf(clone), 'pr-31')
    expect(recording.cwd).toBe(tree)
    expect(recording.session).toBe('repo_worktree-pr-31')
    expect(lab.git.run(tree, 'rev-parse', 'HEAD')).toBe(proposed)
    expect(logs.find(line => line.includes(tree))).toContain('FETCH_HEAD')
  })

  test('without a name, one is made up from a fixed vocabulary', async () => {
    const { clone } = lab.upstream('unnamed')
    await fastPath(clone, ['--tmux', '--worktree'])
    const recording = await recorder.waitForRecording()
    const made = /^repo_worktree-((?:swift|bright|calm|keen|bold)-(?:fox|owl|elm|oak|ray)-[0-9a-z]{0,4})$/.exec(
      recording.session,
    )
    expect(made).not.toBeNull()
    expect(recording.cwd).toBe(join(worktreesOf(clone), made?.[1] ?? ''))
  })

  test('from a linked worktree, the new worktree goes to the main repository', async () => {
    const { clone } = lab.upstream('canonical')
    const linked = join(lab.git.tempDir('linked'), 'side')
    lab.git.run(clone, 'worktree', 'add', '-q', '-b', 'side', linked)
    await fastPath(linked, ['-w', 'from-side', '--tmux'])
    const recording = await recorder.waitForRecording()
    expect(recording.cwd).toBe(join(worktreesOf(clone), 'from-side'))
    expect(recording.session).toBe('repo_worktree-from-side')
  })

  test('an existing worktree is reused without a word and without setup', async () => {
    const { clone } = lab.upstream('reuse')
    const made = await lab.inSession(clone, () => createAgentWorktree('again'))
    lab.git.run(clone, 'config', '--unset', 'core.hooksPath')
    await fastPath(clone, ['-w', 'again', '--tmux'])
    const recording = await recorder.waitForRecording()
    expect(recording.cwd).toBe(made.worktreePath)
    expect(logs).toEqual([])
    expect(lab.git.attempt(clone, 'config', '--get', 'core.hooksPath').ok).toBe(false)
  })

  test('with a WorktreeCreate hook, the hook makes the directory and git is not used', async () => {
    const { clone } = lab.upstream('hooked')
    const place = join(lab.git.tempDir('hook-place'), 'made-by-hook')
    const record = join(lab.git.tempDir('hook-record'), 'create.json')
    lab.writeSettings({ hooks: { WorktreeCreate: [{ hooks: [recordingHook(record, place)] }] } })
    await fastPath(clone, ['-w', 'hooked', '--tmux'])
    const recording = await recorder.waitForRecording()
    expect(recording.cwd).toBe(place)
    expect(recording.session).toBe('repo_worktree-hooked')
    expect(registeredWorktrees(lab.git, clone)).toEqual([clone])
    expect(logs.filter(line => line.includes(place))).toHaveLength(1)
  })

  test('with a hook outside git, the session is named after the working directory', async () => {
    const place = join(lab.git.tempDir('hook-place'), 'made-by-hook')
    const record = join(lab.git.tempDir('hook-record'), 'create.json')
    lab.writeSettings({ hooks: { WorktreeCreate: [{ hooks: [recordingHook(record, place)] }] } })
    await fastPath(lab.anchor, ['-w', 'nogit', '--tmux'])
    const recording = await recorder.waitForRecording()
    expect(recording.session).toBe(`${basename(lab.anchor)}_worktree-nogit`)
  })
})

describe.skipIf(!TMUX_ON_PATH)('execIntoTmuxWorktree inside tmux, in a process of its own', () => {
  let lab: WorktreeLab
  let tmuxLab: TmuxLab
  let clone: string
  type Observed = { launched: boolean; clients: ClientView[]; outcome: unknown; logs: string[] }
  const observed = new Map<string, Observed>()

  /** A driver started inside the lab's server, with a viewer for it to switch. */
  async function insideDriver(name: string, preexisting: boolean): Promise<Observed> {
    const session = `repo_worktree-${name}`
    const launched = tmuxLab.recorder(`${name}-launched`)
    const waiting = tmuxLab.recorder(`${name}-waiting`)
    try {
      if (preexisting) {
        await lab.inSession(clone, () => createAgentWorktree(name))
        tmuxLab.tmux('new-session', '-d', '-s', session, '--', waiting.program)
        await waiting.waitForRecording()
      }
      await tmuxLab.attachViewer()
      const result = await tmuxLab.runDriver({
        cwd: clone,
        program: launched.program,
        inPane: false,
        env: { TMUX: tmuxLab.insideValue(), TMUX_TMPDIR: tmuxLab.dir },
        body: `return unit.execIntoTmuxWorktree(['-w', ${JSON.stringify(name)}, '--tmux'])`,
      })
      const clients = await waitUntil(
        tmuxLab.clients,
        all => all.some(c => c.session === session),
        `the viewer to be switched to ${session}`,
      )
      if (!preexisting) await launched.waitForRecording()
      return {
        launched: launched.recording() !== null,
        clients: clients.filter(c => c.session === session),
        outcome: result.outcome,
        logs: result.logs,
      }
    } finally {
      launched.release()
      waiting.release()
    }
  }

  beforeAll(async () => {
    lab = openWorktreeLab()
    tmuxLab = openTmuxLab(lab)
    clone = lab.upstream('switch').clone
    observed.set('fresh', await insideDriver('fresh', false))
    observed.set('joined', await insideDriver('joined', true))
  }, 90_000)

  afterAll(() => {
    closeBoth(tmuxLab, lab)
  })

  test('the client it runs under is switched to the new session', () => {
    const seen = observed.get('fresh')
    expect(seen?.outcome).toEqual({ handled: true })
    expect(seen?.launched).toBe(true)
    expect(seen?.clients).toEqual([{ session: 'repo_worktree-fresh', control: false }])
  })

  test('an existing session of that name is switched to, and nothing new is launched', () => {
    const seen = observed.get('joined')
    expect(seen?.outcome).toEqual({ handled: true })
    expect(seen?.launched).toBe(false)
    expect(seen?.clients).toEqual([{ session: 'repo_worktree-joined', control: false }])
    expect(seen?.logs).toEqual([])
  })
})

describe.skipIf(!TMUX_ON_PATH)('execIntoTmuxWorktree attaching from a plain terminal', () => {
  let lab: WorktreeLab
  let tmuxLab: TmuxLab
  let clone: string

  type Scenario = { name: string; args: string[]; iTerm: boolean; preexisting: boolean }
  type Observed = {
    recording: ReturnType<Recorder['recording']>
    clients: ClientView[]
    outcome: unknown
    logs: string[]
  }
  const scenarios: Scenario[] = [
    { name: 'plain', args: ['--worktree', 'plain', '--tmux', 'tail'], iTerm: false, preexisting: false },
    { name: 'iterm-new', args: ['--worktree', 'iterm-new', '--tmux'], iTerm: true, preexisting: false },
    { name: 'iterm-old', args: ['--worktree', 'iterm-old', '--tmux'], iTerm: true, preexisting: true },
    { name: 'classic-old', args: ['--worktree', 'classic-old', '--tmux=classic'], iTerm: true, preexisting: true },
  ]
  const observed = new Map<string, Observed>()

  beforeAll(async () => {
    lab = openWorktreeLab()
    tmuxLab = openTmuxLab(lab)
    clone = lab.upstream('attach').clone
    await Promise.all(
      scenarios.map(async scenario => {
        const session = `repo_worktree-${scenario.name}`
        const launched = tmuxLab.recorder(`${scenario.name}-launched`)
        const waiting = tmuxLab.recorder(`${scenario.name}-waiting`)
        try {
          if (scenario.preexisting) {
            tmuxLab.tmux('new-session', '-d', '-s', session, '--', waiting.program)
            await waiting.waitForRecording()
          }
          const pending = tmuxLab.runDriver({
            cwd: clone,
            program: launched.program,
            inPane: true,
            body: `return unit.execIntoTmuxWorktree(${JSON.stringify(scenario.args)})`,
            env: {
              TMUX: null,
              TMUX_PANE: null,
              ITERM_SESSION_ID: null,
              LC_TERMINAL: null,
              TERM_PROGRAM: scenario.iTerm ? 'iTerm.app' : null,
              TMUX_TMPDIR: tmuxLab.dir,
            },
          })
          const clients = await waitUntil(
            tmuxLab.clients,
            all => all.some(c => c.session === session),
            `the ${scenario.name} driver to attach`,
            40_000,
          )
          const recording = scenario.preexisting ? launched.recording() : await launched.waitForRecording()
          launched.release()
          waiting.release()
          const result = await pending
          observed.set(scenario.name, {
            recording,
            clients: clients.filter(c => c.session === session),
            outcome: result.outcome,
            logs: result.logs,
          })
        } finally {
          launched.release()
          waiting.release()
        }
      }),
    )
  }, 120_000)

  afterAll(() => {
    closeBoth(tmuxLab, lab)
  })

  const tipLines = (logs: string[]) => logs.filter(line => line.includes('iTerm2'))

  test('a new session is created in the worktree and attached to, as an ordinary client', () => {
    const seen = observed.get('plain')
    expect(seen?.outcome).toEqual({ handled: true })
    expect(seen?.recording?.cwd).toBe(join(worktreesOf(clone), 'plain'))
    expect(seen?.recording?.session).toBe('repo_worktree-plain')
    expect(seen?.recording?.args.slice(-1)).toEqual(['tail'])
    expect(seen?.clients).toEqual([{ session: 'repo_worktree-plain', control: false }])
    expect(tipLines(seen?.logs ?? [])).toEqual([])
  })

  test('in iTerm2 the client uses control mode, and a new session comes with a tip', () => {
    const seen = observed.get('iterm-new')
    expect(seen?.clients).toEqual([{ session: 'repo_worktree-iterm-new', control: true }])
    expect(seen?.recording?.session).toBe('repo_worktree-iterm-new')
    const tip = tipLines(seen?.logs ?? []).join('\n')
    for (const fact of ['iTerm2', 'tmux', 'Tabs in attaching window']) expect(tip).toContain(fact)
  })

  test('an existing session is attached to rather than started again, without a tip', () => {
    const seen = observed.get('iterm-old')
    expect(seen?.outcome).toEqual({ handled: true })
    expect(seen?.recording).toBeNull()
    expect(seen?.clients).toEqual([{ session: 'repo_worktree-iterm-old', control: true }])
    expect(tipLines(seen?.logs ?? [])).toEqual([])
  })

  test('--tmux=classic turns control mode off in iTerm2', () => {
    const seen = observed.get('classic-old')
    expect(seen?.clients).toEqual([{ session: 'repo_worktree-classic-old', control: false }])
    expect(tipLines(seen?.logs ?? [])).toEqual([])
  })
})
