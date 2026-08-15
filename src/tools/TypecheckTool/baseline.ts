import { execFile } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, sep } from 'path'
import { promisify } from 'util'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { addFileGlobRuleToGitignore } from 'src/services/git/gitignore.js'
import { logError } from 'src/shared/log.js'
import { partitionAgainstBaseline } from 'src/tools/TypecheckTool/fingerprint.js'
import type { BaselineState, Checker } from 'src/tools/TypecheckTool/types.js'

/**
 * The pre-existing-diagnostic baseline: what makes this tool usable in a
 * project with a large known backlog.
 *
 * The rule is simple and needs no second compile and no git mutation: when the
 * working tree is CLEAN, every diagnostic the checker reports is pre-existing
 * by definition, so that run's fingerprints are recorded as the backlog for the
 * current commit. Later runs report only what is missing from it.
 *
 * Deliberately NOT keyed by checker version. A toolchain bump that changes the
 * diagnostic set is real information, and it surfaces exactly once — at the
 * bump commit, whose clean tree re-captures the baseline.
 */

const BASELINE_FILE = 'typecheck-baseline.json'
/**
 * Bump whenever `fingerprintDiagnostic` changes, or every entry recorded by the
 * previous version reads as fixed AND its live counterpart as newly
 * introduced — the exact churn the tool exists to suppress. A mismatch here
 * discards the file and the next clean tree records it again.
 *
 * 2: messages carrying a volatile symbol name are normalised.
 */
const BASELINE_VERSION = 2
/**
 * How much of a reconstructed baseline must still be present in the live run
 * for it to be believed. The failure this guards is a worktree where the
 * checker could not resolve dependencies: `tsc` without `node_modules` does not
 * fail, it reports thousands of "cannot find module" errors, and recording
 * those as the backlog would bury the real ones. A sound reconstruction
 * overlaps heavily by construction — uncommitted work changes a few files, not
 * all of them — so a near-zero overlap means we checked something else.
 */
const MIN_RECONSTRUCTION_OVERLAP = 0.5
/** Name of the throwaway checkout, nested so dependency lookups walk up into the real project. */
const HEAD_WORKTREE_DIR = 'head-worktree'

/**
 * Runs the checker against a clean checkout of HEAD and returns its
 * fingerprints, or null if the run was unusable. Supplied by the caller, which
 * owns how a check is executed; this module only decides when one is needed.
 */
export type ReconstructAtHead = (dir: string) => Promise<string[] | null>

type BaselineEntry = {
  sha: string
  capturedAt: string
  fingerprints: string[]
}

type BaselineFile = {
  version: number
  checkers: Partial<Record<Checker, BaselineEntry>>
}

/**
 * Project-local, mirroring the hardening `getPlansDirectory` already applies to
 * `.claudin/plans`: restrictive mode, and a containment check so a `.claudin`
 * symlink planted in a hostile repo cannot redirect our writes outside the
 * project. An unverifiable path falls back to the global config dir rather than
 * being used as-is.
 */
// Keyed by cwd, not process-wide: cwd can change mid-session (worktree
// enter/exit) and differ per async context (subagent cwd overrides), and each
// checkout deserves its own baseline.
const baselineDirCache = new Map<string, string>()
export function getBaselineDirectory(cwd: string): string {
  const cached = baselineDirCache.get(cwd)
  if (cached !== undefined) return cached
  const resolved = resolveBaselineDirectory(cwd)
  baselineDirCache.set(cwd, resolved)
  return resolved
}

function resolveBaselineDirectory(cwd: string): string {
  let dir = join(cwd, '.claudin', 'cache')
  try {
    getFsImplementation().mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    logError(error)
  }

  let contained = false
  try {
    const realCwd = getFsImplementation().realpathSync(cwd)
    const realDir = getFsImplementation().realpathSync(dir)
    contained = realDir === realCwd || realDir.startsWith(realCwd + sep)
    if (!contained) {
      logError(
        new Error(`Typecheck cache escapes project root via symlink: ${dir} -> ${realDir}`),
      )
    }
  } catch (error) {
    logError(error)
  }

  if (!contained) {
    dir = join(getClaudinConfigHomeDir(), 'typecheck-cache')
    try {
      getFsImplementation().mkdirSync(dir, { mode: 0o700 })
    } catch (error) {
      logError(error)
    }
    return dir
  }

  try {
    chmodSync(dir, 0o700)
  } catch {
    // best-effort; not every filesystem honours unix permission bits
  }

  // Load-bearing, not tidiness: an unignored baseline file would leave
  // `git status` permanently dirty, and a dirty tree is exactly the condition
  // that stops us capturing a baseline — the feature would disable itself on
  // first use. Written to the user's global gitignore so no commit is needed
  // and teammates are unaffected.
  void addFileGlobRuleToGitignore('.claudin/cache/', cwd)

  return dir
}

