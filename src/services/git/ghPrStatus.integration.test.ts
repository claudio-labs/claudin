import { afterAll, describe, expect, mock, test } from 'bun:test'

// Mock at the process/git/config boundary, restore in afterAll, and re-import
// the module fresh per test (?ts=...) to avoid mock.module cross-file leak.
const realGit = { ...(await import('src/services/git/git.js')) }
const realExec = { ...(await import('src/shared/proc/execFileNoThrow.js')) }
const realConfig = { ...(await import('src/platform/config/config.js')) }

type GitState = {
  isGit?: boolean
  branch?: string
  defaultBranch?: string
  remoteUrl?: string | null
}
type ExecResult = { stdout?: string; stderr?: string; code?: number }
type HostMap = Record<string, 'github' | 'gitlab' | 'gitea' | 'none'>

function setup(opts: {
  git?: GitState
  hosts?: HostMap
  exec?: (cmd: string, args: string[]) => ExecResult
}) {
  const git = opts.git ?? {}
  mock.module('./git.js', () => ({
    ...realGit,
    getIsGit: async () => git.isGit ?? true,
    getBranch: async () => git.branch ?? 'feature/x',
    getDefaultBranch: async () => git.defaultBranch ?? 'main',
    getRemoteUrl: async () =>
      git.remoteUrl === undefined ? 'git@github.com:o/r.git' : git.remoteUrl,
  }))
  // fetchPrStatus only reads getGlobalConfig().prStatusHosts.
  mock.module('src/platform/config/config.js', () => ({
    ...realConfig,
    getGlobalConfig: () => ({ prStatusHosts: opts.hosts }),
  }))
  mock.module('src/shared/proc/execFileNoThrow.js', () => ({
    ...realExec,
    execFileNoThrow: async (cmd: string, args: string[]) => {
      const r = opts.exec ? opts.exec(cmd, args) : {}
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code ?? 0 }
    },
  }))
}

async function importFresh() {
  return import(`./ghPrStatus.ts?ts=${Date.now()}-${Math.random()}`)
}

afterAll(() => {
  mock.module('./git.js', () => realGit)
  mock.module('src/platform/config/config.js', () => realConfig)
  mock.module('src/shared/proc/execFileNoThrow.js', () => realExec)
})

const GH_PR = JSON.stringify({
  number: 42,
  url: 'https://github.com/o/r/pull/42',
  reviewDecision: 'APPROVED',
  isDraft: false,
  headRefName: 'feature/x',
  state: 'OPEN',
})

