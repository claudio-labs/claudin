import { logError } from './log.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

/**
 * Drops the placeholder values a strict-schema provider forces the model to
 * invent for arguments it does not actually want to pass.
 *
 * OpenAI structured outputs — which the Codex Responses transport turns on for
 * every tool (`strict: true`, see codexShim's enforceStrictSchema) — require
 * EVERY property to appear in `required`. A model that means "no page range"
 * therefore cannot omit `pages`; it emits `""` (or `null`) instead. Downstream
 * that reads as a value the user asked for: Read's validateInput answered
 * `pages: ""` with `Invalid pages parameter: ""` and, since the model kept
 * re-sending the same placeholder, the call failed identically over a hundred
 * times in one session.
 *
 * So: for a key the tool's own schema marks optional, `null`/`""` means absent.
 * Required keys are left alone — there the placeholder is a real mistake and
 * the model should see the validation error. Same for keys no schema declares:
 * zod (or the MCP server's Ajv) owns that complaint.
 *
 * Optionality is read from the SAME JSON Schema codexShim widens
 * (`inputJSONSchema` for MCP tools, `zodToJsonSchema(inputSchema)` otherwise),
 * and the walk recurses exactly as far as that widening does — nested objects
 * and array items included. An earlier revision resolved optionality straight
 * off the zod shape and only scanned top-level keys, which left every nested
 * optional (`ReportFindings.findings[].line`) holding the `null` the shim had
 * just made legal, and zod rejects `null` for an `.optional()` field where the
 * old `""` would have parsed.
 *
 * Fields the shim cannot widen (a `const`, a union, an already-nullable type)
 * still have their `""`/`null` stripped: the model had no legal way to omit
 * them either, so an empty placeholder is likelier than a deliberate empty
 * value. Empty arrays/objects are not placeholders and are kept.
 */
export function stripPlaceholderOptionalFields<T>(
  tool: ToolSchemaSource,
  input: T,
): T {
  if (!input || typeof input !== 'object') return input
  const schema = resolveToolJsonSchema(tool)
  if (!schema) return input
  return stripNode(input, schema) as T
}

/**
 * The two schema surfaces a Tool can carry. MCP tools keep the server's JSON
 * Schema in `inputJSONSchema` and leave `inputSchema` as a passthrough
 * `z.object({})` (MCPTool.ts) — reading only the zod side would make this a
 * silent no-op for every MCP tool while codexShim still widened their optional
 * args to nullable, so the model would send `null` into MCPTool's Ajv check and
 * get a hard "must be string" instead of the soft failure it had before.
 */
export type ToolSchemaSource = {
  inputSchema?: unknown
  inputJSONSchema?: unknown
}

/** Walks value and schema together, deleting placeholders at every level. */
function stripNode(value: unknown, schema: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    const items = getRecord(schema.items)
    if (!items) return value
    let copy: unknown[] | undefined
    for (const [index, element] of value.entries()) {
      const next = stripNode(element, items)
      if (next === element) continue
      copy ??= [...value]
      copy[index] = next
    }
    return copy ?? value
  }

  const record = getRecord(value)
  const properties = getRecord(schema.properties)
  if (!record || !properties) return value

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  )

  let copy: Record<string, unknown> | undefined
  for (const [key, child] of Object.entries(record)) {
    const childSchema = getRecord(properties[key])
    // Undeclared key: not something the widening could have caused, so leave
    // it for the tool's own validator to complain about.
    if (!childSchema) continue

    if ((child === null || child === '') && !required.has(key)) {
      copy ??= { ...record }
      delete copy[key]
      continue
    }

    if (!child || typeof child !== 'object') continue
    const next = stripNode(child, childSchema)
    if (next === child) continue
    copy ??= { ...record }
    copy[key] = next
  }

  return copy ?? record
}

function resolveToolJsonSchema(
  tool: ToolSchemaSource,
): Record<string, unknown> | undefined {
  const provided = getRecord(tool.inputJSONSchema)
  if (getRecord(provided?.properties)) return provided

  if (!tool.inputSchema) return undefined
  try {
    // Memoized per zod schema object (zodToJsonSchema keeps its own cache), so
    // this costs one conversion per tool per process.
    return getRecord(zodToJsonSchema(tool.inputSchema as never))
  } catch (e) {
    // A schema we cannot convert tells us nothing about optionality; keep the
    // input and let the tool's own validation speak.
    logError(e)
    return undefined
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
