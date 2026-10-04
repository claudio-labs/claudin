/**
 * What the permission explainer asks the model, and what it hands back.
 *
 * The model call (`sideQuery`) is the one boundary replaced: every request is
 * recorded, and each test decides what the "model" answers. The config, the
 * model choice and the message history are the real ones.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const realSideQueryModule = { ...(await import('src/agent/sideQuery.js')) }
type Ask = Parameters<typeof realSideQueryModule.sideQuery>[0]

const asked: Ask[] = []
let reply: (ask: Ask) => Promise<unknown> = () => Promise.reject(new Error('no reply was set up'))
mock.module('src/agent/sideQuery.js', () => ({
  ...realSideQueryModule,
  sideQuery: (ask: Ask) => {
    asked.push(ask)
    return reply(ask)
  },
}))
afterAll(() => {
  mock.module('src/agent/sideQuery.js', () => realSideQueryModule)
})

const { generatePermissionExplanation, isPermissionExplainerEnabled } = await import('src/permissions/permissionExplainer.js')
const { resetGlobalConfigForTests, saveGlobalConfig } = await import('src/platform/config/config.js')
const { getMainLoopModelOverride, setMainLoopModelOverride } = await import('src/platform/bootstrap/state.js')
const { createAssistantMessage, createUserMessage } = await import('src/agent/messages/factories.js')
const { getInMemoryErrors } = await import('src/shared/log.js')

type Message = import('src/shared/types/message.js').Message

const MODEL = 'wren-explainer-model-7'
let previousModel: ReturnType<typeof getMainLoopModelOverride>

beforeEach(() => {
  asked.length = 0
  reply = () => Promise.reject(new Error('no reply was set up'))
  previousModel = getMainLoopModelOverride()
  setMainLoopModelOverride(MODEL)
})
afterEach(() => {
  setMainLoopModelOverride(previousModel)
  // The reset copies the defaults over the test config, and the defaults have
  // no entry for this key, so it has to be cleared by hand.
  saveGlobalConfig(config => ({ ...config, permissionExplainerEnabled: undefined }))
  resetGlobalConfigForTests()
})

/** A model reply that calls the forced tool with `input`. */
const toolReply = (input: unknown, extra: object[] = []) => ({
  id: 'msg_wren',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  stop_reason: 'tool_use',
  content: [...extra, { type: 'tool_use', id: 'toolu_wren', name: 'explain_command', input }],
})

const GOOD = {
  riskLevel: 'MEDIUM',
  explanation: 'Deletes the build output folder.',
  reasoning: 'I want a clean rebuild.',
  risk: 'Unsaved artefacts vanish',
}

const run = (overrides: Partial<Parameters<typeof generatePermissionExplanation>[0]> = {}) =>
  generatePermissionExplanation({
    toolName: 'Bash',
    toolInput: { command: 'rm -rf dist' },
    signal: new AbortController().signal,
    ...overrides,
  })

/** The single user turn the model received. */
function promptOf(ask: Ask | undefined): string {
  if (!ask) throw new Error('the model was never asked')
  expect(ask.messages).toHaveLength(1)
  const [turn] = ask.messages
  expect(turn!.role).toBe('user')
  expect(typeof turn!.content).toBe('string')
  return turn!.content as string
}

describe('the on/off switch', () => {
  const cases: Array<[string, boolean | undefined, boolean]> = [
    ['left unset', undefined, true],
    ['turned on', true, true],
    ['turned off', false, false],
  ]
  for (const [label, setting, enabled] of cases) {
    test(`config ${label} → enabled is ${enabled}`, async () => {
      saveGlobalConfig(config => ({ ...config, permissionExplainerEnabled: setting }))
      expect(isPermissionExplainerEnabled()).toBe(enabled)
      reply = async () => toolReply(GOOD)
      const outcome = await run()
      if (enabled) {
        expect(asked).toHaveLength(1)
        expect(outcome).not.toBeNull()
      } else {
        expect(asked).toHaveLength(0)
        expect(outcome).toBeNull()
      }
    })
  }
})

