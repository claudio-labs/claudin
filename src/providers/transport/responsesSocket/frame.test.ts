import { describe, expect, test } from 'bun:test'
import { nextChain, planResponseFrame, type ResponsesChain } from 'src/providers/transport/responsesSocket/frame.js'

const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] }
const assistant = { type: 'message', role: 'assistant', id: 'msg_1', phase: 'commentary', content: [{ type: 'output_text', text: 'reading' }] }
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a"}' }
const callOutput = { type: 'function_call_output', call_id: 'call_1', output: 'file body' }

const settings = { model: 'gpt-5.6-terra', stream: true, store: false, instructions: 'be brief', tools: [{ type: 'function', name: 'Read' }] }
const firstBody = { ...settings, input: [user('read a')] }
const secondBody = { ...settings, input: [user('read a'), reasoning, assistant, call, callOutput] }
const completed = { id: 'resp_1', output: [reasoning, assistant, call] }

function chainAfterFirst(): ResponsesChain {
  const chain = nextChain(planResponseFrame(undefined, firstBody), completed)
  if (!chain) throw new Error('expected a chain')
  return chain
}

describe('planResponseFrame', () => {
  test('the first request of a socket goes out whole', () => {
    const plan = planResponseFrame(undefined, firstBody)
    expect(plan).toMatchObject({ incremental: false, reason: 'no-chain' })
    expect(plan.frame).toEqual({ type: 'response.create', ...firstBody })
  })

  test('a request that extends input + output sends only the new items, naming the response', () => {
    const plan = planResponseFrame(chainAfterFirst(), secondBody)
    expect(plan.reason).toBe('incremental')
    expect(plan.frame).toEqual({ type: 'response.create', ...settings, previous_response_id: 'resp_1', input: [callOutput] })
  })

  test('stream stays in the frame, as Codex CLI sends it', () => {
    expect(planResponseFrame(chainAfterFirst(), secondBody).frame.stream).toBe(true)
  })

  test.each([
    ['tools', { tools: [{ type: 'function', name: 'Read' }, { type: 'function', name: 'Edit' }] }],
    ['instructions', { instructions: 'be thorough' }],
    ['model', { model: 'gpt-6-luna' }],
    ['reasoning effort', { reasoning: { effort: 'high' } }],
    ['prompt cache key', { prompt_cache_key: 'other-session' }],
  ])('a changed %s sends the whole input', (_name, change) => {
    const plan = planResponseFrame(chainAfterFirst(), { ...secondBody, ...change })
    expect(plan).toMatchObject({ incremental: false, reason: 'settings-changed' })
    expect(plan.frame.previous_response_id).toBeUndefined()
    expect(plan.frame.input).toEqual(secondBody.input)
  })

  test('a rewritten earlier item (a stub, a clip) sends the whole input', () => {
    const stubbed = { ...secondBody, input: [user('[stubbed]'), reasoning, assistant, call, callOutput] }
    expect(planResponseFrame(chainAfterFirst(), stubbed).reason).toBe('input-rewritten')
  })

  test('a shorter input (compaction) sends the whole input', () => {
    const compacted = { ...settings, input: [user('summary')] }
    expect(planResponseFrame(chainAfterFirst(), compacted).reason).toBe('input-rewritten')
  })

  test('output replayed under other ids, or with an item missing, sends the whole input', () => {
    const synthetic = { ...secondBody, input: [user('read a'), { ...assistant, id: undefined }, { ...call, id: 'fc_synthetic' }, callOutput] }
    expect(planResponseFrame(chainAfterFirst(), synthetic).reason).toBe('output-mismatch')
    const dropped = { ...secondBody, input: [user('read a'), assistant, call, callOutput] }
    expect(planResponseFrame(chainAfterFirst(), dropped).reason).toBe('output-mismatch')
  })

  test('a request with nothing after the replayed output goes out whole', () => {
    const same = { ...secondBody, input: [user('read a'), reasoning, assistant, call] }
    expect(planResponseFrame(chainAfterFirst(), same).reason).toBe('nothing-new')
  })

  test('a body without an input array is planned as an empty input', () => {
    const plan = planResponseFrame(undefined, { ...settings })
    expect(plan.inputKeys).toEqual([])
    expect(plan.reason).toBe('no-chain')
  })

  test('the chain holds the full rendered input, not the delta', () => {
    const plan = planResponseFrame(chainAfterFirst(), secondBody)
    const chain = nextChain(plan, { id: 'resp_2', output: [{ type: 'message', id: 'msg_2' }] })
    expect(chain?.inputKeys).toHaveLength(secondBody.input.length)
    const third = { ...secondBody, input: [...secondBody.input, { type: 'message', id: 'msg_2' }, user('next')] }
    const thirdPlan = planResponseFrame(chain, third)
    expect(thirdPlan.reason).toBe('incremental')
    expect(thirdPlan.frame.input).toEqual([user('next')])
    expect(thirdPlan.frame.previous_response_id).toBe('resp_2')
  })
})

describe('nextChain', () => {
  const plan = planResponseFrame(undefined, firstBody)

  test('keeps the response id and its output ids in order', () => {
    expect(nextChain(plan, completed)).toEqual({
      settingsKey: plan.settingsKey,
      inputKeys: plan.inputKeys,
      responseId: 'resp_1',
      outputIds: ['rs_1', 'msg_1', 'fc_1'],
    })
  })

  test('no chain without a response id, or with an output item that has no id', () => {
    expect(nextChain(plan, undefined)).toBeUndefined()
    expect(nextChain(plan, { output: [] })).toBeUndefined()
    expect(nextChain(plan, { id: 'resp_1', output: [{ type: 'message' }] })).toBeUndefined()
  })

  test('an empty output is a chain with no output ids', () => {
    expect(nextChain(plan, { id: 'resp_1' })?.outputIds).toEqual([])
  })
})
