import { describe, expect, test } from 'bun:test'
import {
  deriveReviewState,
  mapGhJson,
  mapGlabJson,
  mapTeaList,
  pickHostKind,
  resolveHostKind,
  staticHostKind,
} from 'src/vcs/git/ghPrStatus.js'

describe('resolveHostKind', () => {
  test('auto-detects public hosts', () => {
    expect(resolveHostKind('gitlab.com', undefined)).toBe('gitlab')
    expect(resolveHostKind('codeberg.org', undefined)).toBe('gitea')
    expect(resolveHostKind('github.com', undefined)).toBe('github')
  })

  test('unknown/self-hosted defaults to github (preserves GHE)', () => {
    expect(resolveHostKind('github.corp.com', undefined)).toBe('github')
    expect(resolveHostKind('git.example.org', undefined)).toBe('github')
  })

  test('config map overrides auto-detection', () => {
    expect(resolveHostKind('git.corp.com', { 'git.corp.com': 'gitlab' })).toBe('gitlab')
    expect(resolveHostKind('code.corp.com', { 'code.corp.com': 'gitea' })).toBe('gitea')
    // override even wins over a public host
    expect(resolveHostKind('gitlab.com', { 'gitlab.com': 'github' })).toBe('github')
  })

  test("'none' silences the pill for a host", () => {
    expect(resolveHostKind('gitlab.com', { 'gitlab.com': 'none' })).toBeNull()
    expect(resolveHostKind('git.corp.com', { 'git.corp.com': 'none' })).toBeNull()
  })

  test('ignores the :port parseGitRemote keeps on HTTPS remotes', () => {
    // https://gitlab.com:443/o/r.git → parsed host is 'gitlab.com:443'
    expect(resolveHostKind('gitlab.com:443', undefined)).toBe('gitlab')
    expect(resolveHostKind('codeberg.org:443', undefined)).toBe('gitea')
    // config key is the bare host, but the parsed host carries the port
    expect(resolveHostKind('git.corp.com:8443', { 'git.corp.com': 'gitlab' })).toBe('gitlab')
    expect(resolveHostKind('git.corp.com:8443', { 'git.corp.com': 'none' })).toBeNull()
  })
})

describe('staticHostKind', () => {
  test('public known hosts are confident', () => {
    expect(staticHostKind('github.com', undefined)).toEqual({ kind: 'github', confident: true })
    expect(staticHostKind('gitlab.com', undefined)).toEqual({ kind: 'gitlab', confident: true })
    expect(staticHostKind('codeberg.org', undefined)).toEqual({ kind: 'gitea', confident: true })
  })

  test('a prStatusHosts override is confident (incl. none → null)', () => {
    expect(staticHostKind('git.corp.com', { 'git.corp.com': 'gitea' })).toEqual({
      kind: 'gitea',
      confident: true,
    })
    expect(staticHostKind('git.corp.com', { 'git.corp.com': 'none' })).toEqual({
      kind: null,
      confident: true,
    })
    // override is keyed by the bare host even when the parsed host carries a port
    expect(staticHostKind('git.corp.com:8443', { 'git.corp.com': 'gitlab' })).toEqual({
      kind: 'gitlab',
      confident: true,
    })
  })

  test('an unknown self-hosted host defaults to github but is NOT confident', () => {
    expect(staticHostKind('git.viudescloud.uk', undefined)).toEqual({
      kind: 'github',
      confident: false,
    })
    expect(staticHostKind('github.corp.com', undefined)).toEqual({
      kind: 'github',
      confident: false,
    })
  })
})

