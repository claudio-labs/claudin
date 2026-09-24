import { describe, expect, test } from 'bun:test'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import {
  importWithReadMulti,
  importWithReadMultiUnset,
} from 'src/tools/FileReadTool/__testutils__/readMultiFlag.js'

type Schemas = typeof import('src/tools/FileReadTool/schemas.js')

const SCHEMAS = 'src/tools/FileReadTool/schemas.js'

// "off" is CLAUDIN_READ_MULTI=0, the killswitch since the batch Read became
// the default. The describe keeps its name so its snapshot keeps its key.
describe('Read input schema — CLAUDIN_READ_MULTI off', () => {
  test('the JSON schema the API receives is pinned byte for byte', async () => {
    // Taken before the batch Read existed. Under the killswitch the model
    // must see exactly this schema — one file_path, one symbol — so the
    // snapshot is the proof, not a description of it.
    const { inputSchema } = await importWithReadMulti<Schemas>(SCHEMAS, false)
    expect(JSON.stringify(zodToJsonSchema(inputSchema()), null, 2)).toMatchSnapshot()
  })

  test('refuses the batch fields', async () => {
    const { inputSchema } = await importWithReadMulti<Schemas>(SCHEMAS, false)
    expect(inputSchema().safeParse({ file_paths: ['/a.ts', '/b.ts'] }).success).toBe(false)
    expect(inputSchema().safeParse({ file_path: '/a.ts', symbol: ['x', 'y'] }).success).toBe(
      false,
    )
  })
})

describe('Read input schema — the default, CLAUDIN_READ_MULTI unset', () => {
  test('the JSON schema the API receives is pinned byte for byte', async () => {
    // What every session gets since the promotion: file_paths, and symbol
    // as a name, a list or null.
    const { inputSchema } = await importWithReadMultiUnset<Schemas>(SCHEMAS)
    expect(JSON.stringify(zodToJsonSchema(inputSchema()), null, 2)).toMatchSnapshot()
  })

  test('is the schema CLAUDIN_READ_MULTI=1 makes, and not the killswitch one', async () => {
    const unset = zodToJsonSchema((await importWithReadMultiUnset<Schemas>(SCHEMAS)).inputSchema())
    const on = zodToJsonSchema((await importWithReadMulti<Schemas>(SCHEMAS, true)).inputSchema())
    const off = zodToJsonSchema((await importWithReadMulti<Schemas>(SCHEMAS, false)).inputSchema())
    expect(unset).toEqual(on)
    expect(unset).not.toEqual(off)
  })
})

type JsonRecord = Record<string, unknown>

function propertiesOf(schema: JsonRecord): Record<string, JsonRecord> {
  return schema.properties as Record<string, JsonRecord>
}

describe('Read input schema — CLAUDIN_READ_MULTI on', () => {
  async function load(): Promise<Schemas> {
    return importWithReadMulti<Schemas>(SCHEMAS, true)
  }

  test('file_paths is a 2-20 list, and neither path field is required', async () => {
    const json = zodToJsonSchema((await load()).inputSchema()) as JsonRecord
    const paths = propertiesOf(json).file_paths!
    expect(paths.type).toBe('array')
    expect(paths.minItems).toBe(2)
    expect(paths.maxItems).toBe(20)
    // Exactly one of the two is required, which JSON Schema cannot say
    // without a combinator at the root — validateInput says it instead.
    expect(json.required ?? []).not.toContain('file_path')
    expect(json.required ?? []).not.toContain('file_paths')
  })

  test('symbol takes a name, a list of up to ten, or null', async () => {
    const symbol = propertiesOf(zodToJsonSchema((await load()).inputSchema()) as JsonRecord)
      .symbol!
    const branches = symbol.anyOf as JsonRecord[]
    expect(branches.map(b => b.type)).toEqual(['string', 'array', 'null'])
    expect(branches[1]!.maxItems).toBe(10)
  })

  test('parses the batch shapes and bounds them', async () => {
    const schema = (await load()).inputSchema()
    expect(schema.safeParse({ file_paths: ['/a.ts', '/b.ts'] }).success).toBe(true)
    expect(schema.safeParse({ file_paths: ['/a.ts'] }).success).toBe(false)
    const tooMany = Array.from({ length: 21 }, (_, i) => `/f${i}.ts`)
    expect(schema.safeParse({ file_paths: tooMany }).success).toBe(false)
    expect(schema.safeParse({ file_path: '/a.ts', symbol: ['x', 'y'] }).success).toBe(true)
    const elevenSymbols = Array.from({ length: 11 }, (_, i) => `s${i}`)
    expect(schema.safeParse({ file_path: '/a.ts', symbol: elevenSymbols }).success).toBe(false)
    // The single-file shapes still parse exactly as before.
    expect(schema.parse({ file_path: '/a.ts', symbol: 'x' })).toEqual({
      file_path: '/a.ts',
      symbol: 'x',
    })
  })

  test('Codex placeholders — null, "" and an empty list — read as absent', async () => {
    // Codex strict mode lists every property as required, so a model that
    // means "not this one" sends a placeholder instead of leaving it out.
    const schema = (await load()).inputSchema()
    expect(
      schema.parse({ file_path: null, file_paths: ['/a.ts', '/b.ts'], symbol: null }),
    ).toEqual({ file_paths: ['/a.ts', '/b.ts'] })
    expect(schema.parse({ file_path: '', file_paths: ['/a.ts', '/b.ts'], symbol: '' })).toEqual({
      file_paths: ['/a.ts', '/b.ts'],
    })
    expect(schema.parse({ file_path: '/a.ts', file_paths: [], symbol: [] })).toEqual({
      file_path: '/a.ts',
    })
    expect(schema.parse({ file_path: '/a.ts', file_paths: null, symbol: 'x' })).toEqual({
      file_path: '/a.ts',
      symbol: 'x',
    })
  })
})
