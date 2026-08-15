import { getGlobalConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { parseGitRemote } from 'src/services/git/detectRepository.js'
import { execFileNoThrow } from 'src/shared/proc/execFileNoThrow.js'
import { getBranch, getDefaultBranch, getIsGit, getRemoteUrl } from 'src/services/git/git.js'
import { jsonParse } from 'src/platform/slowOperations.js'

export type PrReviewState =
  | 'approved'
  | 'pending'
  | 'changes_requested'
  | 'draft'
  | 'merged'
  | 'closed'

/** GitHub/Gitea call them Pull Requests; GitLab calls them Merge Requests. */
export type PrLabel = 'PR' | 'MR'

export type PrStatus = {
  number: number
  url: string
  reviewState: PrReviewState
  label: PrLabel
}

/** Which platform's CLI resolves a given host's PR/MR status. */
export type PrHostKind = 'github' | 'gitlab' | 'gitea'

const CLI_TIMEOUT_MS = 5000

/**
 * Derive GitHub review state from `gh` API values.
 * Draft PRs always show as 'draft' regardless of reviewDecision.
 * reviewDecision can be: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty string.
 */
export function deriveReviewState(
  isDraft: boolean,
  reviewDecision: string,
): PrReviewState {
  if (isDraft) return 'draft'
  switch (reviewDecision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    default:
      return 'pending'
  }
}

/**
 * Resolve a git remote host to the platform whose CLI should be used.
 * A `prStatusHosts` config entry wins over auto-detection ('none' ⇒ no pill).
 * Unknown/self-hosted hosts default to 'github' so existing GitHub Enterprise
 * users keep the pill (the gh adapter fails open if the host isn't GitHub).
 */
export function resolveHostKind(
  host: string,
  hosts: Record<string, 'github' | 'gitlab' | 'gitea' | 'none'> | undefined,
): PrHostKind | null {
  // parseGitRemote keeps the :port for HTTPS remotes (e.g. `gitlab.com:443`,
  // `git.corp.com:8443`); classify and look up the config by the bare hostname.
  const bareHost = host.split(':')[0] ?? host
  const override = hosts?.[bareHost]
  if (override) return override === 'none' ? null : override
  if (bareHost === 'gitlab.com') return 'gitlab'
  if (bareHost === 'codeberg.org') return 'gitea'
  return 'github'
}

/**
 * Like `resolveHostKind` but reports whether the classification is *confident*.
 * A `prStatusHosts` override and the public known hosts (github.com, gitlab.com,
 * codeberg.org) are confident; an unknown self-hosted host only *defaults* to
 * 'github' (`confident: false`), which is the signal to probe the installed CLIs
 * to find which one actually owns the repo.
 */
export function staticHostKind(
  host: string,
  hosts: Record<string, 'github' | 'gitlab' | 'gitea' | 'none'> | undefined,
): { kind: PrHostKind | null; confident: boolean } {
  const bareHost = host.split(':')[0] ?? host
  const override = hosts?.[bareHost]
  if (override) {
    return { kind: override === 'none' ? null : override, confident: true }
  }
  if (bareHost === 'gitlab.com') return { kind: 'gitlab', confident: true }
  if (bareHost === 'codeberg.org') return { kind: 'gitea', confident: true }
  if (bareHost === 'github.com') return { kind: 'github', confident: true }
  return { kind: 'github', confident: false }
}

/**
 * Pick the host CLI for a remote URL. When the remote is absent (a non-`origin`
 * remote name) or unparseable (an SSH config host alias like `github.com-work`,
 * a single-label internal host), we can't classify it — fall back to `gh`, which
 * resolves the repo via its own remote/SSH config, preserving the original
 * GitHub-only behavior. A `prStatusHosts` override only applies once the host
 * parses (an unparseable remote exposes no host string to key the map on).
 */
export function pickHostKind(
  remoteUrl: string | null,
  hosts: Record<string, 'github' | 'gitlab' | 'gitea' | 'none'> | undefined,
): PrHostKind | null {
  const parsed = remoteUrl ? parseGitRemote(remoteUrl) : null
  return parsed ? resolveHostKind(parsed.host, hosts) : 'github'
}

// --- Pure JSON → PrStatus mappers (unit-tested without mocking) ---------------

interface GhJson {
  number?: number
  url?: string
  reviewDecision?: string
  isDraft?: boolean
  headRefName?: string
  state?: string
}

/** Returns null on the default branch's PR or a merged/closed PR. */
export function mapGhJson(data: GhJson, defaultBranch: string): PrStatus | null {
  if (!data || typeof data.number !== 'number' || typeof data.url !== 'string') {
    return null
  }
  if (
    data.headRefName === defaultBranch ||
    data.headRefName === 'main' ||
    data.headRefName === 'master'
  ) {
    return null
  }
  if (data.state === 'MERGED' || data.state === 'CLOSED') return null
  return {
    number: data.number,
    url: data.url,
    reviewState: deriveReviewState(!!data.isDraft, data.reviewDecision ?? ''),
    label: 'PR',
  }
}

interface GlabJson {
  iid?: number
  web_url?: string
  state?: string
  draft?: boolean
  source_branch?: string
  approvals_left?: number
}

/**
 * GitLab has no single review-decision field. Best-effort from a single
 * `glab mr view` call: draft → draft; `approvals_left == 0` (when present) →
 * approved; otherwise neutral pending. Only merged/closed suppress (a 'locked'
 * MR is still open → pending).
 */
export function mapGlabJson(data: GlabJson, defaultBranch: string): PrStatus | null {
  if (!data || typeof data.iid !== 'number' || typeof data.web_url !== 'string') {
    return null
  }
  if (
    data.source_branch === defaultBranch ||
    data.source_branch === 'main' ||
    data.source_branch === 'master'
  ) {
    return null
  }
  if (data.state === 'merged' || data.state === 'closed') return null
  const reviewState: PrReviewState = data.draft
    ? 'draft'
    : data.approvals_left === 0
      ? 'approved'
      : 'pending'
  return { number: data.iid, url: data.web_url, reviewState, label: 'MR' }
}

interface TeaPr {
  // `tea pr list -o json` serializes the PR index as a string (e.g. "81").
  index?: number | string
  number?: number | string
  url?: string
  html_url?: string
  head?: string | { ref?: string; label?: string }
  state?: string
  draft?: boolean
  merged?: boolean
}

/** Extract the head branch ref from tea's PR object (string or {ref,label}). */
function teaHeadRef(pr: TeaPr): string | null {
  const head = pr.head
  if (typeof head === 'string') return head
  if (head && typeof head === 'object') return head.ref ?? head.label ?? null
  return null
}

/**
 * Gitea has no current-branch command, so map over the list and pick the open
 * PR whose head ref matches the current branch. No review-decision field; map
 * draft → draft, otherwise neutral pending.
 */
export function mapTeaList(
  list: unknown,
  branch: string,
  defaultBranch: string,
): PrStatus | null {
  if (!Array.isArray(list)) return null
  for (const pr of list as TeaPr[]) {
    const ref = teaHeadRef(pr)
    if (!ref || ref !== branch) continue
    if (ref === defaultBranch || ref === 'main' || ref === 'master') continue
    if (pr.merged === true) continue
    const state = String(pr.state ?? '').toLowerCase()
    if (state === 'closed' || state === 'merged') continue
    const rawNumber = pr.index ?? pr.number
    const number = typeof rawNumber === 'string' ? Number(rawNumber) : rawNumber
    const url = pr.html_url ?? pr.url
    if (typeof number !== 'number' || !Number.isFinite(number)) continue
    if (typeof url !== 'string') continue
    return {
      number,
      url,
      reviewState: pr.draft ? 'draft' : 'pending',
      label: 'PR',
    }
  }
  return null
}

// --- CLI adapters (thin spawn + parse, fail open on any error) ----------------

/**
 * Run a host CLI in the project cwd and return its parsed JSON stdout alongside
 * the exit code/stderr. Parses any non-empty stdout regardless of exit code:
 * `glab`/`tea` (and `gh`) can print valid JSON while exiting non-zero (auth nags,
 * warnings), and real failures write to stderr leaving stdout empty (→ json null)
 * or non-JSON (→ caught). A missing CLI resolves instantly via ENOENT (code 1).
 */
async function runCli(
  cmd: string,
  args: string[],
  timeout: number = CLI_TIMEOUT_MS,
): Promise<{ json: unknown | null; code: number; stderr: string }> {
  const { stdout, stderr, code } = await execFileNoThrow(cmd, args, {
    timeout,
    preserveOutputOnError: true,
    useCwd: true,
  })
  if (!stdout.trim()) return { json: null, code, stderr }
  try {
    return { json: jsonParse(stdout), code, stderr }
  } catch (e) {
    logForDebugging(`prStatus: failed to parse ${cmd} JSON: ${e}`)
    return { json: null, code, stderr }
  }
}

/** Thin wrapper kept for the adapters that only care about the parsed JSON. */
async function runCliJson(cmd: string, args: string[]): Promise<unknown | null> {
  return (await runCli(cmd, args)).json
}

async function fetchGh(defaultBranch: string): Promise<PrStatus | null> {
  const data = await runCliJson('gh', [
    'pr',
    'view',
    '--json',
    'number,url,reviewDecision,isDraft,headRefName,state',
  ])
  return data ? mapGhJson(data as GhJson, defaultBranch) : null
}

async function fetchGlab(defaultBranch: string): Promise<PrStatus | null> {
  const data = await runCliJson('glab', ['mr', 'view', '-F', 'json'])
  return data ? mapGlabJson(data as GlabJson, defaultBranch) : null
}

// `tea pr list` defaults to a fixed field set that omits head/url; request the
// fields the mapper needs (it serializes index as a string). Shared by the tea
// adapter and the tea identity probe (which doubles as the PR fetch).
const TEA_LIST_ARGS = [
  'pr',
  'list',
  '-o',
  'json',
  '--state',
  'open',
  '--limit',
  '100',
  '--fields',
  'index,state,head,url,title',
]

async function fetchTea(
  branch: string,
  defaultBranch: string,
): Promise<PrStatus | null> {
  const data = await runCliJson('tea', TEA_LIST_ARGS)
  return data ? mapTeaList(data, branch, defaultBranch) : null
}

function runAdapter(
  kind: PrHostKind,
  branch: string,
  defaultBranch: string,
): Promise<PrStatus | null> {
  switch (kind) {
    case 'gitlab':
      return fetchGlab(defaultBranch)
    case 'gitea':
      return fetchTea(branch, defaultBranch)
    case 'github':
      return fetchGh(defaultBranch)
  }
}

// --- Host auto-detection (probe installed CLIs to find the repo's owner) ------

// Tighter than CLI_TIMEOUT_MS: detection runs the probes in parallel, so the
// whole fan-out stays under this — comfortably below usePrStatus's 4s slow-
// disable guard even if one CLI hangs on the network.
const DETECT_TIMEOUT_MS = 3000

// Session-scoped: host → the CLI that owns it ('none' = nobody, no pill). Probed
// at most once per host per session; later polls reuse the cached kind.
const detectCache = new Map<string, PrHostKind | 'none'>()
// Coalesces concurrent detections of the same host (e.g. an isLoading remount
// firing a second poll before the first detection resolves).
const inFlight = new Map<
  string,
  Promise<{ kind: PrHostKind | null; teaList: unknown[] | null }>
>()

/** Identity probe: returns true iff `gh` recognizes this cwd as a GitHub repo. */
async function ghOwns(): Promise<boolean> {
  const { json } = await runCli(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner'],
    DETECT_TIMEOUT_MS,
  )
  return !!json && typeof json === 'object' && !Array.isArray(json)
}

/** Identity probe: `glab mr list -F json` yields an array iff a GitLab repo. */
async function glabOwns(): Promise<boolean> {
  const { json } = await runCli(
    'glab',
    ['mr', 'list', '-F', 'json'],
    DETECT_TIMEOUT_MS,
  )
  return Array.isArray(json)
}

/**
 * Identity probe: `tea pr list` yields an array iff a Gitea repo. Returns the
 * list itself so a tea win can map the PR without a second call.
 */
async function teaOwns(): Promise<unknown[] | null> {
  const { json } = await runCli('tea', TEA_LIST_ARGS, DETECT_TIMEOUT_MS)
  return Array.isArray(json) ? json : null
}

/**
 * Probe the installed forge CLIs in parallel and pick the one that owns the repo
 * (priority gh > glab > tea — gh first preserves GitHub Enterprise). Caches the
 * result and coalesces concurrent calls for the same host.
 */
function detectKind(
  bareHost: string,
): Promise<{ kind: PrHostKind | null; teaList: unknown[] | null }> {
  const existing = inFlight.get(bareHost)
  if (existing) return existing
  const probe = (async () => {
    const [gh, glab, teaList] = await Promise.all([
      ghOwns(),
      glabOwns(),
      teaOwns(),
    ])
    const kind: PrHostKind | null = gh
      ? 'github'
      : glab
        ? 'gitlab'
        : teaList
          ? 'gitea'
          : null
    detectCache.set(bareHost, kind ?? 'none')
    logForDebugging(`prStatus: detected ${bareHost} → ${kind ?? 'none'}`)
    return { kind, teaList }
  })()
  inFlight.set(bareHost, probe)
  return probe.finally(() => inFlight.delete(bareHost))
}

/**
 * Fetch PR/MR status for the current branch, dispatching to the right host CLI
 * (`gh`/`glab`/`tea`) based on the git remote. Returns null on any failure
 * (CLI not installed, no PR, not a git repo, default branch, etc).
 */
export async function fetchPrStatus(): Promise<PrStatus | null> {
  const isGit = await getIsGit()
  if (!isGit) return null

  // Skip on the default branch — the per-host "current branch" commands return
  // the most recently merged PR there, which is misleading.
  const [branch, defaultBranch, remoteUrl] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
    getRemoteUrl(),
  ])
  if (branch === defaultBranch) return null

  const hosts = getGlobalConfig().prStatusHosts
  const parsed = remoteUrl ? parseGitRemote(remoteUrl) : null
  // Null/unparseable remote (non-origin remote, SSH alias): no host string to
  // classify or probe — keep the original gh fallback (gh resolves the repo via
  // its own remote/SSH config).
  if (!parsed) return fetchGh(defaultBranch)

  const { kind, confident } = staticHostKind(parsed.host, hosts)
  if (confident) {
    if (!kind) return null
    return runAdapter(kind, branch, defaultBranch)
  }

  // Unknown self-hosted host: auto-detect which installed CLI owns the repo.
  const bareHost = parsed.host.split(':')[0] ?? parsed.host
  const cached = detectCache.get(bareHost)
  if (cached === 'none') return null
  if (cached) return runAdapter(cached, branch, defaultBranch)

  const { kind: detected, teaList } = await detectKind(bareHost)
  if (!detected) return null
  // tea's identity probe already fetched the open-PR list — map it directly.
  if (detected === 'gitea' && teaList) {
    return mapTeaList(teaList, branch, defaultBranch)
  }
  return runAdapter(detected, branch, defaultBranch)
}