function baselineFilePath(cwd: string): string {
  return join(getBaselineDirectory(cwd), BASELINE_FILE)
}

function loadBaselineFile(cwd: string): BaselineFile {
  try {
    const raw = readFileSync(baselineFilePath(cwd), 'utf8')
    const parsed = JSON.parse(raw) as BaselineFile
    if (parsed?.version !== BASELINE_VERSION || typeof parsed.checkers !== 'object') {
      return { version: BASELINE_VERSION, checkers: {} }
    }
    return parsed
  } catch {
    // Missing or unreadable is the normal first-run state, not an error.
    return { version: BASELINE_VERSION, checkers: {} }
  }
}

function saveBaselineFile(cwd: string, file: BaselineFile): void {
  try {
    writeFileSync(baselineFilePath(cwd), JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    logError(error)
  }
}

const execFileAsync = promisify(execFile)

/** Generous for the read-only queries below; a hung git must not hang a check. */
const GIT_TIMEOUT_MS = 10_000
/** `status --porcelain` in a very large tree; the 1 MB default would truncate. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Deliberately NOT `../../utils/execFileNoThrow.js`: six unrelated suites
 * `mock.module` that specifier, and Bun applies a module override for the WHOLE
 * `bun test` run regardless of file order (see `.claudin/rules/testing.md`).
 * Every git call here then answered "exit 1", so a real repository resolved as
 * `not-a-git-repo` and sixteen baseline tests that pass in isolation failed in
 * CI's full-suite run.
 *
 * Calling git directly costs nothing here. The wrapper's value is argv and env
 * sanitisation for command strings that can carry user input; every invocation
 * in this module is a fixed verb plus a cwd and shas read back from our own
 * cache file.
 */
async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    })
    return { stdout, code: 0 }
  } catch (error) {
    // A non-zero exit is an ANSWER for some of these (`merge-base
    // --is-ancestor`), so it is reported, never logged as a failure.
    const code = (error as { code?: unknown }).code
    return { stdout: '', code: typeof code === 'number' ? code : 1 }
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const { stdout, code } = await runGit(cwd, args)
  return code === 0 ? stdout : null
}

/**
 * For git commands that ANSWER with their exit code and print nothing. `git`
 * above collapses "ran fine, said no" into the same `null` as "failed", which
 * is exactly the distinction `merge-base --is-ancestor` exists to make.
 */
async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  const { code } = await runGit(cwd, args)
  return code === 0
}

/**
 * Whether `ancestor` is reachable from `descendant`. A sha that is not — after
 * a branch switch, a rebase or an amend — describes a different line of work,
 * and comparing this run against it would mislabel unrelated diagnostics. A
 * sha that no longer exists at all makes git exit non-zero, which lands here as
 * false, so a rewritten history degrades to "no baseline" rather than throwing.
 */
async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitOk(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
}

