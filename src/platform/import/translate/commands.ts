/**
 * Turns another agent's custom prompts into `.claudin/commands/*.md`.
 *
 * Three source shapes reach here: plain markdown with no frontmatter (Codex
 * prompts), markdown with frontmatter (Qwen, opencode) and a TOML table
 * (Gemini, and Qwen's deprecated-but-still-read form). What varies between
 * them is which frontmatter keys mean anything to us and how a command refers
 * to its arguments, so each source names a `CommandDialect` rather than
 * passing booleans that a caller can forget.
 */
import { stringify as stringifyYaml } from 'yaml'

import {
  asString,
  type JsonTable,
} from 'src/platform/import/translate/values.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'

/** Gemini and Qwen write `{{args}}` where Claudin reads `$ARGUMENTS`. */
const HANDLEBARS_ARGS_RE = /\{\{\s*args\s*\}\}/g
/** Gemini's inline shell and file injections, which have no equivalent here. */
const GEMINI_SHELL_INJECTION_RE = /!\{[^}]*\}/
const GEMINI_FILE_INJECTION_RE = /@\{[^}]*\}/
const UNSAFE_RELATIVE_PATH_RE = /(^|\/)\.\.(\/|$)/

export type ArgumentDialect =
  /** `$ARGUMENTS`, `$1`, `$ARGUMENTS[0]` — the same forms Claudin substitutes. */
  | 'claude'
  /** `{{args}}`, rewritten on import. */
  | 'handlebars'

export type CommandDialect = {
  /** Frontmatter keys carried over. Everything else is dropped and reported. */
  keepKeys: readonly string[]
  args: ArgumentDialect
}

/**
 * Codex prompts are plain markdown and already use `$ARGUMENTS` / `$1`, so
 * they cross over unchanged.
 */
export const CODEX_PROMPT_DIALECT: CommandDialect = {
  keepKeys: ['description', 'argument-hint'],
  args: 'claude',
}

/** Qwen's current markdown commands: a `description`, a `{{args}}` body. */
export const QWEN_COMMAND_DIALECT: CommandDialect = {
  keepKeys: ['description'],
  args: 'handlebars',
}

/**
 * opencode commands. `agent`, `model` and `subtask` are deliberately NOT kept:
 * an opencode model id (`anthropic/opus`) is not one of ours, and an `agent`
 * name points at a subagent that may not have been imported.
 */
export const OPENCODE_COMMAND_DIALECT: CommandDialect = {
  keepKeys: ['description'],
  args: 'claude',
}

// Claude Code and openclaude need no dialect at all: they write our own file
// formats, so `collectVerbatimMarkdown` copies their commands byte for byte
// rather than round-tripping frontmatter we would only re-emit unchanged.

export type TranslatedCommand = {
  /** Path under the commands directory, e.g. `git/commit.md`. */
  relativePath: string
  /** How the user invokes it, e.g. `git:commit`. */
  name: string
  markdown: string
  /** Judgement calls worth surfacing in the report. */
  notes: string[]
}

export type CommandTranslation =
  | { ok: true; command: TranslatedCommand }
  | { ok: false; reason: string }

function withoutExtension(relativePath: string): string {
  const lastDot = relativePath.lastIndexOf('.')
  const lastSlash = relativePath.lastIndexOf('/')
  return lastDot > lastSlash ? relativePath.slice(0, lastDot) : relativePath
}

/**
 * `git/commit.toml` → `git:commit`, matching how both Gemini and Claudin
 * namespace a command that lives in a subdirectory.
 */
export function commandNameFromRelativePath(relativePath: string): string {
  return withoutExtension(relativePath).split('/').join(':')
}

export function commandDestinationPath(relativePath: string): string {
  return `${withoutExtension(relativePath)}.md`
}

function renderCommandFile(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const trimmedBody = body.trim()
  if (Object.keys(frontmatter).length === 0) {
    return `${trimmedBody}\n`
  }
  const yaml = stringifyYaml(frontmatter).trimEnd()
  return `---\n${yaml}\n---\n\n${trimmedBody}\n`
}

function rewriteArguments(
  body: string,
  dialect: ArgumentDialect,
): { body: string; rewritten: boolean } {
  if (dialect !== 'handlebars') return { body, rewritten: false }
  const rewritten = body.replace(HANDLEBARS_ARGS_RE, '$ARGUMENTS')
  return { body: rewritten, rewritten: rewritten !== body }
}

function injectionNotes(body: string): string[] {
  const notes: string[] = []
  if (GEMINI_SHELL_INJECTION_RE.test(body)) {
    notes.push('uses !{…} shell injection, which Claudin does not expand')
  }
  if (GEMINI_FILE_INJECTION_RE.test(body)) {
    notes.push('uses @{…} file injection, which Claudin does not expand')
  }
  return notes
}

function rejectUnsafePath(relativePath: string): string | null {
  if (relativePath.length === 0) return 'has an empty path'
  if (relativePath.startsWith('/')) return 'has an absolute path'
  if (UNSAFE_RELATIVE_PATH_RE.test(relativePath)) {
    return 'path escapes the commands directory'
  }
  return null
}

export function translateMarkdownCommand(
  relativePath: string,
  source: string,
  dialect: CommandDialect,
): CommandTranslation {
  const unsafe = rejectUnsafePath(relativePath)
  if (unsafe) return { ok: false, reason: unsafe }

  const { frontmatter, content } = parseFrontmatter(source)
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) continue
    if (dialect.keepKeys.includes(key)) {
      kept[key] = value
    } else {
      dropped.push(key)
    }
  }

  const { body, rewritten } = rewriteArguments(content, dialect.args)
  if (body.trim().length === 0) {
    return { ok: false, reason: 'has no prompt body' }
  }

  const notes = injectionNotes(body)
  if (dropped.length > 0) {
    notes.push(`dropped frontmatter: ${dropped.sort().join(', ')}`)
  }
  if (rewritten) {
    notes.push('rewrote {{args}} as $ARGUMENTS')
  }

  return {
    ok: true,
    command: {
      relativePath: commandDestinationPath(relativePath),
      name: commandNameFromRelativePath(relativePath),
      markdown: renderCommandFile(kept, body),
      notes,
    },
  }
}

/**
 * Gemini's `commands/**.toml`: a required `prompt` and an optional
 * `description`, which become the body and the frontmatter respectively.
 */
export function translateTomlCommand(
  relativePath: string,
  table: JsonTable,
): CommandTranslation {
  const unsafe = rejectUnsafePath(relativePath)
  if (unsafe) return { ok: false, reason: unsafe }

  const prompt = asString(table.prompt)
  if (!prompt) return { ok: false, reason: 'has no prompt field' }

  const { body, rewritten } = rewriteArguments(prompt, 'handlebars')
  const description = asString(table.description)
  const notes = injectionNotes(body)
  if (rewritten) notes.push('rewrote {{args}} as $ARGUMENTS')

  return {
    ok: true,
    command: {
      relativePath: commandDestinationPath(relativePath),
      name: commandNameFromRelativePath(relativePath),
      markdown: renderCommandFile(
        description ? { description } : {},
        body,
      ),
      notes,
    },
  }
}
