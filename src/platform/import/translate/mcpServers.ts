/**
 * Translators from each foreign agent's MCP server shape into Claudin's.
 *
 * Four of the eight agents write Claude Code's own shape verbatim, so they
 * share one core. The three that do not each get their own entry point rather
 * than a flag on a shared one — the differences are in *which* keys exist, and
 * a boolean parameter that switched them would be exactly the footgun a caller
 * forgets to pass.
 *
 * Every translator ends at `McpServerConfigSchema()`, so anything that reaches
 * `apply.ts` is already something `addMcpConfig` will accept.
 */
import {
  McpServerConfigSchema,
  type McpServerConfig,
} from 'src/mcp/types.js'
import {
  asString,
  asStringArray,
  asStringRecord,
  asTable,
} from 'src/platform/import/translate/values.js'

export type McpTranslation =
  | {
      ok: true
      config: McpServerConfig
      /** A judgement call the user should know about, e.g. a guessed transport. */
      note?: string
    }
  | { ok: false; reason: string }

/** Cursor writes `${env:TOKEN}`; Claudin's expander reads `${TOKEN}`. */
const CURSOR_ENV_PLACEHOLDER_RE = /\$\{env:([^}]+)\}/g
/** opencode writes `{env:TOKEN}` and `{file:path}`; only the first translates. */
const OPENCODE_ENV_PLACEHOLDER_RE = /\{env:([^}]+)\}/g
const OPENCODE_FILE_PLACEHOLDER_RE = /\{file:[^}]+\}/

function identity(value: string): string {
  return value
}

function cursorPlaceholders(value: string): string {
  return value.replace(CURSOR_ENV_PLACEHOLDER_RE, '${$1}')
}

function opencodePlaceholders(value: string): string {
  return value.replace(OPENCODE_ENV_PLACEHOLDER_RE, '${$1}')
}

function mapValues(
  record: Record<string, string> | null,
  transform: (value: string) => string,
): Record<string, string> | undefined {
  if (!record) return undefined
  const entries = Object.entries(record)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map(([k, v]) => [k, transform(v)]))
}

function finalize(candidate: unknown, note?: string): McpTranslation {
  const parsed = McpServerConfigSchema().safeParse(candidate)
  if (!parsed.success) {
    const reason = parsed.error.issues
      .slice(0, 3)
      .map(issue => issue.message)
      .join('; ')
    return { ok: false, reason: reason || 'does not match any known transport' }
  }
  return note ? { ok: true, config: parsed.data, note } : { ok: true, config: parsed.data }
}

function buildStdio(
  command: string,
  args: string[] | null,
  env: Record<string, string> | undefined,
): McpTranslation {
  return finalize({
    type: 'stdio',
    command,
    args: args ?? [],
    ...(env ? { env } : {}),
  })
}

function buildRemote(
  type: 'sse' | 'http',
  url: string,
  headers: Record<string, string> | undefined,
  note?: string,
): McpTranslation {
  return finalize({ type, url, ...(headers ? { headers } : {}) }, note)
}

/**
 * Claude Code, openclaude and Kimi CLI. A remote entry without an explicit
 * `type` is assumed to be streamable HTTP, which is what current servers
 * publish; the note says so, because SSE was the older default and a wrong
 * guess shows up only when the server is first contacted.
 */
export function translateClaudeShapedServer(raw: unknown): McpTranslation {
  return translateClaudeShapedServerWith(raw, identity)
}

/** Cursor's `mcp.json`, which is Claude-shaped apart from `${env:…}`. */
export function translateCursorServer(raw: unknown): McpTranslation {
  return translateClaudeShapedServerWith(raw, cursorPlaceholders)
}

function translateClaudeShapedServerWith(
  raw: unknown,
  transform: (value: string) => string,
): McpTranslation {
  const table = asTable(raw)
  if (!table) return { ok: false, reason: 'entry is not an object' }

  const declared = asString(table.type)
  const url = asString(table.url)
  if (url) {
    const headers = mapValues(asStringRecord(table.headers), transform)
    if (declared === 'sse') return buildRemote('sse', transform(url), headers)
    if (declared === 'http' || declared === null) {
      return buildRemote(
        'http',
        transform(url),
        headers,
        declared === null
          ? 'no transport declared — imported as streamable HTTP'
          : undefined,
      )
    }
    return { ok: false, reason: `unsupported transport "${declared}"` }
  }

  const command = asString(table.command)
  if (!command) return { ok: false, reason: 'has neither command nor url' }
  const args = asStringArray(table.args ?? [])
  if (!args) return { ok: false, reason: 'args is not a list of strings' }
  return buildStdio(
    transform(command),
    args.map(transform),
    mapValues(asStringRecord(table.env), transform),
  )
}

