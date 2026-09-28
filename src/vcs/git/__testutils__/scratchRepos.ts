/**
 * Real git repositories in throwaway directories, for the vcs characterization
 * suites.
 *
 * Every git process started here sees none of the user's setup: the global and
 * system configuration files are switched off, HOME points into a temp
 * directory, and any GIT_* variable inherited from the caller (a hook sets
 * GIT_DIR, for one) is dropped. Authorship is fixed so commits never prompt.
 * Each new repository gets a unique first file, so two of them never share a
 * commit id by accident.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

export type GitOutcome = {
  ok: boolean
  /** git's exit status: 1 is "not found" for git config --get, 128 a fatal error. */
  code: number
  /** Standard output, minus the single newline git ends it with. */
  stdout: string
  stderr: string
}

function environmentFor(home: string): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && !name.startsWith('GIT_'),
  ) as Array<[string, string]>
  return {
    ...Object.fromEntries(inherited),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Scratch Author',
    GIT_AUTHOR_EMAIL: 'author@scratch.invalid',
    GIT_COMMITTER_NAME: 'Scratch Author',
    GIT_COMMITTER_EMAIL: 'author@scratch.invalid',
  }
}

export class ScratchGit {
  private readonly created: string[] = []
  private readonly environment: Record<string, string>
  private serial = 0

  constructor() {
    this.environment = environmentFor(this.tempDir('home'))
  }

  /** A fresh directory with no symlink in its path. cleanup() removes it. */
  tempDir(label: string): string {
    const made = realpathSync(mkdtempSync(join(tmpdir(), `vcs-char-${label}-`)))
    this.created.push(made)
    return made
  }

  attempt(cwd: string, ...args: string[]): GitOutcome {
    const child = Bun.spawnSync(['git', ...args], {
      cwd,
      env: this.environment,
      stdin: 'ignore',
    })
    return {
      ok: child.exitCode === 0,
      code: child.exitCode ?? -1,
      stdout: child.stdout.toString().replace(/\n$/, ''),
      stderr: child.stderr.toString(),
    }
  }

  /** Runs git and throws with its stderr when it fails. */
  run(cwd: string, ...args: string[]): string {
    const outcome = this.attempt(cwd, ...args)
    if (!outcome.ok) {
      throw new Error(`git ${args.join(' ')} (in ${cwd}) failed:\n${outcome.stderr}`)
    }
    return outcome.stdout
  }

  /** Writes `text` at `relativePath` under `root`, creating directories. */
  put(root: string, relativePath: string, text: string): string {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    return target
  }

  /** A repository on `branch` holding one commit. Extra args go to git init. */
  repo(label: string, branch = 'main', ...initArgs: string[]): string {
    const root = this.tempDir(label)
    this.run(root, 'init', '-q', '-b', branch, ...initArgs)
    this.commit(root, `start ${label}`)
    return root
  }

  /** Changes a tracked file, commits it, and returns the new HEAD id. */
  commit(worktree: string, message: string): string {
    this.serial += 1
    this.put(worktree, 'notes.txt', `${message} #${this.serial} ${worktree}\n`)
    this.run(worktree, 'add', 'notes.txt')
    this.run(worktree, 'commit', '-q', '-m', message)
    return this.run(worktree, 'rev-parse', 'HEAD')
  }

  cleanup(): void {
    for (const dir of this.created.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
