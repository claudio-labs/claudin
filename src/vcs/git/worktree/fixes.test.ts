/**
 * The "fix" decisions of docs/tech/rewrite/vcs/worktree.md (Findings), each
 * pinned against real repositories, and tmux where it takes one. The
 * characterization suites pin everything kept for parity.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

import { getCurrentProjectConfig } from 'src/platform/config/config.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import {
  IN_PROCESS_TMUX_IS_PRIVATE,
  openTmuxLab,
  TMUX_ON_PATH,
  type TmuxLab,
} from 'src/vcs/git/__testutils__/tmuxLab.js'
import { openWorktreeLab, type WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'
import {
  attachExistingWorktree,
  copyWorktreeIncludeFiles,
  createAgentWorktree,
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  execIntoTmuxWorktree,
  getCurrentWorktreeSession,
  getTmuxInstallInstructions,
  killTmuxSession,
} from 'src/vcs/git/worktree.js'

let lab: WorktreeLab

beforeEach(() => {
  lab = openWorktreeLab()
})

afterEach(() => {
  lab.close()
})

async function rejection(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
  } catch (error) {
    return (error as Error).message
  }
  return 'no rejection'
}

function hooksPathOf(repo: string): string | null {
  const outcome = lab.git.attempt(repo, 'config', '--get', 'core.hooksPath')
  return outcome.ok ? outcome.stdout : null
}

describe('F1: the session is not written to the project config', () => {
  test('creating and attaching leave activeWorktreeSession unset', async () => {
    const { clone } = lab.upstream('f1')
    await lab.inSession(clone, () => createWorktreeForSession('s-f1', 'f1'))
    expect(lab.inSession(clone, () => getCurrentProjectConfig().activeWorktreeSession)).toBeUndefined()
  })
})

describe('F7: the session wrapper creates in the main repository', () => {
  test('from inside a linked worktree, the new worktree lands under the main checkout', async () => {
    const { clone } = lab.upstream('f7')
    const linked = join(lab.git.tempDir('f7-linked'), 'side')
    lab.git.run(clone, 'worktree', 'add', '-q', '-b', 'side', linked)
    const session = await lab.inSession(linked, () => createWorktreeForSession('s-f7', 'nested'))
    expect(session.worktreePath).toBe(join(clone, '.claudin', 'worktrees', 'nested'))
    expect(session.originalCwd).toBe(linked)
    expect(session.originalBranch).toBe('side')
  })
})

describe('F9: attaching refuses a registered worktree whose directory is gone', () => {
  test('it is refused like an unregistered path, and nothing is published', async () => {
    const { clone } = lab.upstream('f9')
    const gone = join(lab.git.tempDir('f9-linked'), 'gone')
    lab.git.run(clone, 'worktree', 'add', '-q', '-b', 'gone', gone)
    rmSync(gone, { recursive: true, force: true })
    const message = await rejection(() => lab.inSession(clone, () => attachExistingWorktree(gone, 's-f9')))
    expect(message.startsWith(gone)).toBe(true)
    expect(message).toContain('not a registered worktree')
    expect(getCurrentWorktreeSession()).toBeNull()
  })
})

describe('F12: names git would quote are copied', () => {
  test('non-ASCII and quote characters in ignored file names', async () => {
    const repo = lab.git.repo('f12')
    lab.git.put(repo, '.gitignore', '*.key\n')
    lab.git.run(repo, 'add', '.gitignore')
    lab.git.run(repo, 'commit', '-q', '-m', 'ignore keys')
    const names = ['caf\u00e9.key', 'say "hi".key', 'plain.key']
    for (const name of names) lab.git.put(repo, name, `contents of ${name}\n`)
    lab.git.put(repo, '.worktreeinclude', '*.key\n')
    const tree = join(lab.git.tempDir('f12-wt'), 'tree')
    lab.git.run(repo, 'worktree', 'add', '-q', '-b', 'f12-side', tree)
    const copied = await copyWorktreeIncludeFiles(repo, tree)
    expect([...copied].sort()).toEqual([...names].sort())
    for (const name of names) expect(readFileSync(join(tree, name), 'utf8')).toBe(`contents of ${name}\n`)
  })
})

describe('F14: a hooks path already set is kept', () => {
  const cases: Array<[string, (repo: string) => string, (repo: string) => string]> = [
    ['a relative directory is made absolute against the main checkout', () => '.githooks', repo => join(repo, '.githooks')],
    ['husky 9 keeps its .husky/_', () => '.husky/_', repo => join(repo, '.husky', '_')],
    ['an absolute directory is left as it is', repo => join(repo, 'elsewhere'), repo => join(repo, 'elsewhere')],
  ]
  for (const [index, [label, configured, expected]] of cases.entries()) {
    test(label, async () => {
      const repo = lab.git.repo(`f14-${index}`)
      mkdirSync(join(repo, '.husky', '_'), { recursive: true })
      mkdirSync(join(repo, '.githooks'))
      lab.git.run(repo, 'config', 'core.hooksPath', configured(repo))
      const made = await lab.inSession(repo, () => createAgentWorktree('hooked'))
      expect(hooksPathOf(repo)).toBe(expected(repo))
      expect(hooksPathOf(made.worktreePath)).toBe(expected(repo))
    })
  }
})

describe('F5 and F6: the fast path asks the tmux on the current PATH, and hints like everyone else', () => {
  afterEach(() => {
    getPlatform.cache.clear?.()
  })

  test('a PATH changed after start hides tmux from the fast path', async () => {
    getPlatform.cache.clear?.()
    const { clone } = lab.upstream('f5')
    lab.env.set('PATH', lab.git.tempDir('no-tools'))
    const answer = await lab.inSession(clone, () => execIntoTmuxWorktree(['-w', 'x', '--tmux']))
    expect(answer).toEqual({
      handled: false,
      error: `Error: tmux is not installed. ${getTmuxInstallInstructions()}`,
    })
  })
})

describe.skipIf(!TMUX_ON_PATH)('F2: tmux targets match exactly', () => {
  let tmuxLab: TmuxLab
  beforeEach(() => {
    tmuxLab = openTmuxLab(lab)
  })
  afterEach(() => {
    tmuxLab.close()
  })

  test('killing a missing name never ends a session it prefixes', async () => {
    const place = lab.git.tempDir('f2')
    expect(await createTmuxSessionForWorktree('repo_worktree-ab', place)).toEqual({ created: true })
    expect(await killTmuxSession('repo_worktree-a')).toBe(false)
    expect(tmuxLab.sessions()).toEqual(['keeper', 'repo_worktree-ab'])
  })

  test.skipIf(!IN_PROCESS_TMUX_IS_PRIVATE)(
    'inside tmux, a session whose name only prefixes another is still created',
    async () => {
      const { clone } = lab.upstream('f2-fast')
      const recorder = tmuxLab.recorder('f2')
      lab.env.set('TMUX', tmuxLab.insideValue())
      const place = lab.git.tempDir('f2-other')
      await createTmuxSessionForWorktree('repo_worktree-ab', place)
      const spy = spyOn(console, 'log').mockImplementation(() => {})
      const realProgram = process.execPath
      process.execPath = recorder.program
      try {
        expect(await lab.inSession(clone, () => execIntoTmuxWorktree(['-w', 'a', '--tmux']))).toEqual({ handled: true })
        const recording = await recorder.waitForRecording()
        expect(recording.session).toBe('repo_worktree-a')
        // F3: the runtime gets its script back before the forwarded arguments.
        expect(recording.args).toEqual(process.argv[1] ? [process.argv[1]] : [])
        expect(tmuxLab.sessions()).toEqual(['keeper', 'repo_worktree-a', 'repo_worktree-ab'])
      } finally {
        process.execPath = realProgram
        spy.mockRestore()
        recorder.release()
      }
    },
  )
})