describe('pickHostKind', () => {
  test('classifies parseable remotes via resolveHostKind', () => {
    expect(pickHostKind('git@gitlab.com:o/r.git', undefined)).toBe('gitlab')
    expect(pickHostKind('https://codeberg.org/o/r.git', undefined)).toBe('gitea')
    expect(pickHostKind('git@github.com:o/r.git', undefined)).toBe('github')
    // HTTPS-with-port remote still classifies (port stripped downstream)
    expect(pickHostKind('https://gitlab.com:443/o/r.git', undefined)).toBe('gitlab')
  })

  test('falls back to gh when the remote is absent (non-origin remote)', () => {
    expect(pickHostKind(null, undefined)).toBe('github')
    expect(pickHostKind('', undefined)).toBe('github')
  })

  test('falls back to gh when the remote is unparseable', () => {
    // SSH config host alias — looksLikeRealHostname rejects 'github.com-work'
    expect(pickHostKind('git@github.com-work:o/r.git', undefined)).toBe('github')
    // single-label internal host (no dot)
    expect(pickHostKind('git@githubenterprise:o/r.git', undefined)).toBe('github')
  })

  test('a parseable host override still wins', () => {
    expect(pickHostKind('git@gitlab.com:o/r.git', { 'gitlab.com': 'none' })).toBeNull()
    expect(pickHostKind('git@git.corp.com:o/r.git', { 'git.corp.com': 'gitea' })).toBe('gitea')
  })
})

describe('deriveReviewState', () => {
  test('draft wins over reviewDecision', () => {
    expect(deriveReviewState(true, 'APPROVED')).toBe('draft')
  })
  test('maps GitHub reviewDecision values', () => {
    expect(deriveReviewState(false, 'APPROVED')).toBe('approved')
    expect(deriveReviewState(false, 'CHANGES_REQUESTED')).toBe('changes_requested')
    expect(deriveReviewState(false, 'REVIEW_REQUIRED')).toBe('pending')
    expect(deriveReviewState(false, '')).toBe('pending')
  })
})

describe('mapGhJson', () => {
  const base = {
    number: 42,
    url: 'https://github.com/o/r/pull/42',
    reviewDecision: 'APPROVED',
    isDraft: false,
    headRefName: 'feature',
    state: 'OPEN',
  }

  test('maps an open approved PR with PR label', () => {
    expect(mapGhJson(base, 'main')).toEqual({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      reviewState: 'approved',
      label: 'PR',
    })
  })

  test('suppresses PRs opened from the default branch', () => {
    expect(mapGhJson({ ...base, headRefName: 'main' }, 'main')).toBeNull()
    expect(mapGhJson({ ...base, headRefName: 'master' }, 'develop')).toBeNull()
    expect(mapGhJson({ ...base, headRefName: 'develop' }, 'develop')).toBeNull()
  })

  test('suppresses merged/closed PRs', () => {
    expect(mapGhJson({ ...base, state: 'MERGED' }, 'main')).toBeNull()
    expect(mapGhJson({ ...base, state: 'CLOSED' }, 'main')).toBeNull()
  })

  test('returns null when required fields are missing', () => {
    expect(mapGhJson({ url: 'x' }, 'main')).toBeNull()
    expect(mapGhJson({ number: 1 }, 'main')).toBeNull()
  })

  test('returns null (no throw) when data is null/undefined', () => {
    // `gh` printing literal `null` → jsonParse yields JS null
    expect(mapGhJson(null as unknown as Parameters<typeof mapGhJson>[0], 'main')).toBeNull()
    expect(mapGhJson(undefined as unknown as Parameters<typeof mapGhJson>[0], 'main')).toBeNull()
  })
})

describe('mapGlabJson', () => {
  const base = {
    iid: 7,
    web_url: 'https://gitlab.com/o/r/-/merge_requests/7',
    state: 'opened',
    draft: false,
    source_branch: 'feature',
  }

  test('maps an open MR with MR label and neutral pending', () => {
    expect(mapGlabJson(base, 'main')).toEqual({
      number: 7,
      url: 'https://gitlab.com/o/r/-/merge_requests/7',
      reviewState: 'pending',
      label: 'MR',
    })
  })

  test('approvals_left == 0 → approved', () => {
    expect(mapGlabJson({ ...base, approvals_left: 0 }, 'main')?.reviewState).toBe('approved')
    expect(mapGlabJson({ ...base, approvals_left: 2 }, 'main')?.reviewState).toBe('pending')
  })

  test('draft → draft', () => {
    expect(mapGlabJson({ ...base, draft: true, approvals_left: 0 }, 'main')?.reviewState).toBe('draft')
  })

  test("'locked' is still open → pending", () => {
    expect(mapGlabJson({ ...base, state: 'locked' }, 'main')?.reviewState).toBe('pending')
  })

  test('suppresses merged/closed and default-branch MRs', () => {
    expect(mapGlabJson({ ...base, state: 'merged' }, 'main')).toBeNull()
    expect(mapGlabJson({ ...base, state: 'closed' }, 'main')).toBeNull()
    expect(mapGlabJson({ ...base, source_branch: 'main' }, 'main')).toBeNull()
  })

  test('returns null when required fields are missing', () => {
    expect(mapGlabJson({ web_url: 'x' }, 'main')).toBeNull()
    expect(mapGlabJson({ iid: 1 }, 'main')).toBeNull()
  })

  test('returns null (no throw) when data is null/undefined', () => {
    expect(mapGlabJson(null as unknown as Parameters<typeof mapGlabJson>[0], 'main')).toBeNull()
    expect(mapGlabJson(undefined as unknown as Parameters<typeof mapGlabJson>[0], 'main')).toBeNull()
  })
})

