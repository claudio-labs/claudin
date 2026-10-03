import ignore from 'ignore'
import { posix } from 'path'
import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import { windowsPathToPosixPath } from 'src/shared/fs/windowsPaths.js'
import { anchorPattern } from 'src/permissions/filePermissions/fileRules/anchoredPattern.js'
import type { RuleAnchors } from 'src/permissions/filePermissions/fileRules/anchors.js'
import type { FileRule, RuleBehavior } from 'src/permissions/filePermissions/fileRules/ruleSelection.js'

const WHOLE_TREE_SUFFIX = '/**'
const NEGATION = '!'

type CompiledRule = { readonly rule: PermissionRule; readonly gitignore: string }

/**
 * The rule among `rules` whose pattern covers the absolute `path`, or null.
 * Pure: the anchors come in, nothing is read from the session or the disk,
 * and no path, however placed, makes it throw.
 */
export function findCoveringRule(
  path: string,
  rules: readonly FileRule[],
  anchors: RuleAnchors,
  behavior: RuleBehavior,
): PermissionRule | null {
  for (const [anchor, group] of groupByAnchor(rules, anchors, behavior)) {
    const below = pathBelow(anchor ?? anchors.currentDir, path, anchors.windows)
    if (below === null) continue
    const hit = coveringRuleIn(group, below)
    if (hit) return hit
  }
  return null
}

function groupByAnchor(
  rules: readonly FileRule[],
  anchors: RuleAnchors,
  behavior: RuleBehavior,
): Map<string | null, CompiledRule[]> {
  const groups = new Map<string | null, CompiledRule[]>()
  for (const { rule, text } of rules) {
    const { anchor, body } = anchorPattern(text, rule.source, anchors)
    const gitignore = toGitignore(body, behavior)
    if (gitignore === null) continue
    const group = groups.get(anchor) ?? []
    group.push({ rule, gitignore })
    groups.set(anchor, group)
  }
  return groups
}

/**
 * A trailing `/**` is cut to the directory, so the directory itself is covered
 * and an unanchored `dir/**` matches at any depth (F7, pinned). The whole
 * anchor (`/**` once anchored) covers everything below it for deny and ask
 * (F1), and nothing for allow (F1, pinned).
 */
function toGitignore(body: string, behavior: RuleBehavior): string | null {
  if (!body.endsWith(WHOLE_TREE_SUFFIX)) return body
  const dir = body.slice(0, -WHOLE_TREE_SUFFIX.length)
  if (dir !== '' && dir !== NEGATION) return dir
  return behavior === 'allow' ? null : `${dir}**`
}

/**
 * The path relative to `base`, or null when it is `base` itself or lies
 * outside it. The matcher refuses both (a RangeError for `..`, F3), and
 * neither is ever covered.
 */
function pathBelow(base: string, path: string, windows: boolean): string | null {
  const from = windows ? windowsPathToPosixPath(base) : base
  const to = windows ? windowsPathToPosixPath(path) : path
  const relative = posix.relative(from, to)
  const outside =
    relative === '' || relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)
  return outside ? null : relative
}

function coveringRuleIn(group: readonly CompiledRule[], below: string): PermissionRule | null {
  if (!matches(group.map(entry => entry.gitignore), below)) return null
  // gitignore lets the last matching line decide, so report the last positive
  // line that matches on its own.
  for (let i = group.length - 1; i >= 0; i--) {
    const entry = group[i]
    if (!entry || entry.gitignore.startsWith(NEGATION)) continue
    if (matches([entry.gitignore], below)) return entry.rule
  }
  return null
}

function matches(patterns: readonly string[], below: string): boolean {
  return ignore({ ignorecase: true }).add([...patterns]).ignores(below)
}
