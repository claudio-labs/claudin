/**
 * The deterministic pass over the memory directories: what no model has to
 * judge. It finds secret-shaped content in the team dir — git-tracked, so a
 * credential there reaches every teammate's next pull, whoever wrote it: the
 * file tools refuse one (teamMemSecretGuard.ts), but a human, another agent
 * or an editor writes past them — characters there that hide text from the
 * commit's reviewer (hiddenText.ts), and memories past their `expires:` date
 * (memoryExpires.ts), to be re-verified, never deleted — and, in every
 * scope, links that resolve to nothing, memories nothing reaches from their
 * index, and shared names (memoryLinks.ts), and what lets memory grow
 * uncleaned — near-duplicates, a user memory outside the global dir, open
 * contradictions, an index over its cap, an oversized memory
 * (memoryHygiene.ts) — reported and never failing.
 *
 * One auditor and several readers — `claudin memory audit` (the CI and
 * pre-commit gate of any repo carrying a team dir), `/memory tidy`, the dream
 * digest — so none of them scans on its own. The core is pure over the files
 * it is handed; readMemoryFiles is the thin I/O shell.
 */
import { readdir, readFile } from 'fs/promises'
import { basename, join, relative } from 'path'
import type { MemoryDir } from 'src/memory/memdir/memoryDirs.js'
import { findHiddenText } from 'src/memory/memdir/hiddenText.js'
import { expiresOf, isExpired, localDay } from 'src/memory/memdir/memoryExpires.js'
import { findHygieneFindings, type HygieneFinding } from 'src/memory/memdir/memoryHygiene.js'
import { findLinkFindings, type LinkFinding } from 'src/memory/memdir/memoryLinks.js'
import { ENTRYPOINT_NAME, type MemoryScope } from 'src/memory/memdir/memoryScopes.js'
import { scanForSecrets } from 'src/memory/memdir/secretScanner.js'
import { isENOENT } from 'src/shared/errors.js'

export type AuditedFile = {
  scope: MemoryScope
  /** Absolute. */
  path: string
  content: string
}

export type SecretFinding = {
  kind: 'secret'
  path: string
  /** The scanner's labels, once each ("GitHub PAT"). */
  labels: string[]
}

type HiddenTextFinding = {
  kind: 'hidden-text'
  path: string
  /** What it hides, once each ("bidi control"). */
  labels: string[]
}

export type ExpiredFinding = {
  kind: 'expired'
  scope: MemoryScope
  path: string
  /** The `expires:` date that has passed. */
  expires: string
}

type MemoryFinding = SecretFinding | HiddenTextFinding | ExpiredFinding | LinkFinding | HygieneFinding

export type MemoryAudit = {
  /** How many files were read. */
  files: number
  findings: MemoryFinding[]
}

/** The team files whose content the secret scanner matches. */
export function findSecretShapedFiles(files: readonly AuditedFile[]): SecretFinding[] {
  return files.flatMap(file => {
    if (file.scope !== 'team') return []
    const labels = [...new Set(scanForSecrets(file.content).map(match => match.label))]
    return labels.length > 0 ? [{ kind: 'secret' as const, path: file.path, labels }] : []
  })
}

/** The team files holding characters that hide text from whoever reviews the commit. */
function findHiddenTextFiles(files: readonly AuditedFile[]): HiddenTextFinding[] {
  return files.flatMap(file => {
    if (file.scope !== 'team') return []
    const labels = findHiddenText(file.content)
    return labels.length > 0 ? [{ kind: 'hidden-text' as const, path: file.path, labels }] : []
  })
}

/** The memory files whose `expires:` date is before `today`; indexes have none. */
export function findExpiredMemories(files: readonly AuditedFile[], today: string): ExpiredFinding[] {
  return files.flatMap(file => {
    if (basename(file.path) === ENTRYPOINT_NAME) return []
    const expires = expiresOf(file.content)
    return expires !== null && isExpired(expires, today)
      ? [{ kind: 'expired' as const, scope: file.scope, path: file.path, expires }]
      : []
  })
}

/** Whether an audit should fail a gate: a secret or hidden text anywhere it found one. An expired memory never does — a gate that goes red on a calendar day, with no change, is a gate nobody keeps. */
export function auditFails(audit: MemoryAudit): boolean {
  return audit.findings.some(finding => finding.kind === 'secret' || finding.kind === 'hidden-text')
}

export type MemoryAuditDeps = {
  /** Every `.md` FILE under `root`, relative to it; [] when it does not exist. */
  listMarkdown(root: string, recursive: boolean): Promise<string[]>
  read(path: string): Promise<string>
}

/**
 * Regular files only: a directory named `x.md` or a symlink — dangling, or
 * pointing at content that is not what the repository commits — has nothing
 * to scan, and reading one threw out of the audit.
 */
async function listMarkdown(root: string, recursive: boolean): Promise<string[]> {
  try {
    return (await readdir(root, { recursive, withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => relative(root, join(entry.parentPath, entry.name)))
  } catch (e) {
    if (isENOENT(e)) return []
    throw e
  }
}

const defaultDeps: MemoryAuditDeps = {
  listMarkdown,
  read: path => readFile(path, 'utf8'),
}

/**
 * Every markdown file of `dirs`, the indexes included — a secret in an index
 * line is as shared as one in a memory. The team dir is read with its
 * category subdirectories; the private one without the team dir nested in it.
 */
export async function readMemoryFiles(
  dirs: readonly MemoryDir[],
  deps: MemoryAuditDeps = defaultDeps,
): Promise<AuditedFile[]> {
  const files: AuditedFile[] = []
  for (const dir of dirs) {
    const names = await deps.listMarkdown(dir.root, dir.scope === 'team')
    for (const name of names.sort()) {
      const path = join(dir.root, name)
      files.push({ scope: dir.scope, path, content: await deps.read(path) })
    }
  }
  return files
}

export async function auditMemoryDirs(
  dirs: readonly MemoryDir[],
  deps: MemoryAuditDeps = defaultDeps,
  today: string = localDay(),
): Promise<MemoryAudit> {
  const files = await readMemoryFiles(dirs, deps)
  return {
    files: files.length,
    findings: [
      ...findSecretShapedFiles(files),
      ...findHiddenTextFiles(files),
      ...findExpiredMemories(files, today),
      ...findLinkFindings(files, dirs),
      ...findHygieneFindings(files, dirs),
    ],
  }
}
