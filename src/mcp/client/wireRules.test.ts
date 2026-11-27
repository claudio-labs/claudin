import { describe, expect, test } from 'bun:test'
import type { Tool } from '@modelcontextprotocol/client'
import type { SkippedEntry } from 'src/mcp/client/listValidation.js'
import {
  fillListResultFields,
  LEGACY_INITIALIZE_CAPABILITIES,
  SEND_RULES,
  WIRE_RULES,
  withLegacyInitializeCapabilities,
  type WireResult,
  withoutOutputSchema,
} from 'src/mcp/client/wireRules.js'

function run(method: string, result: WireResult): Array<[string, SkippedEntry[]]> {
  const skips: Array<[string, SkippedEntry[]]> = []
  WIRE_RULES[method]!(result, { onSkipped: (kind, skipped) => skips.push([kind, skipped]) })
  return skips
}

const good = { name: 'good', inputSchema: { type: 'object' } }
const bad = { name: 'bad', inputSchema: { type: 'string' } }

describe('the rule table', () => {
  test('has a rule for each list method, and none for anything else', () => {
    expect(Object.keys(WIRE_RULES).sort()).toEqual([
      'prompts/list',
      'resources/list',
      'resources/templates/list',
      'tools/list',
    ])
  })
})

describe('fillListResultFields', () => {
  test('fills the hints a 2026-07-28 list result must carry', () => {
    const result: WireResult = { tools: [] }
    fillListResultFields(result)
    expect(result).toEqual({ tools: [], resultType: 'complete', ttlMs: 0, cacheScope: 'private' })
  })

  test('keeps valid hints as the server sent them', () => {
    const result: WireResult = { resultType: 'complete', ttlMs: 30_000, cacheScope: 'public' }
    fillListResultFields(result)
    expect(result).toEqual({ resultType: 'complete', ttlMs: 30_000, cacheScope: 'public' })
  })

  test('replaces invalid hints with the defaults', () => {
    for (const ttlMs of [-1, 1.5, '60', Number.MAX_SAFE_INTEGER + 2, null]) {
      const result: WireResult = { ttlMs, cacheScope: 'shared' }
      fillListResultFields(result)
      expect(result.ttlMs).toBe(0)
      expect(result.cacheScope).toBe('private')
    }
  })

  test('leaves a resultType the server sent alone, whatever it is', () => {
    const result: WireResult = { resultType: 'input_required' }
    fillListResultFields(result)
    expect(result.resultType).toBe('input_required')
  })
})

describe('tools/list', () => {
  test('keeps the sound tools in place and reports the skipped ones as tools', () => {
    const result: WireResult = { tools: [good, bad], nextCursor: 'c2' }
    const skips = run('tools/list', result)
    expect(result.tools).toEqual([good])
    expect(result.nextCursor).toBe('c2')
    expect(skips).toEqual([['tool', [{ name: 'bad', reason: 'inputSchema type is not "object"' }]]])
  })

  test('reports nothing when every tool is sound', () => {
    const result: WireResult = { tools: [good] }
    expect(run('tools/list', result)).toEqual([])
  })

  test('drops each tool’s outputSchema', () => {
    const result: WireResult = {
      tools: [{ ...good, outputSchema: { type: 'object', properties: { n: { type: 'number' } } } }],
    }
    run('tools/list', result)
    expect(result.tools).toEqual([good])
  })

  test('fills the cache hints', () => {
    const result: WireResult = { tools: [] }
    run('tools/list', result)
    expect(result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' })
  })

  test('leaves a list that is not a list for the SDK to reject', () => {
    const result: WireResult = { tools: 'not a list' }
    expect(run('tools/list', result)).toEqual([])
    expect(result.tools).toBe('not a list')
  })
})

describe('the other lists', () => {
  test('prompts/list skips a malformed prompt', () => {
    const result: WireResult = { prompts: [{ name: 'ok' }, { name: 'bad', arguments: 'x' }] }
    const skips = run('prompts/list', result)
    expect(result.prompts).toEqual([{ name: 'ok' }])
    expect(skips.map(([kind, skipped]) => [kind, skipped.map(s => s.name)])).toEqual([['prompt', ['bad']]])
  })

  test('resources/list skips a resource without a uri', () => {
    const result: WireResult = { resources: [{ uri: 'file:///a', name: 'a' }, { name: 'no-uri' }] }
    const skips = run('resources/list', result)
    expect(result.resources).toEqual([{ uri: 'file:///a', name: 'a' }])
    expect(skips.map(([kind, skipped]) => [kind, skipped.map(s => s.name)])).toEqual([['resource', ['no-uri']]])
  })

  test('resources/templates/list skips a template without a uriTemplate', () => {
    const result: WireResult = {
      resourceTemplates: [{ uriTemplate: 'file:///{p}', name: 'f' }, { name: 'no-template' }],
    }
    const skips = run('resources/templates/list', result)
    expect(result.resourceTemplates).toEqual([{ uriTemplate: 'file:///{p}', name: 'f' }])
    expect(skips.map(([kind, skipped]) => [kind, skipped.map(s => s.name)])).toEqual([
      ['resource template', ['no-template']],
    ])
  })

  test('each fills the cache hints', () => {
    for (const [method, field] of [
      ['prompts/list', 'prompts'],
      ['resources/list', 'resources'],
      ['resources/templates/list', 'resourceTemplates'],
    ] as const) {
      const result: WireResult = { [field]: [] }
      run(method, result)
      expect(result).toEqual({ [field]: [], resultType: 'complete', ttlMs: 0, cacheScope: 'private' })
    }
  })
})

describe('withoutOutputSchema', () => {
  test('hands back a tool with no outputSchema as is', () => {
    const tool = good as Tool
    expect(withoutOutputSchema(tool)).toBe(tool)
  })

  test('drops the outputSchema and keeps the rest', () => {
    const tool = { ...good, description: 'd', outputSchema: { type: 'object' } } as Tool
    expect(withoutOutputSchema(tool)).toEqual({ ...good, description: 'd' } as Tool)
  })
})

describe('the send rule table', () => {
  test('rewrites initialize only', () => {
    expect(Object.keys(SEND_RULES)).toEqual(['initialize'])
  })

  test('the 2025 initialize capabilities are the wire Spring AI accepts, whatever the client holds', () => {
    const request = {
      method: 'initialize',
      id: 0,
      params: { protocolVersion: '2025-11-25', capabilities: { roots: {}, elicitation: { form: {}, url: {} }, extra: {} } },
    }
    const sent = withLegacyInitializeCapabilities(request)
    expect(sent).toEqual({
      method: 'initialize',
      id: 0,
      params: { protocolVersion: '2025-11-25', capabilities: { roots: {}, elicitation: {} } },
    })
    expect(request.params.capabilities.elicitation).toEqual({ form: {}, url: {} })
    expect(LEGACY_INITIALIZE_CAPABILITIES).toEqual({ roots: {}, elicitation: {} })
    // Each request gets its own object, so nothing downstream edits the constant.
    expect(withLegacyInitializeCapabilities({ method: 'initialize' }).params!.capabilities).not.toBe(
      LEGACY_INITIALIZE_CAPABILITIES,
    )
  })
})
