/**
 * Turns Cursor's `.cursor/rules/**.mdc` into `.claudin/rules/*.md`.
 *
 * Two constraints from our own loader drive the whole translation:
 *
 * 1. **`paths` is the ONLY frontmatter key a rule may set**
 *    (`RULE_FRONTMATTER_SUPPORTED_KEYS`, `src/memory/instructions/ruleFrontmatter.ts:20`).
 *    Carrying Cursor's `description` or `globs` across would each be an *error*
 *    finding in `bun run verify:rules` — and `globs:` specifically produces the
 *    documented Class B failure: the rule gets no patterns, falls into the
 *    unconditional lane, and loads into every session of every turn. So `globs`
 *    becomes `paths`, and `description` moves into the body.
 * 2. **An unconditional rule is a permanent context tax.** Cursor's "Always"
 *    rules genuinely are unconditional and translate cleanly. Its "Agent
 *    Requested" and "Manual" types have no equivalent, and guessing either
 *    scoped or always-on for them would be wrong, so those are refused with a
 *    reason the user can act on.
 */
import { stringify as stringifyYaml } from 'yaml'

import {
  asBoolean,
  asString,
  asStringArray,
} from 'src/platform/import/translate/values.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'

const NON_NAME_CHARS_RE = /[^a-z0-9]+/g
const EDGE_DASHES_RE = /^-+|-+$/g

export type TranslatedRule = {
  name: string
  /** Path under the rules directory. Always flat: `<name>.md`. */
  relativePath: string
  markdown: string
  /** undefined means the rule is deliberately unconditional. */
  paths?: string[]
  notes: string[]
}

export type RuleTranslation =
  | { ok: true; rule: TranslatedRule }
  | { ok: false; reason: string }

export function ruleNameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.mdc?$/i, '').split('/').join('-')
  return base
    .toLowerCase()
    .replace(NON_NAME_CHARS_RE, '-')
    .replace(EDGE_DASHES_RE, '')
}

/**
 * Cursor accepts both a YAML list and an unquoted comma-separated string
 * (`globs: *.ts,*.tsx`), which YAML hands us as one string.
 */
function parseGlobs(raw: unknown): string[] {
  const list = asStringArray(raw)
  if (list) return list.map(g => g.trim()).filter(g => g.length > 0)
  const single = asString(raw)
  if (!single) return []
  return single
    .split(',')
    .map(g => g.trim())
    .filter(g => g.length > 0)
}

export function translateCursorRule(
  fileName: string,
  source: string,
): RuleTranslation {
  const name = ruleNameFromFileName(fileName)
  if (!name) return { ok: false, reason: 'filename yields an empty rule name' }

  const { frontmatter, content } = parseFrontmatter(source)
  if (content.trim().length === 0) {
    return { ok: false, reason: 'has no body' }
  }

  const alwaysApply = asBoolean(frontmatter.alwaysApply) === true
  const globs = parseGlobs(frontmatter.globs)
  const description = asString(frontmatter.description)

  if (!alwaysApply && globs.length === 0) {
    return {
      ok: false,
      reason: description
        ? 'is a Cursor "Agent Requested" rule (a description with no globs), which has no Claudin equivalent — a skill is the closest fit'
        : 'is a Cursor "Manual" rule (no globs, no alwaysApply), which is only ever loaded by an explicit @-mention',
    }
  }

  const notes: string[] = []
  // alwaysApply wins: a Cursor rule marked always-on is unconditional even if
  // it also carries globs, and encoding the globs would narrow it.
  const paths = alwaysApply ? undefined : globs
  if (alwaysApply) {
    notes.push(
      globs.length > 0
        ? 'alwaysApply overrides its globs — imported unconditional, so it loads every turn'
        : 'imported unconditional, so it loads every turn',
    )
  } else {
    notes.push('globs translated to paths')
  }
  if (description) {
    notes.push('description moved into the body — rules take no other frontmatter')
  }

  const body = description ? `${description}\n\n${content.trim()}` : content.trim()
  const markdown = paths
    ? `---\n${stringifyYaml({ paths }).trimEnd()}\n---\n\n${body}\n`
    : `${body}\n`

  return {
    ok: true,
    rule: {
      name,
      relativePath: `${name}.md`,
      markdown,
      ...(paths ? { paths } : {}),
      notes,
    },
  }
}
