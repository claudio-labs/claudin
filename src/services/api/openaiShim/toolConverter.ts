/**
 * Tool-schema conversion: Anthropic tool definitions → OpenAI function tools.
 *
 * Two responsibilities:
 *  - `normalizeSchemaForOpenAI` recursively rewrites the input schema so it
 *    survives strict-mode providers (Groq/Azure/OpenAI): preserves only the
 *    originally-required keys, sets `additionalProperties: false`, recurses
 *    into `properties`, `items`, and combinators. Gemini mode skips strict.
 *  - `convertTools` wraps the loop: filters out `ToolSearchTool` and
 *    Anthropic server-side tools, promotes Agent sub-fields, runs the
 *    schema through `normalizeSchemaForOpenAI`.
 *
 * Reads `CLAUDIN_DISABLE_STRICT_TOOLS` env to skip strict mode at runtime.
 */

import { isEnvTruthy } from 'src/utils/envUtils.js'
import { sanitizeSchemaForOpenAICompat } from 'src/utils/data/schemaSanitizer.js'
import { isGeminiMode } from './providerModes.js'
import type { OpenAITool } from './types.js'

function normalizeSchemaForOpenAI(
  schema: Record<string, unknown>,
  strict = true,
): Record<string, unknown> {
  const record = sanitizeSchemaForOpenAICompat(schema)

  if (record.type === 'object' && record.properties) {
    const properties = record.properties as Record<string, Record<string, unknown>>
    const existingRequired = Array.isArray(record.required) ? record.required as string[] : []

    // Recurse into each property
    const normalizedProps: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(properties)) {
      normalizedProps[key] = normalizeSchemaForOpenAI(
        value as Record<string, unknown>,
        strict,
      )
    }
    record.properties = normalizedProps

    if (strict) {
      // Keep only the properties that were originally marked required in the schema.
      // Adding every property to required[] (the previous behaviour) caused strict
      // OpenAI-compatible providers (Groq, Azure, etc.) to reject tool calls because
      // the model correctly omits optional arguments — but the provider treats them
      // as missing required fields and returns a 400 / tool_use_failed error.
      record.required = existingRequired.filter(k => k in normalizedProps)
      // additionalProperties: false is still required by strict-mode providers.
      record.additionalProperties = false
    } else {
      // For Gemini: keep only existing required keys that are present in properties
      record.required = existingRequired.filter(k => k in normalizedProps)
    }
  }

  // Recurse into array items
  if ('items' in record) {
    if (Array.isArray(record.items)) {
      record.items = (record.items as unknown[]).map(
        item => normalizeSchemaForOpenAI(item as Record<string, unknown>, strict),
      )
    } else {
      record.items = normalizeSchemaForOpenAI(record.items as Record<string, unknown>, strict)
    }
  }

  // Recurse into combinators
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (key in record && Array.isArray(record[key])) {
      record[key] = (record[key] as unknown[]).map(
        item => normalizeSchemaForOpenAI(item as Record<string, unknown>, strict),
      )
    }
  }

  return record
}

/**
 * Per-tool conversion cache keyed on `input_schema` object identity.
 *
 * The tool wrapper objects ({ name, description, input_schema }) handed to
 * convertTools are rebuilt per request, but the `input_schema` object comes
 * from toolToAPISchema's session-stable schema cache (which itself sits on
 * zodToJsonSchema's identity cache — src/utils/data/zodToJsonSchema.ts), so it is
 * the same reference on every request of a session. Strict mode and the
 * name/description can in principle differ for the same schema object, so the
 * entry stores them and is only reused on an exact match — a mismatch simply
 * recomputes (no staleness possible). Cached OpenAITool results are never
 * mutated downstream (callers JSON.stringify them into the request body).
 */
interface ToolConversionEntry {
  name: string
  description: string
  strict: boolean
  result: OpenAITool
}
const toolConversionCache = new WeakMap<Record<string, unknown>, ToolConversionEntry>()

/** Compute counter so tests can prove cache hits without poking internals. */
export const _toolConversionCacheStatsForTesting = { computes: 0 }

export function convertTools(
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown>; type?: string }>,
): OpenAITool[] {
  const isGemini = isGeminiMode()
  const strict = !isGemini && !isEnvTruthy(process.env.CLAUDIN_DISABLE_STRICT_TOOLS)

  return tools
    .filter(t => t.name !== 'ToolSearchTool') // Not relevant for OpenAI
    // Anthropic server-side tools (e.g. web_search_20250305) have a non-function type and no
    // input_schema — OpenAI-compatible providers don't support them and return 400 if sent.
    // `type: 'custom'` is a regular user-defined tool (it carries an input_schema, e.g. the
    // auto-mode classifier's forced-tool-choice schema) — keep it, only server tools are dropped.
    .filter(t => !t.type || t.type === 'function' || t.type === 'custom')
    .map(t => {
      const description = t.description ?? ''
      if (t.input_schema) {
        const cached = toolConversionCache.get(t.input_schema)
        if (
          cached &&
          cached.name === t.name &&
          cached.description === description &&
          cached.strict === strict
        ) {
          return cached.result
        }
      }
      _toolConversionCacheStatsForTesting.computes++

      const schema = { ...(t.input_schema ?? { type: 'object', properties: {} }) } as Record<string, unknown>

      // For Codex/OpenAI: promote known Agent sub-fields into required[] only if
      // they actually exist in properties (Gemini rejects required keys absent from properties).
      if (t.name === 'Agent' && schema.properties) {
        const props = schema.properties as Record<string, unknown>
        if (!Array.isArray(schema.required)) schema.required = []
        const req = schema.required as string[]
        for (const key of ['message', 'subagent_type']) {
          if (key in props && !req.includes(key)) req.push(key)
        }
      }

      const result: OpenAITool = {
        type: 'function' as const,
        function: {
          name: t.name,
          description,
          parameters: normalizeSchemaForOpenAI(schema, strict),
        },
      }
      if (t.input_schema) {
        toolConversionCache.set(t.input_schema, {
          name: t.name,
          description,
          strict,
          result,
        })
      }
      return result
    })
}
