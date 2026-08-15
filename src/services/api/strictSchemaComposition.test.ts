import { describe, expect, test } from 'bun:test'
import type { ZodType } from 'zod/v4'
import { AgentTool } from 'src/tools/AgentTool/AgentTool.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js'
import { ReportFindingsTool } from 'src/tools/ReportFindingsTool/ReportFindingsTool.js'
import { stripPlaceholderOptionalFields } from 'src/services/tools/toolInputPlaceholders.js'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import { convertToolsToResponsesTools } from 'src/services/api/codexShim.js'

/**
 * The regression suite for the Codex placeholder-argument bug, run against the
 * REAL tool schemas rather than fixtures.
 *
 * Two halves have to compose, and each half alone is a bug:
 *   1. `convertToolsToResponsesTools` forces every property into `required` and
 *      widens the optional ones to accept `null`, so the model has a legal way
 *      to decline an argument (without the widening it invents `pages: ""`,
 *      `isolation: "worktree"` — the original defect).
 *   2. `stripPlaceholderOptionalFields` turns those `null`s back into absent
 *      keys before validation (without it the model's legal `null` reaches zod,
 *      which rejects `null` for an `.optional()` field — the regression the
 *      first fix shipped, because it only swept top-level keys while the
 *      widening descends into nested objects and array items).
 *
 * So the invariant is: take a real tool, widen it the way the wire does, have
 * the model decline EVERY optional argument at every depth the way the widened
 * schema now permits, strip, and the tool's own zod schema must accept the
 * result. Any new tool with a nested optional is covered the moment it is added
 * to TOOLS below.
 */

type SchemaRecord = Record<string, unknown>

const TOOLS = [
  // The tool from the original report: `pages: ""` answered with
  // `Invalid pages parameter: ""`, 135 times in one session.
  { tool: FileReadTool, label: 'Read' },
  // Optional enum at the top level: `isolation: "worktree"` was forced onto
  // every Codex sub-agent because a single-value optional enum had no null.
  { tool: AgentTool, label: 'Agent' },
  // Many optionals of every primitive type.
  { tool: GrepTool, label: 'Grep' },
  // The nested case: `findings[]` is an array of objects with four optionals,
  // one level below anything a top-level pass can reach.
  { tool: ReportFindingsTool, label: 'ReportFindings' },
] as const

describe('widening and stripping compose on real tool schemas', () => {
  for (const { tool, label } of TOOLS) {
    test(`${label}: every optional can be declined at every depth`, () => {
      const original = zodToJsonSchema(tool.inputSchema as ZodType) as SchemaRecord
      const widened = widen(tool.name, original)

      // The model's worst case: it fills in every property (it must — they are
      // all `required` on the wire) and declines every optional one with the
      // `null` the widened schema declares legal.
      const declined = buildDeclinedInput(original)
      expect(declined.optionalPaths.length).toBeGreaterThan(0)

      // The generator is only faithful if the wire really does allow null
      // there; otherwise this test would be asserting against a shape the
      // backend never lets the model produce.
      for (const path of declined.optionalPaths) {
        expect({ path, allowed: allowsNull(widened, path) }).toEqual({
          path,
          allowed: true,
        })
      }

      const stripped = stripPlaceholderOptionalFields(tool, declined.input)
      const parsed = (tool.inputSchema as ZodType).safeParse(stripped)
      expect({ tool: label, ok: parsed.success, error: parsed.error?.message }).toEqual({
        tool: label,
        ok: true,
        error: undefined,
      })
    })

    test(`${label}: empty-string placeholders are declined the same way`, () => {
      // Models split between `null` and `""` for "no value"; both have to land
      // as an absent key or the string-typed optionals stay broken.
      const original = zodToJsonSchema(tool.inputSchema as ZodType) as SchemaRecord
      const declined = buildDeclinedInput(original, '')
      const stripped = stripPlaceholderOptionalFields(tool, declined.input)
      expect((tool.inputSchema as ZodType).safeParse(stripped).success).toBe(true)
    })
  }

  test('a required placeholder still reaches validation', () => {
    // The strip must not become a blanket "" filter: on a REQUIRED key an empty
    // string is the model's mistake, and silently deleting it would turn a
    // clear zod error into a confusing "missing field" one turn later.
    const stripped = stripPlaceholderOptionalFields(FileReadTool, {
      file_path: '',
      pages: '',
    }) as Record<string, unknown>
    expect(stripped).toEqual({ file_path: '' })
    expect((FileReadTool.inputSchema as ZodType).safeParse(stripped).success).toBe(true)
  })
})