/**
 * Gemini CLI and Qwen Code. Their documented precedence is
 * `httpUrl` → `url` → `command`, and `url` there specifically means SSE, so
 * neither branch has to guess a transport.
 */
export function translateGeminiServer(raw: unknown): McpTranslation {
  const table = asTable(raw)
  if (!table) return { ok: false, reason: 'entry is not an object' }

  const headers = mapValues(asStringRecord(table.headers), identity)
  const httpUrl = asString(table.httpUrl)
  if (httpUrl) return buildRemote('http', httpUrl, headers)

  const url = asString(table.url)
  if (url) return buildRemote('sse', url, headers)

  const command = asString(table.command)
  if (!command) {
    return { ok: false, reason: 'has none of httpUrl, url or command' }
  }
  const args = asStringArray(table.args ?? [])
  if (!args) return { ok: false, reason: 'args is not a list of strings' }
  // `cwd` has no equivalent in our stdio shape and is dropped; the adapter
  // reports it so the user is not left wondering why the server misbehaves.
  return buildStdio(command, args, mapValues(asStringRecord(table.env), identity))
}

/**
 * OpenAI Codex's `[mcp_servers.*]` tables. Its remote form authenticates by
 * naming an env var rather than carrying a header, so the translation turns
 * `bearer_token_env_var = "X"` into `Authorization: Bearer ${X}` — a form
 * Claudin's own expander resolves at connect time, still without the token
 * ever being copied.
 */
export function translateCodexServer(raw: unknown): McpTranslation {
  const table = asTable(raw)
  if (!table) return { ok: false, reason: 'entry is not an object' }

  const url = asString(table.url)
  if (url) {
    const headers: Record<string, string> = {
      ...(asStringRecord(table.http_headers) ?? {}),
    }
    const tokenVar = asString(table.bearer_token_env_var)
    if (tokenVar && !('Authorization' in headers)) {
      headers.Authorization = `Bearer \${${tokenVar}}`
    }
    return buildRemote(
      'http',
      url,
      Object.keys(headers).length > 0 ? headers : undefined,
    )
  }

  const command = asString(table.command)
  if (!command) return { ok: false, reason: 'has neither command nor url' }
  const args = asStringArray(table.args ?? [])
  if (!args) return { ok: false, reason: 'args is not a list of strings' }
  return buildStdio(command, args, mapValues(asStringRecord(table.env), identity))
}

/**
 * opencode's `mcp` map. Two things are peculiar to it: the local form packs
 * the executable and its arguments into a single `command` array, and a server
 * can be switched off in place with `enabled: false` — which we honour, since
 * an import that silently re-enables something the user disabled is a
 * surprise, not a convenience.
 */
export function translateOpencodeServer(raw: unknown): McpTranslation {
  const table = asTable(raw)
  if (!table) return { ok: false, reason: 'entry is not an object' }
  if (table.enabled === false) {
    return { ok: false, reason: 'disabled in the opencode config' }
  }

  const type = asString(table.type)
  if (type === 'remote') {
    const url = asString(table.url)
    if (!url) return { ok: false, reason: 'remote entry has no url' }
    return buildRemote(
      'http',
      opencodePlaceholders(url),
      mapValues(asStringRecord(table.headers), opencodePlaceholders),
    )
  }

  const parts = asStringArray(table.command)
  if (!parts) return { ok: false, reason: 'command is not a list of strings' }
  const executable = parts[0]
  if (executable === undefined) return { ok: false, reason: 'command is empty' }
  const rest = parts.slice(1)
  const env = mapValues(
    asStringRecord(table.environment),
    opencodePlaceholders,
  )
  const usesFilePlaceholder = parts.some(part =>
    OPENCODE_FILE_PLACEHOLDER_RE.test(part),
  )
  const translated = buildStdio(
    opencodePlaceholders(executable),
    rest.map(opencodePlaceholders),
    env,
  )
  if (translated.ok && usesFilePlaceholder) {
    return {
      ...translated,
      note: 'uses opencode\u2019s {file:…} substitution, which Claudin does not expand',
    }
  }
  return translated
}
