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

import { isEnvTruthy } from '../../../utils/envUtils.js'
import { sanitizeSchemaForOpenAICompat } from '../../../utils/schemaSanitizer.js'
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

export function convertTools(
  tools: Array<{ name: string; description?: string; input_schema?: Record<string, unknown>; type?: string }>,
): OpenAITool[] {
  const isGemini = isGeminiMode()

  return tools
    .filter(t => t.name !== 'ToolSearchTool') // Not relevant for OpenAI
    // Anthropic server-side tools (e.g. web_search_20250305) have a non-function type and no
    // input_schema — OpenAI-compatible providers don't support them and return 400 if sent.
    .filter(t => !t.type || t.type === 'function')
    .map(t => {
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

      return {
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: normalizeSchemaForOpenAI(
            schema,
            !isGemini && !isEnvTruthy(process.env.CLAUDIN_DISABLE_STRICT_TOOLS),
          ),
        },
      }
    })
}