describe('mapTeaList', () => {
  const open = {
    index: 3,
    html_url: 'https://codeberg.org/o/r/pulls/3',
    state: 'open',
    head: { ref: 'feature' },
  }

  test('picks the open PR matching the current branch (PR label)', () => {
    expect(mapTeaList([open], 'feature', 'main')).toEqual({
      number: 3,
      url: 'https://codeberg.org/o/r/pulls/3',
      reviewState: 'pending',
      label: 'PR',
    })
  })

  test('handles head as a plain string ref', () => {
    expect(mapTeaList([{ ...open, head: 'feature' }], 'feature', 'main')?.number).toBe(3)
  })

  test('coerces the string index `tea pr list` emits', () => {
    // Real `tea pr list -o json --fields index,state,head,url` shape.
    const real = {
      index: '81',
      state: 'open',
      head: 'feature',
      url: 'https://git.example/o/r/pulls/81',
    }
    expect(mapTeaList([real], 'feature', 'main')).toEqual({
      number: 81,
      url: 'https://git.example/o/r/pulls/81',
      reviewState: 'pending',
      label: 'PR',
    })
  })

  test('rejects a non-numeric index string', () => {
    expect(mapTeaList([{ ...open, index: 'abc' }], 'feature', 'main')).toBeNull()
  })

  test('falls back to head.label and url when html_url absent', () => {
    const pr = { index: 9, url: 'https://x/9', state: 'open', head: { label: 'o:feat' } }
    // head.label "o:feat" doesn't match branch "feat" exactly → no match
    expect(mapTeaList([pr], 'feat', 'main')).toBeNull()
    expect(mapTeaList([pr], 'o:feat', 'main')).toEqual({
      number: 9,
      url: 'https://x/9',
      reviewState: 'pending',
      label: 'PR',
    })
  })

  test('draft → draft', () => {
    expect(mapTeaList([{ ...open, draft: true }], 'feature', 'main')?.reviewState).toBe('draft')
  })

  test('no match when branch is not in the list', () => {
    expect(mapTeaList([open], 'other-branch', 'main')).toBeNull()
  })

  test('suppresses merged/closed and default-branch PRs', () => {
    expect(mapTeaList([{ ...open, merged: true }], 'feature', 'main')).toBeNull()
    expect(mapTeaList([{ ...open, state: 'closed' }], 'feature', 'main')).toBeNull()
    expect(mapTeaList([{ ...open, head: { ref: 'main' } }], 'main', 'main')).toBeNull()
  })

  test('skips a stale same-branch PR and keeps scanning for the open one', () => {
    // A reused branch name can yield a closed PR before the live open one;
    // the closed match must not abort the scan.
    const stale = { ...open, index: 1, state: 'closed' }
    const live = { ...open, index: 2, state: 'open' }
    expect(mapTeaList([stale, live], 'feature', 'main')?.number).toBe(2)
    const merged = { ...open, index: 5, merged: true }
    expect(mapTeaList([merged, live], 'feature', 'main')?.number).toBe(2)
  })

  test('returns null for non-array input', () => {
    expect(mapTeaList(null, 'feature', 'main')).toBeNull()
    expect(mapTeaList({}, 'feature', 'main')).toBeNull()
  })
})