describe('the three shapes that produced the original placeholder loop', () => {
  test('Read: the widened schema lets the model decline pages/view/symbol', () => {
    const widened = widen(
      FileReadTool.name,
      zodToJsonSchema(FileReadTool.inputSchema as ZodType) as SchemaRecord,
    )
    const properties = getRecord(widened.properties) ?? {}
    for (const key of ['pages', 'view', 'symbol', 'offset', 'limit']) {
      expect({ key, nullable: isNullable(getRecord(properties[key])) }).toEqual({
        key,
        nullable: true,
      })
    }
    // `file_path` is genuinely required — widening it would invite the model to
    // send a Read with no path at all.
    expect(isNullable(getRecord(properties.file_path))).toBe(false)
  })

  test('Agent: the optional enum carries null in BOTH the type and the values', () => {
    // An enum widened only on `type` contradicts itself — the value list still
    // forbids null — and that contradiction is what left `isolation:"worktree"`
    // as the model's only legal move.
    const widened = widen(
      AgentTool.name,
      zodToJsonSchema(AgentTool.inputSchema as ZodType) as SchemaRecord,
    )
    const isolation = getRecord(getRecord(widened.properties)?.isolation)
    expect(isolation?.type).toEqual(['string', 'null'])
    expect(isolation?.enum).toContain(null)
    const declined: Record<string, unknown> = {
      description: 'x',
      prompt: 'y',
      isolation: null,
    }
    expect(stripPlaceholderOptionalFields(AgentTool, declined)).toEqual({
      description: 'x',
      prompt: 'y',
    })
  })

  test('ReportFindings: a nulled optional inside findings[] never reaches zod', () => {
    // The exact regression a top-level-only strip shipped: zod accepts a
    // missing `line`, and rejects `line: null`.
    const input: Record<string, unknown> = {
      findings: [
        {
          file: 'src/a.ts',
          summary: 'bad',
          failure_scenario: 'boom',
          line: null,
          category: null,
          verdict: null,
          outcome: null,
        },
      ],
      level: null,
    }
    const stripped = stripPlaceholderOptionalFields(ReportFindingsTool, input)
    expect(stripped).toEqual({
      findings: [{ file: 'src/a.ts', summary: 'bad', failure_scenario: 'boom' }],
    })
    expect((ReportFindingsTool.inputSchema as ZodType).safeParse(stripped).success).toBe(
      true,
    )
    // And the unstripped input is genuinely rejected — otherwise the test above
    // would pass with the strip removed entirely.
    expect((ReportFindingsTool.inputSchema as ZodType).safeParse(input).success).toBe(
      false,
    )
  })
})

/** Runs a tool's JSON Schema through the exact wire conversion. */
function widen(name: string, schema: SchemaRecord): SchemaRecord {
  const [converted] = convertToolsToResponsesTools([
    { name, description: 'irrelevant', input_schema: schema },
  ])
  return (converted?.parameters ?? {}) as SchemaRecord
}

/**
 * Builds the input a model produces under the widened schema: required
 * properties get a plausible value, optional ones get the placeholder, and both
 * recurse through nested objects and array items. Returns the dotted paths of
 * every placeholder it planted so the caller can check the wire allows them.
 */
function buildDeclinedInput(
  schema: SchemaRecord,
  placeholder: unknown = null,
): { input: unknown; optionalPaths: string[] } {
  const optionalPaths: string[] = []
  const input = build(schema, '', optionalPaths, placeholder)
  return { input, optionalPaths }
}

function build(
  schema: SchemaRecord,
  path: string,
  optionalPaths: string[],
  placeholder: unknown,
): unknown {
  const properties = getRecord(schema.properties)
  if (properties) {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((key): key is string => typeof key === 'string')
        : [],
    )
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(properties)) {
      const child = getRecord(raw)
      if (!child) continue
      const childPath = path ? `${path}.${key}` : key
      if (!required.has(key)) {
        // A string-typed optional gets `""` when that is the placeholder under
        // test; anything else can only be declined with null.
        const usesEmptyString = placeholder === '' && typeSet(child).has('string')
        out[key] = usesEmptyString ? '' : null
        optionalPaths.push(childPath)
        continue
      }
      out[key] = build(child, childPath, optionalPaths, placeholder)
    }
    return out
  }

  const items = getRecord(schema.items)
  if (items || typeSet(schema).has('array')) {
    return items ? [build(items, `${path}[]`, optionalPaths, placeholder)] : []
  }

  return sampleScalar(schema)
}

function sampleScalar(schema: SchemaRecord): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if ('const' in schema) return schema.const
  const types = typeSet(schema)
  if (types.has('string')) return 'x'
  if (types.has('integer') || types.has('number')) return 1
  if (types.has('boolean')) return true
  if (types.has('object')) return {}
  if (types.has('null')) return null
  // A union or an unconstrained field: a string satisfies the ones our tools
  // actually declare, and a wrong guess surfaces as a parse failure rather than
  // a false pass.
  return 'x'
}

/** Walks a dotted path (with `[]` for array items) through the widened schema. */
function allowsNull(widened: SchemaRecord, path: string): boolean {
  let node: SchemaRecord | undefined = widened
  for (const segment of path.split('.')) {
    if (!node) return false
    const key = segment.endsWith('[]') ? segment.slice(0, -2) : segment
    node = getRecord(getRecord(node.properties)?.[key])
    if (segment.endsWith('[]')) node = getRecord(node?.items)
  }
  return isNullable(node)
}

function isNullable(schema: SchemaRecord | undefined): boolean {
  if (!schema) return false
  // An enum widened only on `type` contradicts its own value list, and a
  // backend that honors the list still leaves the model with no way out — so
  // "nullable" here means BOTH halves, not just the type union.
  if (Array.isArray(schema.enum)) {
    return typeSet(schema).has('null') && schema.enum.includes(null)
  }
  if (typeSet(schema).has('null')) return true
  const branches = schema.anyOf ?? schema.oneOf
  return (
    Array.isArray(branches) &&
    branches.some(branch => typeSet(getRecord(branch) ?? {}).has('null'))
  )
}

function typeSet(schema: SchemaRecord): Set<string> {
  const type = schema.type
  if (typeof type === 'string') return new Set([type])
  if (Array.isArray(type)) {
    return new Set(type.filter((entry): entry is string => typeof entry === 'string'))
  }
  return new Set()
}

function getRecord(value: unknown): SchemaRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as SchemaRecord
}
