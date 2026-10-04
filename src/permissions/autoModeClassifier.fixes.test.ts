/**
 * The fix decisions of the autoModeClassifier spec, and the corners of the
 * rewrite the characterization suites do not reach. Finding 1 (the import
 * cycle) has its own flagged run in `yoloClassifier/importOrder.test.ts`.
 *
 * As in the characterization suite, only the model is faked.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  assistantDoes,
  BASE_TEMPLATE,
  callsTool,
  createModelDouble,
  fails,
  hangs,
  lastUserBlocks,
  permissionContext,
  RULES_TEMPLATE,
  says,
  shellTool,
  silentTool,
  toolbox,
  toolUse,
  useClassifierScene,
  userSays,
} from 'src/permissions/__testutils__/autoModeClassifierScene.js'

const realSideQueryModule = { ...(await import('src/agent/sideQuery.js')) }
const model = createModelDouble()
mock.module('src/agent/sideQuery.js', () => ({ ...realSideQueryModule, sideQuery: model.sideQuery }))

const { __setClassifierPromptsForTests, classifyYoloAction, formatActionForClassifier } = await import(
  'src/permissions/yoloClassifier.js'
)
const transcriptModule = await import('src/permissions/yoloClassifier/transcript.js')
const { buildToolLookup, toCompactAction } = transcriptModule
const { buildClaudeMdMessage } = await import('src/permissions/yoloClassifier/prompts.js')
const { XML_S1_SUFFIX } = await import('src/permissions/yoloClassifier/xmlResponse.js')
const { setCachedClaudeMdContent } = await import('src/platform/bootstrap/state.js')

const scene = useClassifierScene()

afterAll(() => {
  __setClassifierPromptsForTests(null)
  mock.module('src/agent/sideQuery.js', () => realSideQueryModule)
})

beforeEach(() => {
  model.reset()
  __setClassifierPromptsForTests({ basePrompt: BASE_TEMPLATE, externalTemplate: RULES_TEMPLATE })
  scene().useModel('claude-sonnet-4-6')
  delete process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS
  setCachedClaudeMdContent(null)
})

const tools = toolbox(shellTool, silentTool)
const history = [userSays('tidy up'), assistantDoes([toolUse('Ghost', { path: '/etc' })])]

function judge(action: ReturnType<typeof formatActionForClassifier>, signal = new AbortController().signal) {
  return classifyYoloAction(history, action, tools, permissionContext(), signal)
}

describe('finding 3: an action is never allowed unjudged just because its tool is unknown', () => {
  const verdicts: Array<[string, Record<string, unknown>, boolean]> = [
    ['an allow', { thinking: 't', shouldBlock: false, reason: 'harmless' }, false],
    ['a block', { thinking: 't', shouldBlock: true, reason: 'wipes the disk' }, true],
  ]
  for (const [label, input, blocks] of verdicts) {
    test(`a tool missing from the list goes to the model on its raw input, and ${label} stands`, async () => {
      model.queue(callsTool('classify_result', input))
      const verdict = await judge(formatActionForClassifier('Unknown', { command: 'rm -rf /' }))
      expect(model.sent).toHaveLength(1)
      expect(verdict.shouldBlock).toBe(blocks)
      expect(lastUserBlocks(model.sent[0]!).at(-1)!.text).toBe('Unknown {"command":"rm -rf /"}\n')
    })
  }

  test('an unknown tool whose request fails blocks', async () => {
    model.queue(fails(new Error('socket hang up')))
    const verdict = await judge(formatActionForClassifier('Unknown', { command: 'rm -rf /' }))
    expect(verdict).toMatchObject({ shouldBlock: true, unavailable: true })
  })

  test('an unknown tool called with no input is judged on an empty object', () => {
    const lookup = buildToolLookup(tools)
    expect(toCompactAction(formatActionForClassifier('Unknown', undefined), lookup)).toBe('Unknown {}\n')
  })

  const stillSkipped: Array<[string, ReturnType<typeof formatActionForClassifier>]> = [
    ['a known tool that declares nothing to classify', formatActionForClassifier('Quiet', { x: 1 })],
    ['an assistant action made only of text', { role: 'assistant', content: [{ type: 'text', text: 'rm -rf /' }] }],
  ]
  for (const [label, action] of stillSkipped) {
    test(`${label} still renders to nothing`, () => {
      expect(toCompactAction(action, buildToolLookup(tools))).toBe('')
    })
  }

  test('an unknown tool in the history stays out of the transcript', async () => {
    model.queue(callsTool('classify_result', { thinking: 't', shouldBlock: false, reason: 'ok' }))
    await judge(formatActionForClassifier('Bash', { command: 'ls' }))
    expect(lastUserBlocks(model.sent[0]!).map(block => block.text)).toEqual(['User: tidy up\n', 'Bash ls\n'])
  })
})

describe('corners the characterization suites do not reach', () => {
  test('an already-aborted signal sends nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const verdict = await judge(formatActionForClassifier('Bash', { command: 'ls' }), controller.signal)
    expect(verdict).toMatchObject({ shouldBlock: true, unavailable: true, reason: 'Classifier request aborted' })
    expect(model.sent).toHaveLength(0)
  })

  test('finding 6 (kept): an oversized newest message keeps an older block that fits past a newer one that does not', () => {
    const { buildTranscriptForClassifier } = transcriptModule
    const newest = assistantDoes([toolUse('Bash', { command: 'ok' }), toolUse('Bash', { command: 'x'.repeat(40) })])
    // 'Bash ok\n' is 8 characters; the second line is 46.
    expect(buildTranscriptForClassifier([newest], tools, 20)).toBe('Bash ok\n')
  })
})

describe('the XML route past what the suites pin', () => {
  beforeEach(() => scene().useModel('claude-fable-5'))

  test('usage is the sum of both stages, as its own object', async () => {
    // toMatchObject in the characterization suite skips an object it has
    // already compared, so `usage` being `stage2Usage` itself slips past it.
    model.queue(says('<block>yes', { usage: { input: 50, output: 2 } }), says('<block>no', { usage: { input: 60, output: 30 } }))
    const verdict = await judge(formatActionForClassifier('Bash', { command: 'rm -rf build' }))
    expect(verdict.usage).toEqual({ inputTokens: 110, outputTokens: 32, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })

  test('a retried stage 2 that fails blocks on the stage 1 assessment', async () => {
    model.queue(says('<block>yes'), says('<thinking>long', { stop: 'max_tokens' }), fails(new Error('reset')))
    const verdict = await judge(formatActionForClassifier('Bash', { command: 'rm -rf build' }))
    expect(model.sent).toHaveLength(3)
    expect(verdict).toMatchObject({ shouldBlock: true, unavailable: false, stage: 'thinking' })
    expect(verdict.reason).toMatch(/stage 1/)
  })

  test('an abort during stage 2 is an abort, not a stage 2 failure', async () => {
    const controller = new AbortController()
    model.queue(says('<block>yes'), hangs())
    const pending = judge(formatActionForClassifier('Bash', { command: 'rm -rf build' }), controller.signal)
    await Bun.sleep(5)
    controller.abort()
    expect(await pending).toMatchObject({ shouldBlock: true, unavailable: true, reason: 'Classifier request aborted' })
  })
})

describe('text that scripts/bench/ab/wire-proxy.test.ts copies by hand', () => {
  test('the CLAUDE.md message opens with the sentence the proxy test expects', () => {
    setCachedClaudeMdContent('be careful')
    const message = buildClaudeMdMessage()
    const block = (message!.content as Array<{ text: string }>)[0]!
    expect(block.text.startsWith("The following is the user's CLAUDE.md configuration.")).toBe(true)
  })

  test('the stage 1 suffix is the one the proxy test expects', () => {
    expect(XML_S1_SUFFIX).toBe('\nErr on the side of blocking. <block> immediately.')
  })
})
