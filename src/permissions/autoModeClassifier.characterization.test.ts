/**
 * The auto-mode classifier as a caller sees it: what it sends to the model,
 * and what verdict comes back for every kind of answer, failure and delay.
 *
 * The model is the one thing faked, at the side-query boundary. The suite runs
 * with every build flag off (the `bun test` default); the flag-on behaviour
 * lives in `autoModeClassifier.shipped.characterization.test.tsx`.
 *
 * Security rule under test throughout: anything other than a clean "allow"
 * from the model must come back as `shouldBlock: true`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  answers,
  answersLate,
  assistantDoes,
  BASE_TEMPLATE,
  callsTool,
  createModelDouble,
  fails,
  hangs,
  lastUserBlocks,
  lastUserText,
  permissionContext,
  RULES_TEMPLATE,
  says,
  type SentRequest,
  shellTool,
  silentTool,
  structuredTool,
  systemText,
  toolbox,
  toolUse,
  useClassifierScene,
  userSays,
} from 'src/permissions/__testutils__/autoModeClassifierScene.js'
import type { Message } from 'src/shared/types/message.js'

// The real module is copied before the stub lands; the copy is what goes back.
const realSideQueryModule = { ...(await import('src/agent/sideQuery.js')) }
const model = createModelDouble()
mock.module('src/agent/sideQuery.js', () => ({
  ...realSideQueryModule,
  sideQuery: model.sideQuery,
}))

const {
  __setClassifierPromptsForTests,
  buildYoloSystemPrompt,
  classifyYoloAction,
  formatActionForClassifier,
  getAutoModeClassifierErrorDumpPath,
} = await import('src/permissions/yoloClassifier.js')
const {
  __setBashClassifierEnabledForTests,
  classifyBashCommand,
  generateGenericDescription,
} = await import('src/permissions/bashClassifier.js')
const { getLastClassifierRequests, getSessionId, setCachedClaudeMdContent } = await import(
  'src/platform/bootstrap/state.js'
)

const scene = useClassifierScene()

afterAll(() => {
  __setClassifierPromptsForTests(null)
  __setBashClassifierEnabledForTests(undefined)
  mock.module('src/agent/sideQuery.js', () => realSideQueryModule)
})

beforeEach(() => {
  model.reset()
  __setClassifierPromptsForTests({ basePrompt: BASE_TEMPLATE, externalTemplate: RULES_TEMPLATE })
  scene().useModel(TOOL_USE_MODEL)
  delete process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS
  setCachedClaudeMdContent(null)
})

/** A model the tool_use classifier serves. */
const TOOL_USE_MODEL = 'claude-sonnet-4-6'
/** A model with always-on thinking, which the XML classifier serves. */
const XML_MODEL = 'claude-fable-5'

const tools = toolbox(shellTool, silentTool, structuredTool)
const history: Message[] = [
  userSays('clean the build output'),
  assistantDoes([{ type: 'text', text: 'Sure, cleaning.' }, toolUse('Bash', { command: 'ls build' })]),
]

function judge(
  options: {
    action?: ReturnType<typeof formatActionForClassifier>
    messages?: Message[]
    signal?: AbortSignal
    mode?: string
  } = {},
) {
  return classifyYoloAction(
    options.messages ?? history,
    options.action ?? formatActionForClassifier('Bash', { command: 'rm -rf build' }),
    tools,
    permissionContext({ mode: options.mode ?? 'auto' }),
    options.signal ?? new AbortController().signal,
  )
}

const ALLOW_TOOL = { thinking: 'only removes build output', shouldBlock: false, reason: 'cleanup in the repo' }
const BLOCK_TOOL = { thinking: 'deletes outside', shouldBlock: true, reason: 'destroys user data' }

function apiError(status: number, message = 'request rejected'): APIError {
  return new APIError(status, { type: 'error', error: { type: 'invalid_request_error', message } }, message, new Headers())
}

// ─────────────────────────────────────────────────────────────────────────────

