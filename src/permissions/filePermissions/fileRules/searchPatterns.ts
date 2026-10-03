import { posix } from 'path'
import { relativePath } from 'src/shared/fs/path.js'
import { anchorPattern } from 'src/permissions/filePermissions/fileRules/anchoredPattern.js'
import type { RuleAnchors } from 'src/permissions/filePermissions/fileRules/anchors.js'
import type { FileRule } from 'src/permissions/filePermissions/fileRules/ruleSelection.js'

const WHOLE_TREE = '/**'
const WHOLE_TREE_PREFIX = '/**/'

/** Each rule's pattern under its anchor, keyed in order of first appearance, without repeats. */
export function patternsByAnchor(
  rules: readonly FileRule[],
  anchors: RuleAnchors,
): Map<string | null, string[]> {
  const byAnchor = new Map<string | null, string[]>()
  for (const { rule, text } of rules) {
    const { anchor, body } = anchorPattern(text, rule.source, anchors)
    const bodies = byAnchor.get(anchor) ?? []
    if (!bodies.includes(body)) bodies.push(body)
    byAnchor.set(anchor, bodies)
  }
  return byAnchor
}

/**
 * The patterns rewritten for a search rooted at `root`: unanchored ones first
 * as they are, then each anchored one moved onto `root`, or left out when it
 * cannot reach inside it.
 */
export function patternsForSearchRoot(
  byAnchor: ReadonlyMap<string | null, readonly string[]>,
  root: string,
): string[] {
  const out = new Set<string>(byAnchor.get(null) ?? [])
  for (const [anchor, patterns] of byAnchor) {
    if (anchor === null) continue
    for (const pattern of patterns) {
      const moved = moveOntoRoot(pattern, anchor, root)
      if (moved !== null) out.add(moved)
    }
  }
  return [...out]
}

function moveOntoRoot(pattern: string, anchor: string, root: string): string | null {
  const body = pattern.startsWith('/') ? pattern : `/${pattern}`
  const anchorFromRoot = relativePath(root, anchor)
  if (anchorFromRoot === '') return body
  if (isDescent(anchorFromRoot)) return `/${anchorFromRoot}${body}`
  const rootFromAnchor = relativePath(anchor, root)
  if (!isDescent(rootFromAnchor)) return null
  return insideRoot(body, `/${rootFromAnchor}`)
}

/** The part of an anchored-above pattern that lies inside the root, written from the root. */
function insideRoot(body: string, rootPrefix: string): string | null {
  if (body.startsWith(`${rootPrefix}/`)) return body.slice(rootPrefix.length)
  // Naming the root itself covers the whole search, and so does a pattern
  // that reaches every depth below the anchor.
  if (body === rootPrefix) return WHOLE_TREE
  if (body === WHOLE_TREE || body.startsWith(WHOLE_TREE_PREFIX)) return body
  return null
}

function isDescent(relative: string): boolean {
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('../') &&
    !posix.isAbsolute(relative)
  )
}
