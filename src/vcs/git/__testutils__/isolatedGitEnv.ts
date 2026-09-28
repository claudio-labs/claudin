/**
 * For code under test that starts git itself, which reads process.env: HOME
 * becomes a throwaway directory, the global and system config files are
 * switched off, XDG_CONFIG_HOME and the variables that relocate a repository
 * or its config are dropped, and authorship is fixed. Every variable touched,
 * through `set` too, is put back by `restore`.
 */

const DROPPED = [
  'XDG_CONFIG_HOME',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
]

export type IsolatedGitEnv = {
  set(name: string, value: string | undefined): void
  restore(): void
}

export function isolateGitEnv(home: string): IsolatedGitEnv {
  const before = new Map<string, string | undefined>()
  const set = (name: string, value: string | undefined): void => {
    if (!before.has(name)) before.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  for (const name of DROPPED) set(name, undefined)
  const fixed: Record<string, string> = {
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Unit Fixture',
    GIT_AUTHOR_EMAIL: 'unit@fixture.invalid',
    GIT_COMMITTER_NAME: 'Unit Fixture',
    GIT_COMMITTER_EMAIL: 'unit@fixture.invalid',
  }
  for (const [name, value] of Object.entries(fixed)) set(name, value)
  return {
    set,
    restore: () => {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      before.clear()
    },
  }
}

/** Runs `action` with the process working directory at `dir`, then puts it back. */
export async function inProcessDir<T>(dir: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await action()
  } finally {
    process.chdir(previous)
  }
}