describe('the request', () => {
  test('goes to the main-loop model with one forced tool, the caller signal and nothing else', async () => {
    reply = async () => toolReply(GOOD)
    const signal = new AbortController().signal
    await run({ signal })
    expect(asked).toHaveLength(1)
    const ask = asked[0]!
    expect(Object.keys(ask).sort()).toEqual(['messages', 'model', 'signal', 'system', 'tool_choice', 'tools'])
    expect(ask.model).toBe(MODEL)
    expect(ask.signal).toBe(signal)
    expect(ask.tool_choice as unknown).toEqual({ type: 'tool', name: 'explain_command' })
  })

  test('the system text asks for what a shell command does, why, and its risks', async () => {
    reply = async () => toolReply(GOOD)
    await run()
    const system = asked[0]!.system
    expect(typeof system).toBe('string')
    const lower = (system as string).toLowerCase()
    for (const fact of ['shell command', 'what they do', 'why', 'risk']) expect(lower).toContain(fact)
  })

  test('the forced tool asks for four strings, all required, with a three-level risk enum', async () => {
    reply = async () => toolReply(GOOD)
    await run()
    const tools = asked[0]!.tools as unknown as Array<{
      name: string
      description: string
      input_schema: { type: string; properties: Record<string, { type: string; enum?: string[]; description: string }>; required: string[] }
    }>
    expect(tools).toHaveLength(1)
    const [tool] = tools
    expect(tool!.name).toBe('explain_command')
    expect(tool!.description.toLowerCase()).toContain('shell command')
    expect(tool!.input_schema.type).toBe('object')
    expect([...tool!.input_schema.required].sort()).toEqual(['explanation', 'reasoning', 'risk', 'riskLevel'])
    const props = tool!.input_schema.properties
    expect(Object.keys(props).sort()).toEqual(['explanation', 'reasoning', 'risk', 'riskLevel'])
    for (const field of Object.values(props)) expect(field.type).toBe('string')
    expect(props.riskLevel!.enum).toEqual(['LOW', 'MEDIUM', 'HIGH'])
  })

  // Facts each field description must carry, matched loosely.
  const fieldFacts: Array<[string, RegExp[]]> = [
    ['explanation', [/what this command does/i, /1-2 sentences/]],
    ['reasoning', [/why you/i, /start with "I"/i]],
    ['risk', [/could go wrong/i, /under 15 words/]],
    ['riskLevel', [/LOW \(safe dev/, /MEDIUM \(recoverable/, /HIGH \(dangerous/]],
  ]
  for (const [field, facts] of fieldFacts) {
    test(`the ${field} field tells the model ${facts.length} things`, async () => {
      reply = async () => toolReply(GOOD)
      await run()
      const tool = (asked[0]!.tools as unknown as Array<{ input_schema: { properties: Record<string, { description: string }> } }>)[0]!
      for (const fact of facts) expect(tool.input_schema.properties[field]!.description).toMatch(fact)
    })
  }
})

describe('the prompt text', () => {
  test('names the tool, shows the input under its own header and ends on the ask', async () => {
    reply = async () => toolReply(GOOD)
    await run({ toolName: 'PowerShell', toolInput: 'Get-ChildItem C:\\' })
    const prompt = promptOf(asked[0])
    const lines = prompt.split('\n')
    expect(lines[0]).toBe('Tool: PowerShell')
    const inputAt = lines.indexOf('Input:')
    expect(inputAt).toBeGreaterThan(0)
    expect(lines[inputAt + 1]).toBe('Get-ChildItem C:\\')
    expect(lines.at(-1)).toBe('Explain this command in context.')
    expect(prompt).not.toContain('Description:')
    expect(prompt).not.toContain('Recent conversation context')
  })

  test('a description, when given, sits between the tool line and the input', async () => {
    reply = async () => toolReply(GOOD)
    await run({ toolDescription: 'Wipe the dist folder' })
    const lines = promptOf(asked[0]).split('\n')
    const describedAt = lines.indexOf('Description: Wipe the dist folder')
    expect(describedAt).toBe(1)
    expect(lines.indexOf('Input:')).toBeGreaterThan(describedAt)
  })

  const circular: Record<string, unknown> = { name: 'loop' }
  circular.self = circular
  const inputs: Array<[string, unknown, string]> = [
    ['a string goes in verbatim', 'ls -la\n| wc', 'ls -la\n| wc'],
    ['an object is JSON with two-space indent', { command: 'ls', timeout: 5 }, '{\n  "command": "ls",\n  "timeout": 5\n}'],
    ['an array is JSON too', ['a', 1], '[\n  "a",\n  1\n]'],
    ['a number is JSON', 42, '42'],
    ['a value JSON refuses falls back to its string form', 9n, '9'],
    ['a cycle falls back to its string form', circular, '[object Object]'],
  ]
  for (const [label, input, shown] of inputs) {
    test(`input: ${label}`, async () => {
      reply = async () => toolReply(GOOD)
      await run({ toolInput: input })
      const prompt = promptOf(asked[0])
      expect(prompt).toContain(`\nInput:\n${shown}\n`)
    })
  }
})

describe('the conversation context', () => {
  const said = (text: string) => createAssistantMessage({ content: text })
  const context = (prompt: string) => {
    const header = '\nRecent conversation context:\n'
    const at = prompt.indexOf(header)
    if (at < 0) return null
    return prompt.slice(at + header.length, prompt.lastIndexOf('\n\nExplain this command in context.'))
  }

  test('carries the text of the last three assistant turns, oldest first, a blank line apart', async () => {
    reply = async () => toolReply(GOOD)
    const messages: Message[] = [
      said('first plan'),
      createUserMessage({ content: 'user words never travel' }),
      said('second plan'),
      said('third plan'),
      createUserMessage({ content: 'more user words' }),
      said('fourth plan'),
    ]
    await run({ messages })
    expect(context(promptOf(asked[0]))).toBe('second plan\n\nthird plan\n\nfourth plan')
  })

  test('joins the text blocks of a turn with a space and skips its other blocks', async () => {
    reply = async () => toolReply(GOOD)
    const mixed = createAssistantMessage({
      content: [
        { type: 'text', text: 'I will list', citations: null },
        { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } },
        { type: 'text', text: 'the files.', citations: null },
      ] as never,
    })
    await run({ messages: [mixed] })
    expect(context(promptOf(asked[0]))).toBe('I will list the files.')
  })

  const quiet: Array<[string, Message[]]> = [
    ['no history at all', []],
    ['only user turns', [createUserMessage({ content: 'hello' })]],
    ['an assistant turn with no text', [createAssistantMessage({ content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] as never })]],
  ]
  for (const [label, messages] of quiet) {
    test(`no context section with ${label}`, async () => {
      reply = async () => toolReply(GOOD)
      await run({ messages })
      expect(context(promptOf(asked[0]))).toBeNull()
    })
  }

  test('a turn too long for the budget is cut to 1000 characters plus an ellipsis', async () => {
    reply = async () => toolReply(GOOD)
    const long = 'x'.repeat(1500)
    await run({ messages: [said('older words'), said(long)] })
    expect(context(promptOf(asked[0]))).toBe(`${'x'.repeat(1000)}...`)
  })

  test('the newest turn gets the budget first; an older one gets what is left', async () => {
    reply = async () => toolReply(GOOD)
    await run({ messages: [said('a'.repeat(700)), said('b'.repeat(400)), said('c'.repeat(300))] })
    expect(context(promptOf(asked[0]))).toBe(`${'a'.repeat(300)}...\n\n${'b'.repeat(400)}\n\n${'c'.repeat(300)}`)
  })

  test('a turn that exactly fits the remaining budget is kept whole', async () => {
    reply = async () => toolReply(GOOD)
    await run({ messages: [said('older'), said('d'.repeat(1000))] })
    expect(context(promptOf(asked[0]))).toBe('d'.repeat(1000))
  })
})

describe('the answer', () => {
  // The test preload limits traffic to the essential, which also keeps errors
  // out of the in-memory log; open it for this block so error records show.
  let traffic: string | undefined
  beforeEach(() => {
    traffic = process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC
    process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  })
  afterEach(() => {
    if (traffic === undefined) delete process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC
    else process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = traffic
  })

  test('a well-formed tool call comes back as the four fields, extra fields dropped', async () => {
    reply = async () => toolReply({ ...GOOD, confidence: 'high' }, [{ type: 'text', text: 'thinking aloud' }])
    expect(await run()).toEqual(GOOD as unknown as Awaited<ReturnType<typeof run>>)
  })

  for (const level of ['LOW', 'MEDIUM', 'HIGH']) {
    test(`risk level ${level} is accepted`, async () => {
      reply = async () => toolReply({ ...GOOD, riskLevel: level })
      expect((await run())?.riskLevel as unknown).toBe(level)
    })
  }

  const unusable: Array<[string, () => unknown]> = [
    ['a risk level outside the enum', () => toolReply({ ...GOOD, riskLevel: 'CRITICAL' })],
    ['a lowercase risk level', () => toolReply({ ...GOOD, riskLevel: 'low' })],
    ['a missing field', () => toolReply({ riskLevel: 'LOW', explanation: 'e', reasoning: 'r' })],
    ['a field of the wrong type', () => toolReply({ ...GOOD, risk: 3 })],
    ['text only, no tool call', () => ({ ...toolReply(GOOD), content: [{ type: 'text', text: 'LOW risk' }] })],
    ['an empty reply', () => ({ ...toolReply(GOOD), content: [] })],
  ]
  for (const [label, make] of unusable) {
    test(`null for ${label}, and nothing is logged as an error`, async () => {
      const before = getInMemoryErrors().length
      reply = async () => make()
      expect(await run()).toBeNull()
      expect(getInMemoryErrors().length).toBe(before)
    })
  }

  test('a failing call resolves to null and is recorded as an error', async () => {
    const before = getInMemoryErrors().length
    reply = () => Promise.reject(new Error('wren upstream exploded'))
    expect(await run()).toBeNull()
    const added = getInMemoryErrors().slice(before)
    expect(added.some(entry => entry.error.includes('wren upstream exploded'))).toBe(true)
  })

  test('a call that fails after the caller aborted resolves to null without an error record', async () => {
    const before = getInMemoryErrors().length
    const controller = new AbortController()
    reply = () => {
      controller.abort()
      return Promise.reject(new Error('wren aborted midway'))
    }
    expect(await run({ signal: controller.signal })).toBeNull()
    expect(getInMemoryErrors().slice(before).some(entry => entry.error.includes('wren aborted midway'))).toBe(false)
  })
})
