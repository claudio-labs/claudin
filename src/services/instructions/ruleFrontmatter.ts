/**
 * Frontmatter handling for auto-loaded rule files.
 *
 * Deliberately a leaf module: the rule loader (src/services/instructions/claudemd.ts) pulls in
 * analytics, settings and the fs abstraction, so anything that only needs to
 * understand rule frontmatter — the linter, `scripts/rules-check.ts` — imports
 * this instead and stays cheap.
 */
import { z } from 'zod/v4'
import {
  parseFrontmatter,
  splitPathInFrontmatter,
} from 'src/shared/frontmatterParser.js'

/**
 * The only frontmatter key a rule file may set. Anything else is ignored by the
 * loader, which is why authoring `globs:` (the Cursor convention) silently turns
 * a scoped rule into an unconditional one — see inspectRuleFrontmatter.
 */
export const RULE_FRONTMATTER_SUPPORTED_KEYS: readonly string[] = ['paths']

const RulePathsSchema = z
  .union([z.string(), z.array(z.string()), z.null()])
  .optional()

export type RuleFrontmatterInspection = {
  content: string
  /** Normalized patterns, or undefined when the rule is unconditional. */
  paths?: string[]
  /** Keys present in the frontmatter that the loader ignores entirely. */
  unsupportedKeys: string[]
  /** Set when `paths` was present but not a string or list of strings. */
  malformedPaths: boolean
}

/**
 * Parses rule frontmatter and reports what the loader will actually do with it.
 *
 * Beyond the `paths` normalization the loader needs, this reports the two
 * conditions that are otherwise invisible at runtime: frontmatter keys that are
 * silently ignored, and a `paths` value of the wrong shape (which
 * splitPathInFrontmatter quietly reduces to an empty list).
 */
export function inspectRuleFrontmatter(
  rawContent: string,
): RuleFrontmatterInspection {
  const { frontmatter, content } = parseFrontmatter(rawContent)

  const unsupportedKeys = Object.keys(frontmatter).filter(
    key => !RULE_FRONTMATTER_SUPPORTED_KEYS.includes(key),
  )
  const malformedPaths =
    frontmatter.paths !== undefined &&
    !RulePathsSchema.safeParse(frontmatter.paths).success

  if (!frontmatter.paths) {
    return { content, unsupportedKeys, malformedPaths }
  }

  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map(pattern => {
      // Remove /** suffix - ignore library treats 'path' as matching both
      // the path itself and everything inside it
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)

  // If all patterns are ** (match-all), treat as no globs (undefined)
  // This means the file applies to all paths
  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) {
    return { content, unsupportedKeys, malformedPaths }
  }

  return { content, paths: patterns, unsupportedKeys, malformedPaths }
}
