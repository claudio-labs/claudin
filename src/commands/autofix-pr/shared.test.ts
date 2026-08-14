import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'

const realGit = { ...(await import('src/services/git/git.js')) }
const realExecFileNoThrow = { ...(await import('src/utils/proc/execFileNoThrow.js')) }

type MockGit = {
  isGit?: boolean
  branch?: string
  defaultBranch?: string
}

type MockGh = {
  authOk?: boolean
  prView?: {
    code?: number
    stdout?: string
    stderr?: string
  } | null
}

function setup({ git = {}, gh = {} }: { git?: MockGit; gh?: MockGh }) {
  mock.module('src/services/git/git.js', () => ({
    ...realGit,
    getIsGit: async () => git.isGit ?? true,
    getBranch: async () => git.branch ?? 'feature/x',
    getDefaultBranch: async () => git.defaultBranch ?? 'main',
  }))
  mock.module('src/utils/proc/execFileNoThrow.js', () => ({
    ...realExecFileNoThrow,
    execFileNoThrow: async (_cmd: string, args: string[]) => {
      const isAuth = args[0] === 'auth'
      if (isAuth) {
        return {
          stdout: gh.authOk === false ? '' : 'logged in',
          stderr: '',
          code: gh.authOk === false ? 1 : 0,
        }
      }
      // gh pr view ...
      const v = gh.prView
      if (v === undefined) {
        return {
          stdout: JSON.stringify({
            number: 42,
            url: 'https://x/pr/42',
            state: 'OPEN',
          }),
          stderr: '',
          code: 0,
        }
      }
      if (v === null) {
        return { stdout: '', stderr: 'no pull requests found', code: 1 }
      }
      return {
        stdout: v.stdout ?? '',
        stderr: v.stderr ?? '',
        code: v.code ?? 0,
      }
    },
  }))
}

async function importFreshShared() {
  return import(`./shared.ts?ts=${Date.now()}-${Math.random()}`)
}

afterAll(() => {
  mock.module('src/services/git/git.js', () => realGit)
  mock.module('src/utils/proc/execFileNoThrow.js', () => realExecFileNoThrow)
})

describe('assertAutofixPreconditions', () => {
  test('returns pr info when all checks pass', async () => {
    setup({})
    const { assertAutofixPreconditions } = await importFreshShared()
    const result = await assertAutofixPreconditions()
    expect(result).toEqual({
      prNumber: 42,
      prUrl: 'https://x/pr/42',
      branch: 'feature/x',
      defaultBranch: 'main',
    })
  })

  test('rejects when not in a git repo', async () => {
    setup({ git: { isGit: false } })
    const { assertAutofixPreconditions, AutofixPreconditionError } =
      await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toBeInstanceOf(
      AutofixPreconditionError,
    )
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'not inside a git repository.',
    )
  })

  test('rejects on detached HEAD', async () => {
    setup({ git: { branch: 'HEAD' } })
    const { assertAutofixPreconditions } = await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'cannot run in detached HEAD state. Check out a feature branch first.',
    )
  })

  test('rejects on default branch with exact UI message', async () => {
    setup({ git: { branch: 'main', defaultBranch: 'main' } })
    const { assertAutofixPreconditions } = await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'cannot run on the default branch (main). Check out a feature branch first.',
    )
  })

  test('rejects when gh CLI is not authenticated', async () => {
    setup({ gh: { authOk: false } })
    const { assertAutofixPreconditions } = await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'gh CLI is not authenticated. Run `gh auth login` first.',
    )
  })

  test('rejects when no open PR exists', async () => {
    setup({ gh: { prView: null } })
    const { assertAutofixPreconditions } = await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'no open PR found for this branch. Create one first via /commit-push-pr.',
    )
  })

  test('rejects when PR is merged', async () => {
    setup({
      gh: {
        prView: {
          code: 0,
          stdout: JSON.stringify({
            number: 7,
            url: 'https://x/pr/7',
            state: 'MERGED',
          }),
        },
      },
    })
    const { assertAutofixPreconditions } = await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'PR for this branch is already merged. Check out a new feature branch.',
    )
  })

  test('rejects when PR is closed', async () => {
    setup({
      gh: {
        prView: {
          code: 0,
          stdout: JSON.stringify({
            number: 8,
            url: 'https://x/pr/8',
            state: 'CLOSED',
          }),
        },
      },
    })
    const { assertAutofixPreconditions } = await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'PR for this branch is closed. Reopen it on GitHub or open a new PR.',
    )
  })

  test('rejects when gh returns invalid JSON', async () => {
    setup({
      gh: { prView: { code: 0, stdout: 'not json at all' } },
    })
    const { assertAutofixPreconditions } = await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'failed to query PR status via `gh pr view`. Check connectivity and try again.',
    )
  })

  test('rejects when gh returns JSON with missing fields', async () => {
    setup({
      gh: {
        prView: {
          code: 0,
          stdout: JSON.stringify({ url: 'https://x/pr/9' }),
        },
      },
    })
    const { assertAutofixPreconditions } = await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'failed to query PR status via `gh pr view`. Check connectivity and try again.',
    )
  })

  test('rejects on gh failure with generic error', async () => {
    setup({
      gh: {
        prView: { code: 1, stderr: 'network is unreachable' },
      },
    })
    const { assertAutofixPreconditions } = await importFreshShared()
    await expect(assertAutofixPreconditions()).rejects.toThrow(
      'failed to query PR status via `gh pr view`. Check connectivity and try again.',
    )
  })
})
