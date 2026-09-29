import { expect, test } from 'bun:test'
import { buildFixture, parseCatalogEntry, requestFacts, stripOldestThinking, withThinking } from './model-launch-capture.ts'
import type { ProxyRecord } from './wire-proxy.ts'

type Json = Record<string, unknown>

// Two neighbouring entries shaped like Claude Code 2.1.284's baked catalog.
const BUNDLE =
  'x={models:[{id:"claude-sonnet-5",family:"sonnet",display_name:"Sonnet 5",knowledge_cutoff:"January 2026",' +
  'fallback_3p:"claude-sonnet-4-6",pricing:"tier_2_10",default_effort:"high"},' +
  '{id:"claude-sonnet-5-5",family:"sonnet",display_name:"Sonnet 5.5",knowledge_cutoff:"June 2026",' +
  'fallback_3p:"claude-sonnet-5",pricing:"tier_2_10"},{id:"claude-opus-4-0",family:"opus",default_effort:"low"}]}'

test('reads a catalog entry by exact id, not by prefix', () => {
  expect(parseCatalogEntry(BUNDLE, 'claude-sonnet-5')).toEqual({
    display_name: 'Sonnet 5',
    knowledge_cutoff: 'January 2026',
    default_effort: 'high',
    fallback_3p: 'claude-sonnet-4-6',
    pricing: 'tier_2_10',
  })
})

test('a field the entry lacks is null, never read from the next entry', () => {
  // claude-sonnet-5-5 has no default_effort here; the entry after it does.
  expect(parseCatalogEntry(BUNDLE, 'claude-sonnet-5-5')?.default_effort).toBeNull()
  expect(parseCatalogEntry(BUNDLE, 'claude-sonnet-5-5')?.display_name).toBe('Sonnet 5.5')
  expect(parseCatalogEntry(BUNDLE, 'claude-fable-9')).toBeNull()
})

const thinking = (s: string): Json => ({ type: 'thinking', thinking: '', signature: s })
const text = (t: string): Json => ({ type: 'text', text: t })
const body: Json = {
  model: 'claude-sonnet-5-5',
  thinking: { type: 'adaptive', display: 'updates' },
  messages: [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: [text('no thinking here')] },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: [thinking('sig-a'), text('a')] },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: [thinking('sig-b'), text('b')] },
    { role: 'user', content: 'q4' },
  ],
}

test('strips thinking from the oldest assistant turn that has any, and only that one', () => {
  const { body: out, strippedMessage } = stripOldestThinking(body)
  expect(strippedMessage).toBe(3)
  const messages = out.messages as Json[]
  expect(messages[3]!.content).toEqual([text('a')])
  expect(messages[5]!.content).toEqual([thinking('sig-b'), text('b')])
  // The captured body is replayed several ways, so it must survive untouched.
  expect(((body.messages as Json[])[3]!.content as Json[]).length).toBe(2)
})

test('withThinking merges into the existing thinking config', () => {
  expect(withThinking(body, { display: 'summarized' }).thinking).toEqual({ type: 'adaptive', display: 'summarized' })
})

const record = (n: number, betas: string): ProxyRecord => ({
  t: '',
  label: 'claude.claude-sonnet-5-5',
  n,
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  ms: 1,
  headers: { 'anthropic-beta': betas },
  reqFile: `req-${n}.json.gz`,
  response: { id: null, model: null, stopReason: null, usage: null, thinkingTokens: 5, blocks: ['thinking', 'text'], thinkingChars: 0 },
})

test('the fixture takes the LAST main request, with its replayed history counted', () => {
  const first = requestFacts(record(1, 'a'), { ...body, max_tokens: 1, messages: [] })
  const last = requestFacts(record(2, 'a, thinking-binding-controls-2026-08-01'), { ...body, max_tokens: 128000, context_management: { edits: [] } })
  const fixture = buildFixture({
    version: '2.1.284',
    capturedAt: '2026-09-29',
    model: 'claude-sonnet-5-5',
    catalog: null,
    mains: [first, last],
    strippedMessage: 3,
    replays: { control: { status: 200 }, strip: { status: null, error: 'x' } },
  })
  expect(fixture.request).toEqual({
    max_tokens: 128000,
    thinking: { type: 'adaptive', display: 'updates' },
    context_management: { edits: [] },
    betas: ['a', 'thinking-binding-controls-2026-08-01'],
  })
  expect(fixture.thinkingReplay).toEqual({
    replayedThinking: 2,
    replayedWithSignature: 2,
    strippedMessage: 3,
    replays: { control: 200, strip: null },
  })
})

test('no main request is an error, not an empty fixture', () => {
  expect(() =>
    buildFixture({ version: 'v', capturedAt: 'd', model: 'm', catalog: null, mains: [], strippedMessage: -1, replays: {} }),
  ).toThrow('no main-thread request')
})
