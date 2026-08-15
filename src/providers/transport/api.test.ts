import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tool, type Tools } from 'src/tools/Tool.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'
import { splitSysPromptPrefix, toolToAPISchema } from 'src/providers/transport/api.js'
import { asSystemPrompt } from 'src/agent/systemPromptType.js'

test('toolToAPISchema preserves provider-specific schema keywords in input_schema', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'WebFetch',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description: 'Public HTTP or HTTPS URL',
          },
          metadata: {
            type: 'object',
            propertyNames: {
              pattern: '^[a-z]+$',
            },
            properties: {
              callback: {
                type: 'string',
                format: 'uri-reference',
              },
            },
          },
        },
      },
      prompt: async () => 'Fetch a URL',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  expect(schema).toMatchObject({
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'Public HTTP or HTTPS URL',
        },
        metadata: {
          type: 'object',
          propertyNames: {
            pattern: '^[a-z]+$',
          },
          properties: {
            callback: {
              type: 'string',
              format: 'uri-reference',
            },
          },
        },
      },
    },
  })
})

test('toolToAPISchema keeps skill required for SkillTool', async () => {
  const schema = await toolToAPISchema(SkillTool, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [] as unknown as Tools,
    agents: [],
  })

  expect((schema as { input_schema: unknown }).input_schema).toMatchObject({
    type: 'object',
    required: ['skill'],
  })
})

test('toolToAPISchema removes extra required keys not in properties (MCP schema sanitization)', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'mcp__test__create_object',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name', 'attributes'],
      },
      prompt: async () => 'Create an object',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  const inputSchema = (schema as { input_schema: { required?: string[] } }).input_schema
  expect(inputSchema.required).toEqual(['name'])
})

/**
 * Regression: `splitSysPromptPrefix` MUST place the attribution header
 * (block starting with `x-anthropic-billing-header`) as the FIRST output
 * block, with `cacheScope: null`. Anthropic's prompt cache is matched on
 * literal bytes; if any later cache_control breakpoint sits behind a
 * block whose head bytes can shift between turns (see system.test.ts
 * for the cc_workload flip), every breakpoint downstream is invalidated
 * on the flip.
 *
 * These assertions document the structural invariant. The fix for the
 * cc_workload flip is upstream of split (in getAttributionHeader); this
 * file just guarantees the placement contract isn't accidentally moved.
 */
describe('splitSysPromptPrefix attribution header placement', () => {
  const claudinPrefix = 'You are Claudin, an open-source coding agent and CLI.'

  test('attribution header is block 0 with cacheScope=null', () => {
    const blocks = splitSysPromptPrefix(
      asSystemPrompt([
        'x-anthropic-billing-header: cc_version=99.0.0.abc; cc_entrypoint=cli;',
        claudinPrefix,
        'You are working in a git repository at /tmp/x',
      ]),
    )
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0]!.text).toMatch(/^x-anthropic-billing-header:/)
    expect(blocks[0]!.cacheScope).toBeNull()
  })

  test('attribution header placement holds with skipGlobalCacheForSystemPrompt=true (MCP path)', () => {
    const blocks = splitSysPromptPrefix(
      asSystemPrompt([
        'x-anthropic-billing-header: cc_version=99.0.0.abc; cc_entrypoint=cli;',
        claudinPrefix,
        'extra context block',
      ]),
      { skipGlobalCacheForSystemPrompt: true },
    )
    expect(blocks[0]!.text).toMatch(/^x-anthropic-billing-header:/)
    expect(blocks[0]!.cacheScope).toBeNull()
  })

  test('two distinct attribution headers (interactive vs cron-tagged) produce DIFFERENT block 0 bytes', () => {
    const interactive = splitSysPromptPrefix(
      asSystemPrompt([
        'x-anthropic-billing-header: cc_version=99.0.0.abc; cc_entrypoint=cli;',
        claudinPrefix,
      ]),
    )
    const cron = splitSysPromptPrefix(
      asSystemPrompt([
        'x-anthropic-billing-header: cc_version=99.0.0.abc; cc_entrypoint=cli; cc_workload=cron;',
        claudinPrefix,
      ]),
    )
    // Block 0 differs: this is the byte shift that breaks every
    // downstream cache_control breakpoint on alternation.
    expect(interactive[0]!.text).not.toBe(cron[0]!.text)
    // The system prefix block (block 1) is byte-identical — proving
    // the only divergence is the attribution header.
    expect(interactive[1]!.text).toBe(cron[1]!.text)
  })
})
