import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tool, type Tools } from 'src/tools/Tool.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'
import {
  prependUserContext,
  splitSysPromptPrefix,
  toolToAPISchema,
} from 'src/providers/transport/api.js'
import { asSystemPrompt } from 'src/agent/systemPromptType.js'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  SYSTEM_PROMPT_SESSION_MARKER,
} from 'src/agent/prompts/prompts.js'

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

/**
 * The scratchpad path carries the session id. splitSysPromptPrefix sends it
 * as a trailing block without cache_control, so the cached blocks before it
 * are byte-identical from one session to the next — and the count of cached
 * blocks (each one a cache_control breakpoint) does not change.
 */
describe('splitSysPromptPrefix per-session element', () => {
  const priorScope = process.env.CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE
  const priorBetas = process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS
  afterEach(() => {
    if (priorScope === undefined) delete process.env.CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE
    else process.env.CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE = priorScope
    if (priorBetas === undefined) delete process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS
    else process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS = priorBetas
  })

  const MODES = [
    { mode: 'default (no global scope)', globalScope: false, skipGlobal: false },
    { mode: 'global scope, MCP path', globalScope: true, skipGlobal: true },
    { mode: 'global scope with boundary', globalScope: true, skipGlobal: false },
  ] as const

  function split(
    globalScope: boolean,
    skipGlobal: boolean,
    sessionId: string | null,
    appended: string[] = [],
  ) {
    delete process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS
    if (globalScope) delete process.env.CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE
    else process.env.CLAUDIN_DISABLE_GLOBAL_CACHE_SCOPE = '1'
    return splitSysPromptPrefix(
      asSystemPrompt([
        'x-anthropic-billing-header: cc_version=99.0.0.abc; cc_entrypoint=cli;',
        'You are Claudin, an open-source coding agent and CLI.',
        'static harness text',
        ...(globalScope ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
        '# Memory\nproject memory section',
        ...(sessionId === null
          ? []
          : [SYSTEM_PROMPT_SESSION_MARKER, `Scratchpad directory: /tmp/p/${sessionId}/scratchpad`]),
        ...appended,
      ]),
      { skipGlobalCacheForSystemPrompt: skipGlobal },
    )
  }

  for (const { mode, globalScope, skipGlobal } of MODES) {
    test(`${mode}: the session element is the last block, uncached`, () => {
      const blocks = split(globalScope, skipGlobal, 'aaaa-1111')
      const last = blocks.at(-1)!
      expect(last.text).toBe('Scratchpad directory: /tmp/p/aaaa-1111/scratchpad')
      expect(last.cacheScope).toBeNull()
      for (const block of blocks) {
        expect(block.text).not.toContain(SYSTEM_PROMPT_SESSION_MARKER)
        expect(block.text).not.toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
      }
    })

    test(`${mode}: every block before it is the same in two sessions`, () => {
      const one = split(globalScope, skipGlobal, 'aaaa-1111')
      const two = split(globalScope, skipGlobal, 'bbbb-2222')
      expect(one.slice(0, -1)).toEqual(two.slice(0, -1))
      expect(one.at(-1)!.text).not.toBe(two.at(-1)!.text)
    })

    test(`${mode}: no new cached block, so no new breakpoint`, () => {
      const withSession = split(globalScope, skipGlobal, 'aaaa-1111')
      const without = split(globalScope, skipGlobal, null)
      expect(withSession.slice(0, -1)).toEqual(without)
      const cached = (bs: typeof without) => bs.filter(b => b.cacheScope !== null).length
      expect(cached(withSession)).toBe(cached(without))
    })
  }

  test('text appended after the session element stays in the cached block, in order', () => {
    const blocks = split(false, false, 'aaaa-1111', ['appended system prompt'])
    expect(blocks.at(-1)!.text).toBe('Scratchpad directory: /tmp/p/aaaa-1111/scratchpad')
    const cachedText = blocks.filter(b => b.cacheScope !== null).map(b => b.text).join('\n')
    expect(cachedText).toContain('project memory section\n\nappended system prompt')
  })
})

/**
 * The per-request user-context reminder. prependUserContext does nothing under
 * NODE_ENV=test, so each render switches that off for the one call.
 */
describe('prependUserContext', () => {
  const priorNodeEnv = process.env.NODE_ENV
  afterEach(() => {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = priorNodeEnv
  })

  function render(context: Record<string, string>): unknown {
    process.env.NODE_ENV = 'production'
    const [first] = prependUserContext([], context)
    return (first as { message: { content: unknown } }).message.content
  }

  test('the date goes out as a bare sentence, as Claude Code 2.1.284 sends it', () => {
    expect(render({ currentDate: "Today's date is 2026-09-29." })).toBe(
      "<system-reminder>\nToday's date is 2026-09-29.\n</system-reminder>\n",
    )
  })

  test('another key keeps its heading, with no preamble and no relevance disclaimer', () => {
    expect(
      render({
        currentDate: "Today's date is 2026-09-29.",
        workerToolsContext: 'Workers spawned via the Agent tool have access to these tools: Bash',
      }),
    ).toBe(
      "<system-reminder>\nToday's date is 2026-09-29.\n# workerToolsContext\nWorkers spawned via the Agent tool have access to these tools: Bash\n</system-reminder>\n",
    )
  })
})
