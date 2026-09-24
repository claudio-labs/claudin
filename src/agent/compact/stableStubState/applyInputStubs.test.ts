import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  _resetAllClippedIdsForTesting,
  addClippedIds,
  addClippedInputs,
  applyStableInputStubs,
  applyStableStubs,
  resetClippedIds,
} from 'src/agent/compact/stableStubState.js'
import { MIN_STUB_TOKENS } from 'src/agent/compact/stableStubState/clipStubText.js'

type Block = Record<string, unknown>
type Msg = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

beforeEach(() => {
  _resetAllClippedIdsForTesting()
})

afterEach(() => {
  _resetAllClippedIdsForTesting()
})

// Well above MIN_STUB_TOKENS (100 tokens ≈ 400 chars) so the field qualifies.
const BIG = 'x'.repeat(4_000)

function assistantToolUse(id: string, name: string, input: Block): Msg {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
}

function userToolResult(id: string, content: string): Msg {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }
}

function inputOf(msg: Msg): Block {
  return ((msg.content as Block[])[0] as { input: Block }).input
}

test('identity when no input has been clipped', () => {
  const messages = [assistantToolUse('toolu_a', 'Patch', { patchText: BIG })]
  expect(applyStableInputStubs(messages)).toBe(messages)
})

test('rewrites only the declared fields, keeps the rest, and the result block stays intact', () => {
  const messages = [
    assistantToolUse('toolu_a', 'Patch', { patchText: BIG, dryRun: false }),
    userToolResult('toolu_a', 'Success. Applied the patch to the following files: M a.ts'),
  ]
  addClippedInputs('toolu_a', ['patchText'])
  const out = applyStableInputStubs(messages)
  expect(out).not.toBe(messages)
  const input = inputOf(out[0]!)
  // The token count rides the active model's bytes/token ratio, so only the
  // shape is pinned here; byte-stability is the next test's job.
  expect(input.patchText).toMatch(/^\[clipped: ~\d+ tokens of patchText from Patch\]$/)
  expect(input.dryRun).toBe(false)
  // Input-only clip: the result side is untouched by both rewriters.
  expect(out[1]).toBe(messages[1])
  expect(applyStableStubs(out)[1]).toBe(messages[1])
})

test('a field under MIN_STUB_TOKENS is left alone — the stub would not be shorter', () => {
  const short = 'y'.repeat(MIN_STUB_TOKENS) // ~25 tokens
  const messages = [assistantToolUse('toolu_a', 'Write', { content: short, file_path: '/f' })]
  addClippedInputs('toolu_a', ['content'])
  expect(applyStableInputStubs(messages)).toBe(messages)
})

test('non-string and absent fields are skipped', () => {
  const messages = [
    assistantToolUse('toolu_a', 'Edit', { old_string: 12345, file_path: '/f' }),
  ]
  addClippedInputs('toolu_a', ['old_string', 'new_string'])
  expect(applyStableInputStubs(messages)).toBe(messages)
})

test('bytes are identical across renders, across array instances, and after re-clipping', () => {
  const build = () => [
    assistantToolUse('toolu_a', 'Patch', { patchText: BIG }),
    assistantToolUse('toolu_b', 'Agent', { prompt: BIG + 'brief', description: 'd' }),
  ]
  addClippedInputs('toolu_a', ['patchText'])
  addClippedInputs('toolu_b', ['prompt'])
  const first = applyStableInputStubs(build())
  const second = applyStableInputStubs(build())
  // A later addClippedInputs for the same id must not change the recorded fields.
  addClippedInputs('toolu_a', ['patchText', 'dryRun'])
  const third = applyStableInputStubs(build())
  expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  expect(JSON.stringify(third)).toBe(JSON.stringify(first))
})

test('an already-stubbed field is final: re-rendering the stubbed view is identity', () => {
  const messages = [assistantToolUse('toolu_a', 'Patch', { patchText: BIG })]
  addClippedInputs('toolu_a', ['patchText'])
  const once = applyStableInputStubs(messages)
  expect(applyStableInputStubs(once)).toBe(once)
})

test('the first emission is replayed even when the estimate would differ later (model switch drift)', () => {
  // The stub embeds a token count taken from the active model's bytes/token
  // ratio. A `/model` switch mid-session changes that ratio, so recomputing
  // from the same content would flip the bytes behind the cache marker.
  // The registry replays the first emission instead — the same contract as
  // result stubs. Simulated by changing the content length between renders:
  // the recorded bytes win over what the second render would compute.
  addClippedInputs('toolu_a', ['patchText'])
  const first = inputOf(
    applyStableInputStubs([assistantToolUse('toolu_a', 'Patch', { patchText: BIG })])[0]!,
  ).patchText
  const second = inputOf(
    applyStableInputStubs([
      assistantToolUse('toolu_a', 'Patch', { patchText: BIG + BIG }),
    ])[0]!,
  ).patchText
  expect(second).toBe(first)
})

test('the result-side stub pattern does not accept the input form', () => {
  // A tool_result whose content happens to be an input stub must still be
  // clippable as a result (isClipStubContent must not match it).
  const stub = '[clipped: ~1000 tokens of patchText from Patch]'
  const messages = [
    assistantToolUse('toolu_a', 'Read', {}),
    userToolResult('toolu_a', stub + '\n' + 'z'.repeat(1_000)),
  ]
  addClippedIds(['toolu_a'])
  const out = applyStableStubs(messages)
  const content = ((out[1]!.content as Block[])[0] as { content: string }).content
  expect(content).toMatch(/^\[clipped: ~\d+ tokens from Read\]$/)
})

test('handles the nested message.content shape the wire uses', () => {
  const messages: Msg[] = [
    {
      role: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Write', input: { content: BIG, file_path: '/f' } }],
      },
    },
  ]
  addClippedInputs('toolu_a', ['content'])
  const out = applyStableInputStubs(messages)
  const input = ((out[0]!.message!.content as Block[])[0] as { input: Block }).input
  expect(input.content).toMatch(/^\[clipped: ~\d+ tokens of content from Write\]$/)
  expect(input.file_path).toBe('/f')
})

test('resetClippedIds drops the clipped inputs with the rest of the key', () => {
  const messages = [assistantToolUse('toolu_a', 'Patch', { patchText: BIG })]
  addClippedInputs('toolu_a', ['patchText'])
  expect(applyStableInputStubs(messages)).not.toBe(messages)
  resetClippedIds()
  expect(applyStableInputStubs(messages)).toBe(messages)
})
