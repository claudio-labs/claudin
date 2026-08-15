/**
 * Health checks for auto-loaded rule files (`.claudin/rules/*.md`) and the
 * project's AGENTS.md / CLAUDE.md.
 *
 * These files are injected into context without any validation, so two failure
 * modes are completely silent today:
 *
 *  - **inert** — `paths:` is handed to the `ignore` (gitignore) library, which
 *    accepts nearly any string. A pattern matching no file leaves the rule
 *    permanently unloaded, and looks exactly like a working rule.
 *  - **silently unconditional** — only `paths` is read, so a rule authored with
 *    `globs:` (the Cursor convention) gets no patterns and falls into the
 *    unconditional lane, loading into every session, every turn.
 *
 * Consumed by `/doctor` (src/platform/doctor/doctorContextWarnings.ts), the
 * `/refresh-rules` skill, and `scripts/rules-check.ts` for CI.
 */
import ignore from 'ignore'
import { execFile } from 'child_process'
import { isAbsolute, join, relative, sep } from 'path'
import { promisify } from 'util'
import { logForDebugging } from 'src/shared/debug.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { inspectRuleFrontmatter } from 'src/memory/instructions/ruleFrontmatter.js'

/** Root-level context files that are loaded without any `paths:` gating. */
const ROOT_CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

const RULES_SUBDIR = join('.claudin', 'rules')

const execFileAsync = promisify(execFile)