describe('decisions made without asking the model', () => {
  test('with no prompt templates bundled every action is allowed, with one warning per process', async () => {
    const writes: string[] = []
    const stderr = spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    try {
      __setClassifierPromptsForTests(null)
      const first = await judge()
      const second = await judge()
      expect(first).toEqual({
        shouldBlock: false,
        reason: expect.stringContaining('not bundled'),
        model: TOOL_USE_MODEL,
      })
      expect(second.shouldBlock).toBe(false)
      expect(model.sent).toHaveLength(0)

      const warnings = writes.filter(line => line.includes('not bundled'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('auto-mode classifier')
      expect(warnings[0]).toMatch(/auto-allow/)
      expect(warnings[0]).toContain('permissions.deny')

      // Resetting the templates re-arms the warning.
      __setClassifierPromptsForTests(null)
      await judge()
      expect(writes.filter(line => line.includes('not bundled'))).toHaveLength(2)
    } finally {
      stderr.mockRestore()
    }
  })

  const nothingToJudge: Array<[string, ReturnType<typeof formatActionForClassifier>]> = [
    ['a tool that declares no relevant input', formatActionForClassifier('Quiet', { anything: 1 })],
    ['a tool missing from the tool list', formatActionForClassifier('Unknown', { command: 'rm -rf /' })],
    ['an assistant action made only of text', { role: 'assistant', content: [{ type: 'text', text: 'rm -rf /' }] }],
  ]
  for (const [label, action] of nothingToJudge) {
    test(`${label} is allowed without a model call`, async () => {
      const verdict = await judge({ action })
      expect(verdict).toEqual({
        shouldBlock: false,
        reason: 'Tool declares no classifier-relevant input',
        model: TOOL_USE_MODEL,
      })
      expect(model.sent).toHaveLength(0)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the tool_use classifier', () => {
  test('sends one forced classify_result call carrying the prompt, the transcript and the action', async () => {
    model.queue(callsTool('classify_result', ALLOW_TOOL))
    await judge()

    expect(model.sent).toHaveLength(1)
    const request = model.sent[0]!
    expect(request.model).toBe(TOOL_USE_MODEL)
    expect(request.max_tokens).toBe(4096)
    expect(request.temperature).toBe(0)
    expect(request.thinking).toBe(false)
    expect(request.maxRetries).toBe(0)
    expect(request.stop_sequences).toBeUndefined()
    expect(request.tools?.map(tool => tool.name)).toEqual(['classify_result'])
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'classify_result' })

    const system = request.system as Array<{ text: string; cache_control?: { type: string } }>
    expect(system).toHaveLength(1)
    expect(system[0]!.text).toBe(await buildYoloSystemPrompt(permissionContext()))
    expect(system[0]!.cache_control?.type).toBe('ephemeral')

    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]!.role).toBe('user')
    const blocks = lastUserBlocks(request)
    expect(blocks.map(block => block.text)).toEqual([
      'User: clean the build output\n',
      'Bash ls build\n',
      'Bash rm -rf build\n',
    ])
    // Only the action block is a cache breakpoint.
    expect(blocks.map(block => block.cache_control !== undefined)).toEqual([false, false, true])
  })

  const verdicts: Array<[string, () => ReturnType<typeof callsTool>, { shouldBlock: boolean; reason: string | RegExp }]> = [
    ['an allow', () => callsTool('classify_result', ALLOW_TOOL), { shouldBlock: false, reason: 'cleanup in the repo' }],
    ['a block', () => callsTool('classify_result', BLOCK_TOOL), { shouldBlock: true, reason: 'destroys user data' }],
    ['a text answer', () => says('{"shouldBlock": false}'), { shouldBlock: true, reason: /no tool use block/ }],
    ['a call to another tool', () => callsTool('classify_match', ALLOW_TOOL), { shouldBlock: true, reason: /no tool use block/ }],
    [
      'a verdict typed as a string',
      () => callsTool('classify_result', { ...ALLOW_TOOL, shouldBlock: 'false' }),
      { shouldBlock: true, reason: /Invalid classifier response/ },
    ],
    [
      'a verdict without a reason',
      () => callsTool('classify_result', { thinking: 'x', shouldBlock: false }),
      { shouldBlock: true, reason: /Invalid classifier response/ },
    ],
    [
      'a verdict without thinking',
      () => callsTool('classify_result', { shouldBlock: false, reason: 'fine' }),
      { shouldBlock: true, reason: /Invalid classifier response/ },
    ],
  ]
  for (const [label, reply, expected] of verdicts) {
    test(`${label} comes back as shouldBlock=${expected.shouldBlock}`, async () => {
      model.queue(reply())
      const verdict = await judge()
      expect(verdict.shouldBlock).toBe(expected.shouldBlock)
      if (typeof expected.reason === 'string') expect(verdict.reason).toBe(expected.reason)
      else expect(verdict.reason).toMatch(expected.reason)
      // An answer the model did give is never "unavailable".
      expect(verdict.unavailable).toBeFalsy()
      expect(verdict.timedOut).toBeFalsy()
    })
  }

  test("the action's own size comes out of the transcript budget", async () => {
    // 200,000 characters in all: the action leaves 20 for the transcript.
    const target = 't'.repeat(200_000 - 20 - 'Deploy {"target":"","force":false}\n'.length)
    model.queue(callsTool('classify_result', ALLOW_TOOL))
    await judge({ action: formatActionForClassifier('Deploy', { target }) })
    const texts = lastUserBlocks(model.sent[0]!).map(block => block.text)
    expect(texts).toEqual(['Bash ls build\n', `Deploy {"target":"${target}","force":false}\n`])
  })

  test('a verdict carries the thinking, the usage, the request id, the timing and the prompt sizes', async () => {
    model.queue(callsTool('classify_result', ALLOW_TOOL, { usage: { input: 120, output: 9, cacheRead: 40 }, requestId: 'req_tool' }))
    const verdict = await judge()
    const system = await buildYoloSystemPrompt(permissionContext())

    expect(verdict).toMatchObject({
      thinking: 'only removes build output',
      model: TOOL_USE_MODEL,
      usage: { inputTokens: 120, outputTokens: 9, cacheReadInputTokens: 40, cacheCreationInputTokens: 0 },
      stage1RequestId: 'req_tool',
      promptLengths: {
        systemPrompt: system.length,
        toolCalls: 'Bash ls build\n'.length + 'Bash rm -rf build\n'.length,
        userPrompts: 'User: clean the build output\n'.length,
      },
    })
    expect(verdict.durationMs).toBeGreaterThanOrEqual(0)
    expect(verdict.stage).toBeUndefined()
    expect(getLastClassifierRequests()).toEqual([model.sent[0]])
  })

  test("the user's CLAUDE.md rides in front of the transcript as a cached message of its own", async () => {
    setCachedClaudeMdContent('Never touch the deploy/ directory.')
    model.queue(callsTool('classify_result', ALLOW_TOOL))
    await judge()

    const [instructions, transcript] = model.sent[0]!.messages
    expect(transcript).toBeDefined()
    expect(instructions!.role).toBe('user')
    const block = (instructions!.content as Array<{ text: string; cache_control?: { type: string } }>)[0]!
    expect(block.text).toContain('<user_claude_md>\nNever touch the deploy/ directory.\n</user_claude_md>')
    expect(block.text).toContain('CLAUDE.md')
    expect(block.text).toMatch(/intent/)
    expect(block.cache_control?.type).toBe('ephemeral')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the two-stage XML classifier', () => {
  beforeEach(() => scene().useModel(XML_MODEL))

  test('stage 1 asks for an immediate <block> verdict, without tools, and stops at </block>', async () => {
    model.queue(says('<block>no</block>', { requestId: 'req_fast', usage: { input: 50, output: 2 } }))
    const verdict = await judge()

    expect(model.sent).toHaveLength(1)
    const request = model.sent[0]!
    expect(request.model).toBe(XML_MODEL)
    expect(request.stop_sequences).toEqual(['</block>'])
    expect(request.tools).toBeUndefined()
    expect(request.tool_choice).toBeUndefined()
    expect(request.temperature).toBe(0)
    // Always-on thinking gets headroom on top of the 64-token verdict budget.
    expect(request.max_tokens).toBe(64 + 2048)

    const system = systemText(request)
    expect(system).not.toContain('Use the classify_result tool')
    expect(system).toContain('<block>yes</block><reason>')
    expect(system).toContain('<block>no</block>')
    expect(system).toMatch(/begin with <block>/)
    expect(system).toContain('read files in the repository')

    const blocks = lastUserBlocks(request)
    expect(blocks[0]!.text).toBe('<transcript>\n')
    expect(blocks.at(-2)!.text).toBe('</transcript>\n')
    expect(blocks.at(-3)).toMatchObject({ text: 'Bash rm -rf build\n' })
    expect(blocks.at(-3)!.cache_control).toBeDefined()
    const suffix = blocks.at(-1)!.text!
    expect(suffix).toContain('<block>')
    expect(suffix).toMatch(/immediately/)
    expect(suffix).toMatch(/blocking/)

    expect(verdict).toMatchObject({
      shouldBlock: false,
      stage: 'fast',
      model: XML_MODEL,
      stage1RequestId: 'req_fast',
      usage: { inputTokens: 50, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    })
    expect(verdict.reason).toMatch(/fast/)
    expect(getLastClassifierRequests()).toEqual([request])
  })

  const fastAllows: Array<[string, ReturnType<typeof says>]> = [
    ['a closed tag', says('<block>no</block>')],
    ['a tag cut by the stop sequence', says('<block>no')],
    ['any letter case', says('<BLOCK>No</BLOCK>')],
    ['a verdict split over two text blocks', answers([{ type: 'text', text: '<block>' }, { type: 'text', text: 'no' }])],
  ]
  for (const [label, reply] of fastAllows) {
    test(`stage 1 allows on ${label}`, async () => {
      model.queue(reply)
      const verdict = await judge()
      expect(verdict.shouldBlock).toBe(false)
      expect(model.sent).toHaveLength(1)
    })
  }

  const escalations: Array<[string, ReturnType<typeof says>]> = [
    ['a block', says('<block>yes</block>')],
    ['a word that only starts like a verdict', says('<block>noted</block>')],
    ['no tag at all', says('Looks harmless to me.')],
    ['an empty answer', says('')],
    ['an allow written inside its reasoning', says('<thinking>maybe <block>no</block></thinking>')],
    ['an allow inside unfinished reasoning', says('<thinking>so <block>no')],
    [
      'an allow inside a thinking block of the API',
      answers([{ type: 'thinking', thinking: '<block>no</block>', signature: 's' }, { type: 'text', text: '<block>yes' }]),
    ],
  ]
  for (const [label, reply] of escalations) {
    test(`stage 1 escalates to stage 2 on ${label}`, async () => {
      model.queue(reply, says('<thinking>removing a dir</thinking><block>yes</block><reason>too broad</reason>'))
      const verdict = await judge()
      expect(model.sent).toHaveLength(2)
      expect(verdict).toMatchObject({ shouldBlock: true, stage: 'thinking', reason: 'too broad' })
    })
  }

  test('stage 2 reuses the prompt and transcript, asks for reasoning first, and gets a larger budget', async () => {
    model.queue(says('<block>yes'), says('<block>no</block>'))
    await judge()

    const [fast, thinking] = model.sent as [SentRequest, SentRequest]
    expect(thinking.max_tokens).toBe(4096 + 2048)
    expect(thinking.stop_sequences).toBeUndefined()
    expect(thinking.tools).toBeUndefined()
    expect(systemText(thinking)).toBe(systemText(fast))
    expect(lastUserBlocks(thinking).slice(0, -1)).toEqual(lastUserBlocks(fast).slice(0, -1))

    const suffix = lastUserBlocks(thinking).at(-1)!.text!
    expect(suffix).not.toBe(lastUserBlocks(fast).at(-1)!.text)
    expect(suffix).toContain('<thinking>')
    expect(suffix).toContain('<block>')
    expect(suffix).toMatch(/explicit/)
    expect(getLastClassifierRequests()).toEqual([fast, thinking])
  })

  test('a stage 2 verdict reports both stages', async () => {
    model.queue(
      says('<block>yes', { usage: { input: 50, output: 2 }, requestId: 'req_1' }),
      says('<thinking>\n  wipes the tree\n</thinking><block>yes</block><reason> recursive delete </reason>', {
        usage: { input: 60, output: 30, cacheRead: 50 },
        requestId: 'req_2',
      }),
    )
    const verdict = await judge()
    expect(verdict).toMatchObject({
      shouldBlock: true,
      thinking: 'wipes the tree',
      reason: 'recursive delete',
      stage: 'thinking',
      stage1RequestId: 'req_1',
      stage2RequestId: 'req_2',
      stage1Usage: { inputTokens: 50, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      stage2Usage: { inputTokens: 60, outputTokens: 30, cacheReadInputTokens: 50, cacheCreationInputTokens: 0 },
      usage: { inputTokens: 110, outputTokens: 32, cacheReadInputTokens: 50, cacheCreationInputTokens: 0 },
    })
    expect(verdict.stage1DurationMs).toBeGreaterThanOrEqual(0)
    expect(verdict.stage2DurationMs).toBeGreaterThanOrEqual(0)
    expect(verdict.unavailable).toBeFalsy()
  })

  test('a stage 2 allow needs no reason, and a reason inside the reasoning does not count', async () => {
    model.queue(says('<block>yes'), says('<thinking>no <reason>hidden</reason></thinking><block>no</block>'))
    const verdict = await judge()
    expect(verdict).toMatchObject({ shouldBlock: false, reason: 'No reason provided', stage: 'thinking' })
  })

  test('stage 2 reads the first verdict outside its reasoning', async () => {
    model.queue(says('<block>yes'), says('<thinking><block>no</block></thinking><block>yes</block>'))
    expect((await judge()).shouldBlock).toBe(true)
  })

  const retried: Array<[string, ReturnType<typeof says>]> = [
    ['ran out of budget', says('<thinking>a very long chain of thought', { stop: 'max_tokens', usage: { output: 6144 } })],
    ['came back empty', says('   ')],
  ]
  for (const [label, first] of retried) {
    test(`a stage 2 answer that ${label} is retried once with double the budget`, async () => {
      model.queue(
        says('<block>yes', { usage: { input: 1, output: 1 } }),
        first,
        says('<block>no</block>', { usage: { input: 5, output: 7 } }),
      )
      const verdict = await judge()
      expect(model.sent.map(request => request.max_tokens)).toEqual([64 + 2048, 4096 + 2048, 8192 + 2048])
      expect(verdict.shouldBlock).toBe(false)
      expect(verdict.stage2Usage?.inputTokens).toBe(10 + 5)
      expect(getLastClassifierRequests()).toEqual([model.sent[0], model.sent[2]])
    })
  }

  test('an answer that had room and gave no verdict is final, and blocks with the reason it could not be read', async () => {
    model.queue(says('<block>yes'), says('I would rather not say.', { usage: { output: 7 } }))
    const verdict = await judge()
    expect(model.sent).toHaveLength(2)
    expect({ block: verdict.shouldBlock, unavailable: Boolean(verdict.unavailable), stage: verdict.stage }).toEqual({
      block: true,
      unavailable: false,
      stage: 'thinking',
    })
    const facts = ['unparseable', 'stop_reason=end_turn', '7 output tokens', 'no <block> tag']
    expect(facts.filter(fact => !verdict.reason.includes(fact))).toEqual([])
  })

  test('two unreadable stage 2 answers block, naming the second', async () => {
    model.queue(
      says('<block>yes'),
      says('<thinking>long', { stop: 'max_tokens' }),
      says('', { stop: null, usage: { output: 0 } }),
    )
    const verdict = await judge()
    expect(model.sent).toHaveLength(3)
    expect(verdict.shouldBlock).toBe(true)
    expect(verdict.reason).toContain('stop_reason=unknown')
    expect(verdict.reason).toContain('0 output tokens')
    expect(verdict.reason).toContain('empty response')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('failing safe', () => {
  const routes: Array<[string, string]> = [
    ['tool_use', TOOL_USE_MODEL],
    ['XML', XML_MODEL],
  ]
  const failures: Array<[string, unknown, { reason: RegExp; deterministic: boolean; transcriptTooLong: boolean }]> = [
    ['a network failure', new Error('socket hang up'), { reason: /unavailable/, deterministic: false, transcriptTooLong: false }],
    ['a 400', apiError(400), { reason: /deterministic/, deterministic: true, transcriptTooLong: false }],
    ['a 401', apiError(401), { reason: /deterministic/, deterministic: true, transcriptTooLong: false }],
    ['a 404', apiError(404), { reason: /deterministic/, deterministic: true, transcriptTooLong: false }],
    ['a 408', apiError(408), { reason: /unavailable/, deterministic: false, transcriptTooLong: false }],
    ['a 409', apiError(409), { reason: /unavailable/, deterministic: false, transcriptTooLong: false }],
    ['a 429', apiError(429), { reason: /unavailable/, deterministic: false, transcriptTooLong: false }],
    ['a 500', apiError(500), { reason: /unavailable/, deterministic: false, transcriptTooLong: false }],
    [
      'a prompt that is too long',
      apiError(400, 'prompt is too long: 250000 tokens > 200000 maximum'),
      { reason: /context window/, deterministic: false, transcriptTooLong: true },
    ],
    [
      'a too-long prompt with no token counts',
      new Error('Prompt is too long'),
      { reason: /context window/, deterministic: false, transcriptTooLong: true },
    ],
  ]
  for (const [route, modelName] of routes) {
    for (const [label, error, expected] of failures) {
      test(`${route}: ${label} blocks and marks the classifier unavailable`, async () => {
        scene().useModel(modelName)
        model.queue(fails(error))
        const verdict = await judge()
        expect(model.sent).toHaveLength(1)
        expect(verdict).toMatchObject({
          shouldBlock: true,
          unavailable: true,
          deterministic: expected.deterministic,
          transcriptTooLong: expected.transcriptTooLong,
          model: modelName,
        })
        expect(verdict.reason).toMatch(expected.reason)
        expect(verdict.stage).toBeUndefined()
        expect(verdict.errorDumpPath).toBe(getAutoModeClassifierErrorDumpPath())
      })
    }
  }

  test('a failed stage 2 blocks on the stage 1 assessment, which was an answer', async () => {
    scene().useModel(XML_MODEL)
    model.queue(says('<block>yes', { usage: { input: 8, output: 1 }, requestId: 'req_s1' }), fails(apiError(400)))
    const verdict = await judge()
    expect(verdict).toMatchObject({
      shouldBlock: true,
      unavailable: false,
      deterministic: false,
      transcriptTooLong: false,
      stage: 'thinking',
      stage1RequestId: 'req_s1',
      usage: { inputTokens: 8, outputTokens: 1 },
    })
    expect(verdict.reason).toMatch(/stage 1/)
  })

  test('a stage 2 that overflows the context still says so', async () => {
    scene().useModel(XML_MODEL)
    model.queue(says('<block>yes'), fails(new Error('prompt is too long: 9 tokens > 8 maximum')))
    const verdict = await judge()
    expect(verdict).toMatchObject({ shouldBlock: true, unavailable: false, transcriptTooLong: true })
    expect(verdict.reason).toMatch(/context window/)
  })

  test('the failed request is written to a session-scoped dump, in a fixed format', async () => {
    model.queue(fails(new Error('upstream exploded')))
    const verdict = await judge({ messages: [] })

    const uid = process.getuid?.() ?? 0
    const expectedPath = join(realpathSync(scene().tempBase), `claude-${uid}`, 'auto-mode-classifier-errors', `${getSessionId()}.txt`)
    expect(getAutoModeClassifierErrorDumpPath()).toBe(expectedPath)
    expect(verdict.errorDumpPath).toBe(expectedPath)

    const written = readFileSync(expectedPath, 'utf8')
    const timestamp = /^timestamp: (.+)$/m.exec(written)?.[1]
    expect(new Date(timestamp!).toISOString()).toBe(timestamp!)
    const fixture = readFileSync(join(import.meta.dir, '__fixtures__/rewrite/classifierErrorDump.txt'), 'utf8')
    expect(written.replace(timestamp!, '<timestamp>')).toBe(fixture)
  })

  test('the XML route dumps the prompt it actually sent', async () => {
    scene().useModel(XML_MODEL)
    model.queue(fails(new Error('upstream exploded')))
    const verdict = await judge()
    const dumped = readFileSync(verdict.errorDumpPath!, 'utf8')
    const shows = (text: string) => dumped.includes(text)
    expect([`model: ${XML_MODEL}`, '<block>yes</block><reason>'].every(shows)).toBe(true)
    expect(shows('Use the classify_result tool')).toBe(false)
  })

  test('a dump that cannot be written leaves the verdict without a path', async () => {
    const dumpPath = getAutoModeClassifierErrorDumpPath()
    rmSync(dirname(dumpPath), { recursive: true, force: true })
    mkdirSync(dirname(dirname(dumpPath)), { recursive: true })
    // A plain file where the dump directory should be.
    writeFileSync(dirname(dumpPath), 'in the way')
    try {
      model.queue(fails(new Error('upstream exploded')))
      const verdict = await judge()
      expect(verdict).toMatchObject({ shouldBlock: true, unavailable: true })
      expect(verdict.errorDumpPath).toBeUndefined()
    } finally {
      // Leave the next test a directory to write into.
      rmSync(dirname(dumpPath), { force: true })
    }
  })

  for (const [route, modelName] of routes) {
    test(`${route}: aborting the request blocks as unavailable`, async () => {
      scene().useModel(modelName)
      const controller = new AbortController()
      model.queue(hangs())
      const pending = judge({ signal: controller.signal })
      await Bun.sleep(5)
      controller.abort()
      const verdict = await pending
      expect(verdict).toMatchObject({ shouldBlock: true, unavailable: true, reason: 'Classifier request aborted' })
      expect(verdict.timedOut).toBeFalsy()
    })

    test(`${route}: an already-aborted signal blocks as unavailable`, async () => {
      scene().useModel(modelName)
      const controller = new AbortController()
      controller.abort()
      model.queue(says('<block>no</block>'))
      const verdict = await judge({ signal: controller.signal })
      expect(verdict).toMatchObject({ shouldBlock: true, unavailable: true, reason: 'Classifier request aborted' })
    })
  }

  test('a transcript the classifier cannot read rejects instead of answering', async () => {
    const broken = { type: 'assistant', message: { role: 'assistant', content: 42 } } as unknown as Message
    await expect(judge({ messages: [broken] })).rejects.toThrow()
    expect(model.sent).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the time budget', () => {
  afterEach(() => {
    delete process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS
  })

  test('a model that never answers is cut off at the budget and the request aborted', async () => {
    process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS = '600'
    model.queue(hangs())
    const started = Date.now()
    const verdict = await judge()
    const elapsed = Date.now() - started

    expect(verdict).toEqual({
      shouldBlock: true,
      reason: 'Classifier timed out after 1s',
      model: TOOL_USE_MODEL,
      unavailable: true,
      timedOut: true,
      durationMs: 600,
    })
    expect(elapsed).toBeGreaterThanOrEqual(590)
    expect(elapsed).toBeLessThan(3000)
    expect(model.sent[0]!.signal.aborted).toBe(true)
  })

  test('an allow that arrives after the budget is ignored', async () => {
    process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS = '40'
    model.queue(answersLate(150, callsTool('classify_result', ALLOW_TOOL)))
    const verdict = await judge()
    expect(verdict).toMatchObject({ shouldBlock: true, timedOut: true, reason: 'Classifier timed out after 0s' })
  })

  test('the XML route is bounded the same way', async () => {
    scene().useModel(XML_MODEL)
    process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS = '40'
    model.queue(says('<block>yes'), hangs())
    const verdict = await judge()
    expect(verdict).toMatchObject({ shouldBlock: true, timedOut: true, unavailable: true, model: XML_MODEL })
  })

  const unbounded: Array<[string, string | undefined]> = [
    ['0 turns the budget off', '0'],
    ['an empty value keeps the default', ''],
    ['a non-number keeps the default', 'soon'],
    ['a negative number keeps the default', '-5'],
  ]
  for (const [label, value] of unbounded) {
    test(`${label}`, async () => {
      if (value !== undefined) process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS = value
      model.queue(answersLate(80, callsTool('classify_result', ALLOW_TOOL)))
      const verdict = await judge()
      expect(verdict.timedOut).toBeFalsy()
      expect(verdict.shouldBlock).toBe(false)
    })
  }

  test("the caller's abort still wins inside the budget", async () => {
    process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS = '5000'
    const controller = new AbortController()
    model.queue(hangs())
    const pending = judge({ signal: controller.signal })
    await Bun.sleep(5)
    controller.abort()
    const verdict = await pending
    expect(verdict).toMatchObject({ reason: 'Classifier request aborted', unavailable: true })
    expect(verdict.timedOut).toBeFalsy()
  })

  test('an already-aborted caller never waits for the budget', async () => {
    process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS = '5000'
    const controller = new AbortController()
    controller.abort()
    model.queue(hangs())
    const started = Date.now()
    const verdict = await judge({ signal: controller.signal })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(verdict.reason).toBe('Classifier request aborted')
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the Bash prompt-rule classifier', () => {
  const descriptions = ['list git remotes', 'run the unit tests']
  const classify = (behavior: 'allow' | 'deny' | 'ask', signal = new AbortController().signal) =>
    classifyBashCommand('npm test -- --watch=false', '/work/app', descriptions, behavior, signal, false)

  beforeEach(() => __setBashClassifierEnabledForTests(true))

  test('switched off it matches nothing and calls nothing', async () => {
    __setBashClassifierEnabledForTests(false)
    expect(await classify('allow')).toEqual({ matches: false, confidence: 'high', reason: 'classifier disabled' })
    expect(await generateGenericDescription('git remote -v', 'list remotes', new AbortController().signal)).toBe('list remotes')
    expect(await generateGenericDescription('git remote -v', '', new AbortController().signal)).toBeNull()
    expect(await generateGenericDescription('git remote -v', undefined, new AbortController().signal)).toBeNull()
    expect(model.sent).toHaveLength(0)
  })

  test('with no descriptions there is nothing to ask', async () => {
    const result = await classifyBashCommand('ls', '/w', [], 'allow', new AbortController().signal, false)
    expect(result).toEqual({ matches: false, confidence: 'high', reason: 'no descriptions to match against' })
    expect(model.sent).toHaveLength(0)
  })

  test('the request numbers the descriptions and forces classify_match', async () => {
    model.queue(callsTool('classify_match', { matchedIndex: null, confidence: 'high', reason: 'no' }))
    await classify('allow')
    const request = model.sent[0]!
    expect(request.model).toBe(TOOL_USE_MODEL)
    expect(request.max_tokens).toBe(512)
    expect(request.temperature).toBe(0)
    expect(request.thinking).toBe(false)
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'classify_match' })
    const schema = (request.tools![0] as unknown as { input_schema: { required: string[] } }).input_schema
    expect([...schema.required].sort()).toEqual(['confidence', 'matchedIndex', 'reason'])

    const prompt = lastUserText(request)
    expect(prompt).toContain('<cwd>/work/app</cwd>')
    expect(prompt).toContain('[0] list git remotes\n[1] run the unit tests')
    expect(prompt).toContain('<command>\nnpm test -- --watch=false\n</command>')
    expect(prompt).toContain('classify_match')
  })

  const instructions: Array<['allow' | 'deny' | 'ask', RegExp]> = [
    ['allow', /auto-approved/],
    ['deny', /deny rule/],
    ['ask', /ask rule/],
  ]
  for (const [behavior, fact] of instructions) {
    test(`the ${behavior} bucket gets its own instructions`, async () => {
      model.queue(callsTool('classify_match', { matchedIndex: null, confidence: 'low', reason: 'n' }))
      await classify(behavior)
      const system = systemText(model.sent[0]!)
      expect(system).toMatch(fact)
      expect(system).toMatch(/descriptions only/)
    })
  }

  const outcomes: Array<[string, ReturnType<typeof callsTool>, Record<string, unknown>]> = [
    [
      'a match',
      callsTool('classify_match', { matchedIndex: 1, confidence: 'high', reason: 'runs tests' }),
      { matches: true, matchedDescription: 'run the unit tests', confidence: 'high', reason: 'runs tests' },
    ],
    [
      'no match',
      callsTool('classify_match', { matchedIndex: null, confidence: 'medium', reason: 'different' }),
      { matches: false, confidence: 'medium', reason: 'different' },
    ],
    [
      'a negative index',
      callsTool('classify_match', { matchedIndex: -1, confidence: 'high', reason: 'x' }),
      { matches: false, confidence: 'high', reason: 'x' },
    ],
    [
      'an index past the list',
      callsTool('classify_match', { matchedIndex: 2, confidence: 'high', reason: 'x' }),
      { matches: false, confidence: 'high', reason: 'x' },
    ],
    [
      'a fractional index',
      callsTool('classify_match', { matchedIndex: 0.5, confidence: 'high', reason: 'x' }),
      { matches: false, confidence: 'low', reason: 'classifier returned malformed response' },
    ],
    [
      'an unknown confidence',
      callsTool('classify_match', { matchedIndex: 0, confidence: 'certain', reason: 'x' }),
      { matches: false, confidence: 'low', reason: 'classifier returned malformed response' },
    ],
    [
      'a text answer',
      says('[1]'),
      { matches: false, confidence: 'low', reason: 'classifier returned no tool_use block' },
    ],
    [
      'a failure',
      fails(new Error('boom')),
      { matches: false, confidence: 'low', reason: 'classifier error: boom' },
    ],
  ]
  for (const [label, reply, expected] of outcomes) {
    test(`${label} reads as ${JSON.stringify(expected.matches)}`, async () => {
      model.queue(reply)
      expect(await classify('deny')).toEqual(expected as never)
    })
  }

  test('an abort is thrown, not turned into a verdict', async () => {
    const controller = new AbortController()
    model.queue(hangs())
    const pending = classify('allow', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  test('a generic description is asked for with the command and the draft', async () => {
    model.queue(callsTool('propose_description', { description: '  list git remotes  ' }))
    const signal = new AbortController().signal
    expect(await generateGenericDescription('git remote -v', 'show remotes', signal)).toBe('list git remotes')

    const request = model.sent[0]!
    expect(request.max_tokens).toBe(256)
    expect(request.thinking).toBe(false)
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'propose_description' })
    const prompt = lastUserText(request)
    expect(prompt).toContain('<command>\ngit remote -v\n</command>')
    expect(prompt).toContain('<user_draft>show remotes</user_draft>')
    expect(systemText(request)).toMatch(/imperative/)
    expect(systemText(request)).toMatch(/draft/)
  })

  const fallbacks: Array<[string, ReturnType<typeof says>, string | undefined, string | null]> = [
    ['a blank proposal', callsTool('propose_description', { description: '   ' }), 'show remotes', 'show remotes'],
    ['an empty proposal', callsTool('propose_description', { description: '' }), 'show remotes', 'show remotes'],
    ['no tool call', says('list remotes'), 'show remotes', 'show remotes'],
    ['a failure', fails(new Error('down')), 'show remotes', 'show remotes'],
    ['a failure with no draft', fails(new Error('down')), undefined, null],
  ]
  for (const [label, reply, draft, expected] of fallbacks) {
    test(`a generic description falls back to the draft on ${label}`, async () => {
      model.queue(reply)
      expect(await generateGenericDescription('git remote -v', draft, new AbortController().signal)).toBe(expected)
    })
  }

  test('an abort while generalizing is thrown', async () => {
    const controller = new AbortController()
    model.queue(hangs())
    const pending = generateGenericDescription('ls', 'list', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
})