/** How many commits `to` is ahead of `from`; 0 when it cannot be determined. */
async function commitsBetween(cwd: string, from: string, to: string): Promise<number> {
  const count = await git(cwd, ['rev-list', '--count', `${from}..${to}`])
  const parsed = Number.parseInt(count?.trim() ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export async function getHeadSha(cwd: string): Promise<string | null> {
  const sha = await git(cwd, ['rev-parse', 'HEAD'])
  return sha?.trim() || null
}

/**
 * Entries under `.claudin/` never change what a compiler reports — they are
 * agent scratch (plans, this cache, rules in markdown). Counting them as a
 * dirty tree would block baseline capture for a reason unrelated to the code
 * being checked.
 */
const AGENT_SCRATCH_ENTRY_RE = /^..\s+"?\.claudin\//

export async function isWorkingTreeClean(cwd: string): Promise<boolean | null> {
  const status = await git(cwd, ['status', '--porcelain'])
  if (status === null) return null
  return status
    .split('\n')
    .filter(line => line.trim().length > 0)
    .every(line => AGENT_SCRATCH_ENTRY_RE.test(line))
}

export type BaselineMode = 'auto' | 'capture' | 'ignore'

export type BaselineOutcome = {
  state: BaselineState
  /** Per-diagnostic verdict, index-aligned with the fingerprints handed in. */
  isNew: boolean[]
  fixedCount: number
  /**
   * Set when `capture` was asked for on a dirty tree and downgraded to `auto`.
   * The caller has to be told: it asked to re-record the backlog, and that did
   * not happen.
   */
  captureRefused?: boolean
}

function allPreexisting(count: number): boolean[] {
  return new Array<boolean>(count).fill(false)
}

function allNew(count: number): boolean[] {
  return new Array<boolean>(count).fill(true)
}

/**
 * Rebuild HEAD's baseline without touching the user's working tree.
 *
 * The first check of a session is the tool's weakest moment: the session edited
 * before it checked, so there is nothing to record and — measured twice — the
 * model's own answer is `git stash`, the tree-mutating pattern this tool exists
 * to replace. A detached worktree answers the same question with no stash, no
 * index write and no branch: check out HEAD elsewhere, run the checker there,
 * and keep the result.
 *
 * Nested under the project (not /tmp) on purpose — node resolution walks
 * upwards, so a checkout inside `.claudin/cache/` finds the real
 * `node_modules` without a single symlink. Symlinking dependency directories
 * into a scratch tree would put the user's real `node_modules` one `rm -rf`
 * away from deletion; this cannot.
 */
async function reconstructAtHead(
  cwd: string,
  sha: string,
  live: string[],
  reconstruct: ReconstructAtHead,
): Promise<string[] | null> {
  if (process.env.CLAUDIN_DISABLE_TYPECHECK_WORKTREE === '1') return null

  const base = getBaselineDirectory(cwd)
  // A `.claudin` we could not verify falls back to the global config dir, which
  // is outside the project — no dependency resolution, so no point trying.
  if (!base.startsWith(cwd + sep)) return null
  const dir = join(base, HEAD_WORKTREE_DIR)

  let added = false
  try {
    // A crashed earlier run can leave both the directory and git's registration
    // behind, and `worktree add` refuses a path that exists.
    rmSync(dir, { recursive: true, force: true })
    await gitOk(cwd, ['worktree', 'prune'])
    // --detach: no branch is created, so nothing appears in `git branch` and no
    // ref can collide with a concurrent session's.
    added = await gitOk(cwd, ['worktree', 'add', '--detach', dir, sha])
    if (!added) return null
    const rebuilt = await reconstruct(dir)
    if (!rebuilt) return null
    return believable(rebuilt, live) ? rebuilt : null
  } catch (e) {
    logError(`Typecheck: baseline reconstruction failed — ${String(e)}`)
    return null
  } finally {
    if (added) await gitOk(cwd, ['worktree', 'remove', '--force', dir])
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort: the next run prunes and retries.
    }
  }
}

function believable(rebuilt: string[], live: string[]): boolean {
  if (rebuilt.length === 0) return true
  const present = new Set(live)
  const overlap = rebuilt.filter(f => present.has(f)).length
  return overlap / rebuilt.length >= MIN_RECONSTRUCTION_OVERLAP
}

/**
 * Classify this run's diagnostics and persist a new baseline when the tree is
 * clean at a commit we have not recorded yet.
 */
export async function resolveBaseline(opts: {
  cwd: string
  checker: Checker
  mode: BaselineMode
  fingerprints: string[]
  reconstruct?: ReconstructAtHead
}): Promise<BaselineOutcome> {
  const { cwd, checker, mode, fingerprints, reconstruct } = opts

  if (mode === 'ignore') {
    return {
      state: { kind: 'absent', reason: 'ignored' },
      isNew: allNew(fingerprints.length),
      fixedCount: 0,
    }
  }

  const sha = await getHeadSha(cwd)
  if (!sha) {
    return {
      state: { kind: 'absent', reason: 'not-a-git-repo' },
      isNew: allNew(fingerprints.length),
      fixedCount: 0,
    }
  }

  const file = loadBaselineFile(cwd)
  const existing = file.checkers[checker]
  const treeClean = (await isWorkingTreeClean(cwd)) ?? false

  // A baseline is keyed to HEAD's sha, so it must describe HEAD's content.
  // Honouring `capture` on a dirty tree files the errors in the UNCOMMITTED
  // work under that commit, and every later run then reports them as
  // pre-existing — the agent's own breakage, made invisible and permanent.
  // Neither guard below caught it: the same-sha branch is skipped for
  // `capture`, and `introducedSincePrev` only spoke up when the sha differed.
  // Degrade to `auto` rather than failing, so the caller still gets the best
  // classification available, and say that we did.
  const captureRefused = mode === 'capture' && !treeClean
  const effectiveMode = captureRefused ? 'auto' : mode
  const clean = effectiveMode === 'capture' ? true : treeClean

  // Same commit, already recorded: report the delta. Re-capturing here would
  // paper over a toolchain change that legitimately introduced diagnostics
  // without the source moving.
  if (existing && existing.sha === sha && effectiveMode !== 'capture') {
    const { isNew, fixedCount } = partitionAgainstBaseline(fingerprints, existing.fingerprints)
    return { state: { kind: 'matched', sha }, isNew, fixedCount, captureRefused }
  }

  if (!clean) {
    // No baseline for HEAD and the tree is too dirty to record one. Giving up
    // here is what left the FIRST check of a session with "provenance unknown"
    // — a session that edits before it checks always lands in this branch — and
    // an agent's answer to that was to run `git stash` itself. An older
    // baseline still answers the question that matters, as long as it belongs
    // to this line of work and the output says how stale it is.
    //
    // Reconstruction is tried FIRST because it is both exact and cheaper over a
    // session: it produces HEAD's real backlog, and persisting it turns every
    // later call into a plain `matched`, where inheriting stays approximate and
    // re-derives itself on every call.
    if (reconstruct) {
      const rebuilt = await reconstructAtHead(cwd, sha, fingerprints, reconstruct)
      if (rebuilt) {
        file.checkers[checker] = {
          sha,
          capturedAt: new Date().toISOString(),
          fingerprints: rebuilt,
        }
        saveBaselineFile(cwd, file)
        const { isNew, fixedCount } = partitionAgainstBaseline(fingerprints, rebuilt)
        return {
          state: { kind: 'reconstructed', sha, recordedCount: rebuilt.length },
          isNew,
          fixedCount,
          captureRefused,
        }
      }
    }
    if (existing && (await isAncestor(cwd, existing.sha, sha))) {
      const { isNew, fixedCount } = partitionAgainstBaseline(fingerprints, existing.fingerprints)
      const behind = await commitsBetween(cwd, existing.sha, sha)
      return {
        state: { kind: 'inherited', sha: existing.sha, behind },
        isNew,
        fixedCount,
        captureRefused,
      }
    }
    return {
      state: { kind: 'absent', reason: 'dirty-tree-no-baseline' },
      isNew: allNew(fingerprints.length),
      fixedCount: 0,
      captureRefused,
    }
  }

  // Capture. Everything present now IS the backlog, so nothing counts as new —
  // but if this replaces an earlier baseline, say how much it absorbed. That
  // covers a commit adding errors on a clean tree AND a forced re-capture at
  // the same commit; without it either one launders those errors into the
  // backlog and hides them permanently.
  let introducedSincePrev: { count: number; prevSha: string } | undefined
  if (existing) {
    const { isNew } = partitionAgainstBaseline(fingerprints, existing.fingerprints)
    const count = isNew.filter(Boolean).length
    if (count > 0) introducedSincePrev = { count, prevSha: existing.sha }
  }

  file.checkers[checker] = {
    sha,
    capturedAt: new Date().toISOString(),
    fingerprints,
  }
  saveBaselineFile(cwd, file)

  return {
    state: { kind: 'captured', sha, recordedCount: fingerprints.length, introducedSincePrev },
    isNew: allPreexisting(fingerprints.length),
    fixedCount: 0,
  }
}

export function resetBaselineDirectoryCacheForTesting(): void {
  baselineDirCache.clear()
}
