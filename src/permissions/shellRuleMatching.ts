/**
 * The grammar of a shell permission rule body: classify it, match a wildcard
 * body against a command string, and build "always allow" suggestions.
 *
 * Pure string work with no shell awareness. Splitting compound commands and
 * stripping wrappers happen in the callers before they reach the matcher.
 */
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'

export type ShellPermissionRule =
  | {
      type: 'exact'
      command: string
    }
  | {
      type: 'prefix'
      prefix: string
    }
  | {
      type: 'wildcard'
      pattern: string
    }

const LEGACY_PREFIX_SUFFIX = ':*'
const BACKSLASH = '\\'
const STAR = '*'
const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|/-]/g

export function permissionRuleExtractPrefix(
  permissionRule: string,
): string | null {
  const head = permissionRule.length - LEGACY_PREFIX_SUFFIX.length
  if (head < 1 || !permissionRule.endsWith(LEGACY_PREFIX_SUFFIX)) return null
  return permissionRule.slice(0, head)
}

function backslashesBefore(text: string, index: number): number {
  let count = 0
  for (let at = index - 1; at >= 0 && text[at] === BACKSLASH; at--) count++
  return count
}

export function hasWildcards(pattern: string): boolean {
  if (pattern.endsWith(LEGACY_PREFIX_SUFFIX)) return false
  for (let at = pattern.indexOf(STAR); at !== -1; at = pattern.indexOf(STAR, at + 1)) {
    if (backslashesBefore(pattern, at) % 2 === 0) return true
  }
  return false
}

type PatternPiece = { kind: 'literal'; text: string } | { kind: 'any' }

/** Reads `\*` as a literal star and `\\` as a literal backslash; every other character stands for itself. */
function splitPattern(pattern: string): PatternPiece[] {
  const pieces: PatternPiece[] = []
  let literal = ''
  const flushLiteral = (): void => {
    if (literal) pieces.push({ kind: 'literal', text: literal })
    literal = ''
  }
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]!
    const next = pattern[at + 1]
    if (char === BACKSLASH && (next === STAR || next === BACKSLASH)) {
      literal += next
      at++
    } else if (char === STAR) {
      flushLiteral()
      pieces.push({ kind: 'any' })
    } else {
      literal += char
    }
  }
  flushLiteral()
  return pieces
}

const toRegexLiteral = (text: string): string => text.replace(REGEX_SPECIAL, ch => BACKSLASH + ch)
const ANY_RUN = '[\\s\\S]*'

/**
 * `git *` also covers a bare `git`: with a single star sitting at the end
 * behind a space, the space and the star become one optional group.
 */
function optionalTailStart(pieces: PatternPiece[]): number | null {
  const stars = pieces.filter(piece => piece.kind === 'any').length
  const last = pieces[pieces.length - 1]
  const beforeLast = pieces[pieces.length - 2]
  if (stars !== 1 || last?.kind !== 'any' || beforeLast?.kind !== 'literal') return null
  return beforeLast.text.endsWith(' ') ? pieces.length - 2 : null
}

function compileWildcard(pattern: string, caseInsensitive: boolean): RegExp {
  const pieces = splitPattern(pattern.trim())
  const tailAt = optionalTailStart(pieces)
  let source = ''
  pieces.forEach((piece, index) => {
    if (index === tailAt && piece.kind === 'literal') {
      source += `${toRegexLiteral(piece.text.slice(0, -1))}(?: ${ANY_RUN})?`
    } else if (tailAt === null || index < tailAt) {
      source += piece.kind === 'any' ? ANY_RUN : toRegexLiteral(piece.text)
    }
  })
  return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '')
}

// Rules are few and checked on every command, so the compiled forms are kept.
// The bound only guards against a pathological rule set.
const COMPILED_LIMIT = 512
const compiled = new Map<string, RegExp>()

function compiledWildcard(pattern: string, caseInsensitive: boolean): RegExp {
  const key = `${caseInsensitive ? 'i' : 's'}:${pattern}`
  let regex = compiled.get(key)
  if (!regex) {
    if (compiled.size >= COMPILED_LIMIT) compiled.clear()
    regex = compileWildcard(pattern, caseInsensitive)
    compiled.set(key, regex)
  }
  return regex
}

export function matchWildcardPattern(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  return compiledWildcard(pattern, caseInsensitive).test(command)
}

export function parsePermissionRule(
  permissionRule: string,
): ShellPermissionRule {
  const prefix = permissionRuleExtractPrefix(permissionRule)
  if (prefix !== null) return { type: 'prefix', prefix }
  if (hasWildcards(permissionRule)) return { type: 'wildcard', pattern: permissionRule }
  return { type: 'exact', command: permissionRule }
}

function localAllowRule(toolName: string, ruleContent: string): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      rules: [{ toolName, ruleContent }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ]
}

export function suggestionForExactCommand(
  toolName: string,
  command: string,
): PermissionUpdate[] {
  return localAllowRule(toolName, command)
}

export function suggestionForPrefix(
  toolName: string,
  prefix: string,
): PermissionUpdate[] {
  return localAllowRule(toolName, prefix + LEGACY_PREFIX_SUFFIX)
}
