/**
 * The structural pass of the memory audit: how memories point at each other,
 * judged without a model. The index is the only part of a memory directory
 * always in context, so a memory is found by following links from it — an
 * index line `](file.md)`, or a `[[name]]` inside a memory — and three things
 * go wrong silently:
 *
 * - `broken-link`: a link its reader cannot follow. A `[[name]]` matches a
 *   file's stem or its frontmatter `name`, among the memories its reader can
 *   see: a team memory only team ones (a teammate has no copy of yours), a
 *   global one only global ones (another project has no copy of this one's),
 *   a private one all three — so it is broken when it matches only a memory
 *   outside those. One matching no memory at all is a forward link, which the
 *   memory prompts invite ("a link to a memory not written yet is fine"), and
 *   not a finding. A `](file.md)` is broken when the file is missing; it is
 *   checked inside its own directory only, as a target outside it
 *   (`../../skills/…`) is not a memory.
 * - `unindexed`: a memory no chain of links from its index reaches, and with
 *   no `paths:` to attach it — nothing will ever bring it into context.
 * - `duplicate-name`: two memories of one directory sharing a `name`, which
 *   makes a `[[name]]` to either ambiguous.
 *
 * Text inside code spans and fences is not a link: a memory that explains
 * the `[[name]]` syntax links nowhere. Report-only — none of these fails the
 * audit's gate (memoryAudit.ts). Pure over the files it is handed.
 */
import { basename, dirname, relative, resolve, sep } from 'path'
import type { AuditedFile } from 'src/memory/memdir/memoryAudit.js'
import type { MemoryDir } from 'src/memory/memdir/memoryDirs.js'
import { ENTRYPOINT_NAME, INDEX_LINK_TARGET_RE, type MemoryScope } from 'src/memory/memdir/memoryScopes.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'

type BrokenLinkFinding = {
  kind: 'broken-link'
  scope: MemoryScope
  path: string
  /** The link as written: `[[name]]` or `file.md`. */
  target: string
}

type UnindexedFinding = {
  kind: 'unindexed'
  scope: MemoryScope
  path: string
}

type DuplicateNameFinding = {
  kind: 'duplicate-name'
  scope: MemoryScope
  path: string
  name: string
}

export type LinkFinding = BrokenLinkFinding | UnindexedFinding | DuplicateNameFinding

const FENCED_CODE_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`[^`\n]*`/g
const WIKI_LINK_RE = /\[\[([^\]\n]+)\]\]/g
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** Which scopes' memories a `[[name]]` written in each scope can reach. */
const VISIBLE_SCOPES: Readonly<Record<MemoryScope, readonly MemoryScope[]>> = {
  team: ['team'],
  global: ['global'],
  private: ['private', 'team', 'global'],
}

type Memory = AuditedFile & { name: string | null; hasPaths: boolean; links: string }

function nameOf(frontmatter: Record<string, unknown>): string | null {
  return typeof frontmatter.name === 'string' && frontmatter.name.trim() !== '' ? frontmatter.name.trim() : null
}

function readMemory(file: AuditedFile): Memory {
  const { frontmatter } = parseFrontmatter(file.content)
  return {
    ...file,
    name: nameOf(frontmatter),
    hasPaths: frontmatter.paths !== undefined && frontmatter.paths !== null,
    links: file.content.replace(FENCED_CODE_RE, '').replace(INLINE_CODE_RE, ''),
  }
}

const isIndex = (path: string): boolean => basename(path) === ENTRYPOINT_NAME

/** The memories of `dir` (its index included): the team dir with its subdirectories, the others flat. */
function memoriesOf(dir: MemoryDir, memories: readonly Memory[]): Memory[] {
  return memories.filter(m => m.scope === dir.scope && m.path.startsWith(dir.root))
}

function keyMap(memories: readonly Memory[]): Map<string, Memory> {
  const keys = new Map<string, Memory>()
  for (const memory of memories) {
    if (isIndex(memory.path)) continue
    keys.set(basename(memory.path, '.md'), memory)
    if (memory.name !== null) keys.set(memory.name, memory)
  }
  return keys
}

/**
 * The `.md` file a markdown link points at, when it is one this directory
 * holds: absolute, inside the root, and — outside the team dir, which keeps
 * category subdirectories — directly in it. Null for anything else.
 */
function markdownTarget(dir: MemoryDir, from: string, raw: string): string | null {
  const target = raw.split('#')[0]!
  if (!target.endsWith('.md') || URL_SCHEME_RE.test(target)) return null
  const abs = resolve(dirname(from), target)
  if (!abs.startsWith(dir.root)) return null
  if (dir.scope !== 'team' && relative(dir.root, abs).includes(sep)) return null
  return abs
}

export function findLinkFindings(files: readonly AuditedFile[], dirs: readonly MemoryDir[]): LinkFinding[] {
  const memories = files.map(readMemory)
  const findings: LinkFinding[] = []
  for (const dir of dirs) {
    const own = memoriesOf(dir, memories)
    const ownPaths = new Set(own.map(m => m.path))
    const ownKeys = keyMap(own)
    const visibleKeys = keyMap(
      dirs
        .filter(other => VISIBLE_SCOPES[dir.scope].includes(other.scope))
        .flatMap(other => memoriesOf(other, memories)),
    )
    const anyKeys = keyMap(dirs.flatMap(other => memoriesOf(other, memories)))

    // Every link of every file, resolved once: what it reaches in this directory, and what resolves nowhere.
    const edges = new Map<string, string[]>()
    for (const memory of own) {
      const reached: string[] = []
      const broken = new Set<string>()
      for (const match of memory.links.matchAll(WIKI_LINK_RE)) {
        const key = match[1]!.trim()
        const hit = ownKeys.get(key)
        if (hit !== undefined) reached.push(hit.path)
        else if (!visibleKeys.has(key) && anyKeys.has(key)) broken.add(`[[${key}]]`)
      }
      for (const match of memory.links.matchAll(INDEX_LINK_TARGET_RE)) {
        const abs = markdownTarget(dir, memory.path, match[1]!)
        if (abs === null) continue
        if (ownPaths.has(abs)) reached.push(abs)
        else broken.add(match[1]!)
      }
      edges.set(memory.path, reached)
      for (const target of broken) findings.push({ kind: 'broken-link', scope: dir.scope, path: memory.path, target })
    }

    const reachable = new Set<string>()
    const queue = own.filter(m => m.path === dir.index).map(m => m.path)
    while (queue.length > 0) {
      const path = queue.pop()!
      if (reachable.has(path)) continue
      reachable.add(path)
      queue.push(...(edges.get(path) ?? []))
    }
    for (const memory of own) {
      if (!isIndex(memory.path) && !reachable.has(memory.path) && !memory.hasPaths) {
        findings.push({ kind: 'unindexed', scope: dir.scope, path: memory.path })
      }
    }

    const byName = new Map<string, Memory[]>()
    for (const memory of own) {
      if (memory.name === null || isIndex(memory.path)) continue
      byName.set(memory.name, [...(byName.get(memory.name) ?? []), memory])
    }
    for (const [name, same] of byName) {
      if (same.length < 2) continue
      for (const memory of same) findings.push({ kind: 'duplicate-name', scope: dir.scope, path: memory.path, name })
    }
  }
  return findings
}