describe('fetchPrStatus', () => {
  test('shows the pill when the CLI prints valid JSON but exits nonzero', async () => {
    // glab/tea (and gh) can exit nonzero on auth nags/warnings while emitting JSON.
    setup({ exec: () => ({ stdout: GH_PR, code: 1, stderr: 'warning: foo' }) })
    const { fetchPrStatus } = await importFresh()
    expect(await fetchPrStatus()).toEqual({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      reviewState: 'approved',
      label: 'PR',
    })
  })

  test('returns null when the CLI fails with empty stdout (stderr only)', async () => {
    setup({ exec: () => ({ stdout: '', code: 1, stderr: 'no pull requests found' }) })
    const { fetchPrStatus } = await importFresh()
    expect(await fetchPrStatus()).toBeNull()
  })

  test('returns null (no throw) when the CLI prints literal null', async () => {
    setup({ exec: () => ({ stdout: 'null', code: 0 }) })
    const { fetchPrStatus } = await importFresh()
    expect(await fetchPrStatus()).toBeNull()
  })

  test('falls back to gh when the remote is absent (non-origin remote)', async () => {
    const calls: string[] = []
    setup({
      git: { remoteUrl: null },
      exec: cmd => {
        calls.push(cmd)
        return { stdout: GH_PR, code: 0 }
      },
    })
    const { fetchPrStatus } = await importFresh()
    expect((await fetchPrStatus())?.number).toBe(42)
    expect(calls).toContain('gh')
  })

  test('falls back to gh when the remote is an unparseable SSH alias', async () => {
    const calls: string[] = []
    setup({
      git: { remoteUrl: 'git@github.com-work:o/r.git' },
      exec: cmd => {
        calls.push(cmd)
        return { stdout: GH_PR, code: 0 }
      },
    })
    const { fetchPrStatus } = await importFresh()
    expect((await fetchPrStatus())?.number).toBe(42)
    expect(calls).toContain('gh')
  })

  test('dispatches to glab on a gitlab remote and labels it MR', async () => {
    const MR = JSON.stringify({
      iid: 7,
      web_url: 'https://gitlab.com/o/r/-/merge_requests/7',
      state: 'opened',
      draft: false,
      source_branch: 'feature/x',
    })
    const calls: string[] = []
    setup({
      git: { remoteUrl: 'git@gitlab.com:o/r.git' },
      exec: cmd => {
        calls.push(cmd)
        return { stdout: MR, code: 0 }
      },
    })
    const { fetchPrStatus } = await importFresh()
    expect(await fetchPrStatus()).toEqual({
      number: 7,
      url: 'https://gitlab.com/o/r/-/merge_requests/7',
      reviewState: 'pending',
      label: 'MR',
    })
    expect(calls).toContain('glab')
  })

  test('returns null on the default branch without spawning a CLI', async () => {
    const calls: string[] = []
    setup({
      git: { branch: 'main', defaultBranch: 'main' },
      exec: cmd => {
        calls.push(cmd)
        return { stdout: GH_PR, code: 0 }
      },
    })
    const { fetchPrStatus } = await importFresh()
    expect(await fetchPrStatus()).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test("'none' override silences the pill on a parseable host", async () => {
    setup({
      git: { remoteUrl: 'git@gitlab.com:o/r.git' },
      hosts: { 'gitlab.com': 'none' },
    })
    const { fetchPrStatus } = await importFresh()
    expect(await fetchPrStatus()).toBeNull()
  })
})

// Real `tea pr list --fields index,state,head,url` shape observed live against a
// self-hosted Gitea: index is a STRING, head is the branch, url present. Pinned
// so the string-index + --fields path can't silently regress.
const TEA_PR = JSON.stringify([
  {
    index: '81',
    state: 'open',
    head: 'feature/x',
    url: 'https://git.corp.com/o/r/pulls/81',
    title: 't',
  },
])
const GH_REPO = JSON.stringify({ nameWithOwner: 'o/r' })

describe('fetchPrStatus host auto-detection (unknown self-hosted host)', () => {
  test('probes in parallel and dispatches to tea, reusing the probe (one tea call)', async () => {
    const calls: string[] = []
    setup({
      git: { remoteUrl: 'https://git.corp.com/o/r.git' },
      exec: cmd => {
        calls.push(cmd)
        if (cmd === 'tea') return { stdout: TEA_PR, code: 0 }
        // gh repo view / glab mr list don't own this repo
        return { stdout: '', code: 1, stderr: 'not found' }
      },
    })
    const { fetchPrStatus } = await importFresh()
    expect(await fetchPrStatus()).toEqual({
      number: 81,
      url: 'https://git.corp.com/o/r/pulls/81',
      reviewState: 'pending',
      label: 'PR',
    })
    // gh + glab + tea identity probes fire, but tea's result is reused (no 2nd tea)
    expect(calls.filter(c => c === 'tea')).toHaveLength(1)
  })

  test('gh owns the unknown host → identity probe then pr view (two gh calls)', async () => {
    const calls: string[] = []
    setup({
      git: { remoteUrl: 'https://github.corp.com/o/r.git' },
      exec: (cmd, args) => {
        calls.push(cmd)
        if (cmd === 'gh' && args.includes('repo')) return { stdout: GH_REPO, code: 0 }
        if (cmd === 'gh') return { stdout: GH_PR, code: 0 }
        return { stdout: '', code: 1 }
      },
    })
    const { fetchPrStatus } = await importFresh()
    expect((await fetchPrStatus())?.number).toBe(42)
    expect(calls.filter(c => c === 'gh')).toHaveLength(2)
  })

  test('gh wins the priority tiebreak when both gh and tea own the repo', async () => {
    setup({
      git: { remoteUrl: 'https://git.corp.com/o/r.git' },
      exec: (cmd, args) => {
        if (cmd === 'gh' && args.includes('repo')) return { stdout: GH_REPO, code: 0 }
        if (cmd === 'gh') return { stdout: GH_PR, code: 0 }
        if (cmd === 'tea') return { stdout: TEA_PR, code: 0 }
        return { stdout: '', code: 1 }
      },
    })
    const { fetchPrStatus } = await importFresh()
    // gh's PR (#42), not tea's (#81) → gh won
    expect((await fetchPrStatus())?.number).toBe(42)
  })

  test('all CLIs foreign → null, and a 2nd call re-probes nothing (cached none)', async () => {
    const calls: string[] = []
    setup({
      git: { remoteUrl: 'https://git.corp.com/o/r.git' },
      exec: cmd => {
        calls.push(cmd)
        return { stdout: '', code: 1, stderr: 'not this host' }
      },
    })
    const { fetchPrStatus } = await importFresh()
    expect(await fetchPrStatus()).toBeNull()
    const afterFirst = calls.length
    expect(afterFirst).toBeGreaterThan(0)
    expect(await fetchPrStatus()).toBeNull()
    // cached 'none' → no new probes on the second poll
    expect(calls.length).toBe(afterFirst)
  })

  test('a confident host (github.com) never fires an identity probe', async () => {
    const calls: string[][] = []
    setup({
      git: { remoteUrl: 'git@github.com:o/r.git' },
      exec: (cmd, args) => {
        calls.push([cmd, ...args])
        return { stdout: GH_PR, code: 0 }
      },
    })
    const { fetchPrStatus } = await importFresh()
    expect((await fetchPrStatus())?.number).toBe(42)
    // only `gh pr view`, never `gh repo view`
    expect(calls.some(c => c.includes('repo'))).toBe(false)
  })
})
