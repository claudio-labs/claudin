/**
 * Turns another agent's subagent definitions into `.claudin/agents/*.md`.
 *
 * The load-bearing detail here is what we DON'T carry over. A Claudin agent
 * file is silently ignored unless its frontmatter has both `name` and
 * `description` (`parseAgentFromMarkdown`, `src/tools/AgentTool/loadAgentsDir.ts:548`),
 * so a definition missing a description is refused rather than written as a
 * file that would quietly load as nothing. And `tools` is dropped on purpose:
 * opencode and Qwen name their tools differently from us, so importing their
 * list verbatim would not restrict the agent, it would leave it with none.
 */
import { stringify as stringifyYaml } from 'yaml'

import {
  asString,
  type JsonTable,
} from 'src/platform/import/translate/values.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'

const NON_NAME_CHARS_RE = /[^a-z0-9]+/g
const EDGE_DASHES_RE = /^-+|-+$/g

export type AgentDialect = {
  /** Frontmatter keys carried over verbatim. Everything else is reported. */
  keepKeys: readonly string[]
  /**
   * Keys whose loss changes behaviour enough to explain, rather than just
   * listing them among the dropped ones.
   */
  explain: Readonly<Record<string, string>>
}

export const OPENCODE_AGENT_DIALECT: AgentDialect = {
  keepKeys: ['description'],
  explain: {
    tools: 'tools not carried over — opencode tool names differ from Claudin\u2019s',
    mode: 'opencode "mode" has no equivalent — imported as a subagent',
    permission: 'per-agent permissions not carried over — see /permissions',
    model: 'model not carried over — opencode model ids are provider-qualified',
  },
}

export const QWEN_AGENT_DIALECT: AgentDialect = {
  keepKeys: ['description', 'color'],
  explain: {
    tools: 'tools not carried over — Qwen tool names differ from Claudin\u2019s',
    model: 'model not carried over — Qwen model ids are not Claudin\u2019s',
  },
}

// Claude Code and openclaude need no dialect: their agent frontmatter is ours,
// tool names included, so `collectVerbatimMarkdown` copies the file unchanged.
// Round-tripping it through a dialect could only lose a key we forgot to list.

export type TranslatedAgent = {
  name: string
  /** Path under the agents directory. Always flat: `<name>.md`. */
  relativePath: string
  markdown: string
  notes: string[]
}

export type AgentTranslation =
  | { ok: true; agent: TranslatedAgent }
  | { ok: false; reason: string }

/**
 * `Code Reviewer.md` → `code-reviewer`. An agent name is an identifier the
 * user types, so it is normalised rather than passed through.
 */
export function agentNameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.(md|ya?ml)$/i, '')
  return base
    .toLowerCase()
    .replace(NON_NAME_CHARS_RE, '-')
    .replace(EDGE_DASHES_RE, '')
}

function collectFrontmatter(
  frontmatter: Record<string, unknown>,
  dialect: AgentDialect,
): { kept: Record<string, unknown>; notes: string[] } {
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  const notes: string[] = []
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) continue
    if (key === 'name' || key === 'description') continue
    if (dialect.keepKeys.includes(key)) {
      kept[key] = value
      continue
    }
    const explanation = dialect.explain[key]
    if (explanation) {
      notes.push(explanation)
    } else {
      dropped.push(key)
    }
  }
  if (dropped.length > 0) {
    notes.push(`dropped frontmatter: ${dropped.sort().join(', ')}`)
  }
  return { kept, notes }
}

function render(
  name: string,
  description: string,
  extra: Record<string, unknown>,
  systemPrompt: string,
): string {
  const yaml = stringifyYaml({ name, description, ...extra }).trimEnd()
  return `---\n${yaml}\n---\n\n${systemPrompt.trim()}\n`
}

export function translateMarkdownAgent(
  fileName: string,
  source: string,
  dialect: AgentDialect,
): AgentTranslation {
  const name = agentNameFromFileName(fileName)
  if (!name) return { ok: false, reason: 'filename yields an empty agent name' }

  const { frontmatter, content } = parseFrontmatter(source)
  const description =
    asString(frontmatter.description) ?? asString(frontmatter.name)
  if (!description) {
    return {
      ok: false,
      reason: 'has no description, which Claudin requires to load an agent',
    }
  }
  if (content.trim().length === 0) {
    return { ok: false, reason: 'has an empty system prompt' }
  }

  const { kept, notes } = collectFrontmatter(frontmatter, dialect)
  return {
    ok: true,
    agent: {
      name,
      relativePath: `${name}.md`,
      markdown: render(name, description, kept, content),
      notes,
    },
  }
}

/**
 * Qwen also accepts a `.yaml` agent, where the system prompt is a field rather
 * than the document body.
 */
export function translateYamlAgent(
  fileName: string,
  table: JsonTable,
  dialect: AgentDialect,
): AgentTranslation {
  const name = asString(table.name) ?? agentNameFromFileName(fileName)
  const normalized = agentNameFromFileName(name)
  if (!normalized) return { ok: false, reason: 'has no usable agent name' }

  const description = asString(table.description)
  if (!description) {
    return {
      ok: false,
      reason: 'has no description, which Claudin requires to load an agent',
    }
  }

  const systemPrompt =
    asString(table.systemPrompt) ??
    asString(table.system_prompt) ??
    asString(table.prompt)
  if (!systemPrompt) {
    return {
      ok: false,
      reason: 'carries no inline system prompt (only a path to one)',
    }
  }

  const { kept, notes } = collectFrontmatter(
    Object.fromEntries(
      Object.entries(table).filter(
        ([key]) =>
          key !== 'systemPrompt' && key !== 'system_prompt' && key !== 'prompt',
      ),
    ),
    dialect,
  )
  return {
    ok: true,
    agent: {
      name: normalized,
      relativePath: `${normalized}.md`,
      markdown: render(normalized, description, kept, systemPrompt),
      notes,
    },
  }
}
