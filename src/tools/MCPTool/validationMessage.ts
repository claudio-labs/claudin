// Builds a richer validation-error message for MCP tool arguments.
//
// Models repeatedly re-guess MCP arguments when the only feedback is Ajv's raw
// "must have required property 'x'" — one error at a time, with no list of the
// fields the tool actually accepts. This module appends a compact one-line
// summary of the accepted arguments so the model can correct every field in a
// single retry. Pairs with `allErrors: true` on the Ajv instance in MCPTool.ts,
// which reports every violation at once instead of stopping at the first.

// Guard against pathologically large schemas blowing up the error string.
const MAX_LISTED_PROPERTIES = 15
// A single property can carry a huge enum (timezones, country codes, …); cap it
// too so the property count is not the only bound on the message length.
const MAX_ENUM_VALUES = 12

interface JSONSchemaLike {
  type?: unknown
  properties?: Record<string, unknown>
  required?: unknown
}

interface PropertyLike {
  type?: unknown
  enum?: unknown
}

function formatType(prop: PropertyLike): string {
  const t = prop.type
  if (typeof t === 'string') return t
  if (Array.isArray(t)) {
    return t.filter(x => typeof x === 'string').join(' | ') || 'any'
  }
  return 'any'
}

function formatEnum(prop: PropertyLike): string | null {
  if (!Array.isArray(prop.enum) || prop.enum.length === 0) return null
  const shown = prop.enum.slice(0, MAX_ENUM_VALUES)
  const values = shown.map(v => (typeof v === 'string' ? `"${v}"` : String(v)))
  if (prop.enum.length > shown.length) {
    values.push(`… +${prop.enum.length - shown.length} more`)
  }
  return `one of: ${values.join(' | ')}`
}

/**
 * One-line human summary of a schema's top-level accepted properties, or null if
 * the schema is not a plain object with properties (e.g. a top-level oneOf, or an
 * empty schema). Marks each property required/optional and lists enum values.
 */
export function describeSchemaShape(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null
  const s = schema as JSONSchemaLike
  const props = s.properties
  if (!props || typeof props !== 'object') return null

  const keys = Object.keys(props)
  if (keys.length === 0) return null

  const required = new Set(
    Array.isArray(s.required)
      ? s.required.filter((k): k is string => typeof k === 'string')
      : [],
  )

  const shown = keys.slice(0, MAX_LISTED_PROPERTIES)
  const parts = shown.map(key => {
    const prop = (props[key] ?? {}) as PropertyLike
    const bits = [formatType(prop), required.has(key) ? 'required' : 'optional']
    const enumStr = formatEnum(prop)
    if (enumStr) bits.push(enumStr)
    return `${key} (${bits.join(', ')})`
  })
  if (keys.length > shown.length) {
    parts.push(`… +${keys.length - shown.length} more`)
  }

  return `Accepted arguments: ${parts.join(', ')}`
}

/**
 * Combines Ajv's error text with a one-line summary of the accepted arguments.
 * Falls back to the raw errorsText when the shape can't be described.
 */
export function buildMcpValidationError(
  schema: unknown,
  errorsText: string,
): string {
  const shape = describeSchemaShape(schema)
  return shape ? `${errorsText}\n${shape}` : errorsText
}
