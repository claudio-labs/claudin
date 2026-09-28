/**
 * What the frontmatter of a rule file tells the rule loader, the rules linter
 * and path-scoped memories: the patterns that scope the rule, the keys nothing
 * reads, and whether `paths:` has the wrong shape. A leaf on purpose, so the
 * linter and scripts load it without settings or the file system.
 */
import { z } from 'zod/v4'

import { parseFrontmatter, splitPathInFrontmatter } from 'src/shared/frontmatterParser.js'

export const RULE_FRONTMATTER_SUPPORTED_KEYS: readonly string[] = ['paths']

export type RuleFrontmatterInspection = {
  content: string
  /** Absent when the rule applies everywhere. */
  paths?: string[]
  unsupportedKeys: string[]
  malformedPaths: boolean
}

/** What `paths:` may hold: patterns as text, a list of them, or nothing at all. */
const RulePathsShape = z.union([z.string(), z.array(z.string()), z.null()])

/** `src/**` scopes a rule to `src` as a whole, so one trailing `/**` says nothing. */
const TRAILING_GLOBSTAR_RE = /\/\*\*$/
const MATCHES_EVERYTHING = '**'

export function inspectRuleFrontmatter(rawContent: string): RuleFrontmatterInspection {
  const { frontmatter, content } = parseFrontmatter(rawContent)
  const paths = scopePatterns(frontmatter.paths)
  return {
    content,
    ...(paths === undefined ? {} : { paths }),
    unsupportedKeys: Object.keys(frontmatter).filter(
      key => !RULE_FRONTMATTER_SUPPORTED_KEYS.includes(key),
    ),
    malformedPaths:
      Object.hasOwn(frontmatter, 'paths') && !RulePathsShape.safeParse(frontmatter.paths).success,
  }
}

/**
 * The patterns a `paths:` value scopes the rule to, or `undefined` when it
 * scopes nothing. A list keeps its strings even beside entries of the wrong
 * type: the rule works for the valid patterns, and the linter flags the rest.
 */
function scopePatterns(value: unknown): string[] | undefined {
  const patterns = splitPathInFrontmatter(patternTexts(value))
    .map(pattern => pattern.replace(TRAILING_GLOBSTAR_RE, ''))
    .filter(pattern => pattern !== '')
  return patterns.every(pattern => pattern === MATCHES_EVERYTHING) ? undefined : patterns
}

function patternTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  return []
}