/** A hung git must not hang `/doctor` or a CI check. */
const GIT_TIMEOUT_MS = 10_000
/** The 1 MB default caps out around 25k tracked files; large repos exceed it. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024

/** Backtick-delimited spans, the only prose form we treat as a path citation. */
const INLINE_CODE_RE = /`([^`\n]+)`/g

/** Trailing `:12` / `:12-40` line references, and trailing sentence punctuation. */
const LINE_REF_SUFFIX_RE = /:\d+(?:-\d+)?$/
const TRAILING_PUNCT_RE = /[.,;:)\]]+$/

/**
 * Substrings that mark a citation as illustrative rather than a real path:
 * `<Name>` placeholders, globs, home-relative paths, elisions, shell/URL syntax.
 */
const PLACEHOLDER_MARKERS = [
  '<',
  '>',
  '*',
  '~',
  '...',
  '$',
  '|',
  '://',
  ' ',
  'path/to',
]

/**
 * A citation on a line that says the thing is gone is documentation, not rot.
 * AGENTS.md records the removed gRPC service by path on purpose.
 */
const REMOVAL_CONTEXT_RE =
  /\b(removed|deleted|dropped|no longer|used to|formerly|superseded)\b/i

/**
 * TypeScript source imports itself with `.js` specifiers. A citation of
 * `src/platform/config/config.js` names a real file whose extension on disk is `.ts`.
 */
const JS_SPECIFIER_RE = /\.js$/

export type RuleLintFindingKind =
  /** Frontmatter key the loader ignores — the rule silently becomes unconditional. */
  | 'unsupported_key'
  /** `paths:` present but not a string or list of strings. */
  | 'malformed_paths'
  /** `paths:` matches no tracked file — the rule never loads. */
  | 'inert_paths'
  /** A path cited in prose that no longer exists. */
  | 'missing_path'

export type RuleLintFinding = {
  /** Absolute path of the rule file the finding belongs to. */
  file: string
  kind: RuleLintFindingKind
  severity: 'error' | 'warning'
  message: string
  fix: string
}

export type RuleLintResult = {
  findings: RuleLintFinding[]
  /** Rule files with no `paths:`, i.e. loaded into every turn of every session. */
  unconditional: { file: string; chars: number }[]
  unconditionalChars: number
  filesChecked: number
}

export type LintRuleFilesOptions = {
  /** Project root. Defaults to the fs implementation's cwd. */
  root?: string
  /**
   * Repo-relative paths to match `paths:` against. Defaults to `git ls-files`.
   * Injectable so tests and non-git projects do not spawn git.
   */
  trackedFiles?: string[]
}

/**
 * Lists tracked files relative to `root`. Returns null when the directory is
 * not a git repo or git is unavailable — callers must then skip the inert
 * check rather than report every rule as inert.
 */
export async function listTrackedFiles(
  root: string,
): Promise<string[] | null> {
  // Deliberately NOT ./execFileNoThrow.js, for the two reasons documented at
  // src/tools/TypecheckTool/baseline.ts:167 — unrelated suites `mock.module`
  // that specifier for the whole `bun test` run, and it drags in the analytics
  // graph, which makes this module unimportable from `scripts/`. The argv here
  // is a fixed verb plus a caller-supplied cwd, so the wrapper buys nothing.
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.quotepath=false', 'ls-files'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
    )
    return stdout.split('\n').filter(line => line.length > 0)
  } catch (e: unknown) {
    // Not a git repo, or git is unavailable. Reported as "cannot tell" so the
    // caller skips the inert check instead of flagging every rule.
    logForDebugging(`[rulesLint] git ls-files failed in ${root}: ${String(e)}`)
    return null
  }
}

/**
 * True when a citation looks like a real, checkable repo path: relative, with a
 * directory separator, and free of placeholder syntax. Bare filenames are
 * deliberately excluded — `FileReadTool.ts` names a file that does not sit at
 * the root, so resolving it would report a false missing path.
 */
export function isCheckableProsePath(candidate: string): boolean {
  if (candidate.length === 0) return false
  if (PLACEHOLDER_MARKERS.some(marker => candidate.includes(marker))) {
    return false
  }
  if (isAbsolute(candidate)) return false
  if (!candidate.includes('/')) return false
  // `a/b` inside a word like `and/or` is prose, not a path.
  return /^[\w.@-]+(?:\/[\w.@-]+)+\/?$/.test(candidate)
}

/**
 * Resolves a citation against the project, tolerating the `.js`-specifier form.
 * Returns true when the citation names something that exists.
 */
function citationExists(root: string, cited: string): boolean {
  const fs = getFsImplementation()
  if (fs.existsSync(join(root, cited))) return true
  if (!JS_SPECIFIER_RE.test(cited)) return false
  const base = cited.replace(JS_SPECIFIER_RE, '')
  return ['.ts', '.tsx'].some(ext => fs.existsSync(join(root, base + ext)))
}

/**
 * True when the citation's first segment is a real directory at the project
 * root. This is what separates `src/tools/x.ts` from an npm specifier
 * (`react/compiler-runtime`), a flag list (`-A/-B/-C`), prose (`add/rm`) and a
 * path written relative to somewhere else (`RunTestsTool/run.ts`) — none of
 * which the linter can resolve, and all of which would be noise.
 */
function hasProjectAnchor(root: string, cited: string): boolean {
  const firstSegment = cited.split('/')[0]
  if (!firstSegment) return false
  const fs = getFsImplementation()
  const anchor = join(root, firstSegment)
  try {
    return fs.existsSync(anchor) && fs.statSync(anchor).isDirectory()
  } catch {
    return false
  }
}

/** A path citation together with the line it was written on. */
export type ProsePathCitation = { path: string; line: string }

/** Extracts the checkable path citations from a rule file's prose. */
export function extractProsePathCitations(
  content: string,
): ProsePathCitation[] {
  const seen = new Set<string>()
  const citations: ProsePathCitation[] = []
  for (const line of content.split('\n')) {
    for (const match of line.matchAll(INLINE_CODE_RE)) {
      const raw = match[1]
      if (!raw) continue
      const candidate = raw
        .trim()
        .replace(TRAILING_PUNCT_RE, '')
        .replace(LINE_REF_SUFFIX_RE, '')
      if (isCheckableProsePath(candidate) && !seen.has(candidate)) {
        seen.add(candidate)
        citations.push({ path: candidate, line })
      }
    }
  }
  return citations
}

/** Path-only view of {@link extractProsePathCitations}. */
export function extractProsePaths(content: string): string[] {
  return extractProsePathCitations(content).map(c => c.path)
}

/** Recursively collects `.md` files under a directory. Missing dir → []. */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const fs = getFsImplementation()
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
      return []
    }
    throw e
  }

  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath)
    }
  }
  return files.sort()
}

/**
 * Matches a rule's patterns the same way the loader does
 * (src/memory/instructions/claudemd.ts) — via the `ignore` library, against paths relative to
 * the directory containing `.claudin`.
 */
function patternsMatchAnyFile(patterns: string[], files: string[]): boolean {
  const matcher = ignore().add(patterns)
  return files.some(file => {
    // `ignore` rejects absolute paths and paths escaping the base dir.
    if (file.startsWith('..') || isAbsolute(file)) return false
    return matcher.ignores(file)
  })
}

/**
 * Runs every rule-file health check for a project.
 *
 * Never throws for a malformed or unreadable rule: a check that blocks the user
 * is worse than the rot it reports.
 */
export async function lintRuleFiles(
  options: LintRuleFilesOptions = {},
): Promise<RuleLintResult> {
  const fs = getFsImplementation()
  const root = options.root ?? fs.cwd()

  const ruleFiles = await collectMarkdownFiles(join(root, RULES_SUBDIR))
  const rootFiles = ROOT_CONTEXT_FILES.map(name => join(root, name)).filter(
    path => fs.existsSync(path),
  )

  const trackedFiles =
    options.trackedFiles ?? (await listTrackedFiles(root)) ?? null

  const findings: RuleLintFinding[] = []
  const unconditional: { file: string; chars: number }[] = []

  for (const file of [...ruleFiles, ...rootFiles]) {
    let raw: string
    try {
      raw = await fs.readFile(file, { encoding: 'utf8' })
    } catch (e: unknown) {
      logForDebugging(`[rulesLint] unreadable rule file ${file}: ${String(e)}`)
      continue
    }

    const isRootContextFile = !file.includes(`${sep}rules${sep}`)
    const inspection = inspectRuleFrontmatter(raw)

    // Root context files are unconditional by design and take no frontmatter,
    // so only their prose paths are checked.
    if (!isRootContextFile) {
      for (const key of inspection.unsupportedKeys) {
        findings.push({
          file,
          kind: 'unsupported_key',
          severity: 'error',
          message: `frontmatter key \`${key}\` is not supported and is ignored`,
          fix:
            key === 'globs'
              ? 'Rename `globs:` to `paths:` — as written, the rule loads into every session instead of the files you scoped it to.'
              : 'Remove the key. Only `paths` is read; anything else leaves the rule unconditional.',
        })
      }

      if (inspection.malformedPaths) {
        findings.push({
          file,
          kind: 'malformed_paths',
          severity: 'error',
          message: '`paths:` is not a string or a list of strings',
          fix: 'Write `paths: "src/**/*.ts"` or a YAML list of strings.',
        })
      }

      if (!inspection.paths) {
        unconditional.push({ file, chars: raw.length })
      } else if (trackedFiles) {
        if (!patternsMatchAnyFile(inspection.paths, trackedFiles)) {
          findings.push({
            file,
            kind: 'inert_paths',
            severity: 'error',
            message: `\`paths:\` matches no tracked file (${inspection.paths.join(', ')})`,
            fix: 'Fix the patterns. As written the rule never loads, which is indistinguishable from a working rule at runtime.',
          })
        }
      }
    }

    for (const { path: cited, line } of extractProsePathCitations(
      inspection.content,
    )) {
      if (!hasProjectAnchor(root, cited)) continue
      if (citationExists(root, cited)) continue
      if (REMOVAL_CONTEXT_RE.test(line)) continue
      findings.push({
        file,
        kind: 'missing_path',
        severity: 'warning',
        message: `cites \`${cited}\`, which does not exist`,
        fix: 'Update or remove the reference — a rule that names a moved file sends the agent to the wrong place.',
      })
    }
  }

  return {
    findings,
    unconditional,
    unconditionalChars: unconditional.reduce((sum, r) => sum + r.chars, 0),
    filesChecked: ruleFiles.length + rootFiles.length,
  }
}

/** Formats a finding's file as a project-relative path for display. */
export function relativeFindingPath(root: string, file: string): string {
  const rel = relative(root, file)
  return rel.length > 0 && !rel.startsWith('..') ? rel : file
}
