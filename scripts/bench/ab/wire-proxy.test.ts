import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { bashCommandOf, type ProxyRecord, readKindedRequests, requestKind } from './wire-proxy.ts'

// Synthetic bodies shaped like what each request builder puts on the wire; the
// markers requestKind reads are cited beside it in wire-proxy.ts.

type Json = Record<string, unknown>

const text = (t: string): Json => ({ type: 'text', text: t })
const schema = (name: string): Json => ({ name, description: name, input_schema: { type: 'object' } })
const ATTRIBUTION = text('x-anthropic-billing-header: cc_version=1.0; cc_entrypoint=sdk-cli;')
const CACHED = { cache_control: { type: 'ephemeral', ttl: '1h' } }

/** An agent-loop request: its own system prompt, its whole tool pool (deferred tools too), streamed. */
function loopBody(messages: Json[], system = 'You are Claudin, an open-source coding agent and CLI.'): Json {
  return {
    model: 'claude-opus-5-5',
    system: [ATTRIBUTION, { ...text(system), ...CACHED }],
    messages,
    tools: [...['Bash', 'Read', 'Edit', 'Patch', 'Grep', 'Glob'].map(schema), { ...schema('RunTests'), defer_loading: true }],
    metadata: { user_id: '{"session_id":"s"}' },
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    stream: true,
  }
}

const PROMPT = { role: 'user', content: [text('Add bulk tiers and fix the free-shipping bug.')] }
const TOOL_TURN = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '12 pass' }] },
]
const END_TURN = { role: 'assistant', content: [text('Done: tiers added, shipping fixed.')] }
const FORK_TOOL_TURN = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'Read', input: { file_path: '/m/MEMORY.md' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f1', content: '- [x](x.md)' }] },
]

const ACTION = 'Bash {"command":"rm -rf dist && bun run build"}\n'

/** One stage of the XML classifier: the transcript and the action inside <transcript>, the stage's instruction after. */
function classifierBody(stage: 1 | 2, action = ACTION, transcript: string[] = ['User: Add bulk tiers\n']): Json {
  return {
    model: 'claude-opus-5-5',
    max_tokens: stage === 1 ? 64 + 2048 : 4096 + 2048,
    system: [ATTRIBUTION, { ...text('You are a security classifier for an autonomous coding agent. The agent runs locally.'), ...CACHED }],
    messages: [
      { role: 'user', content: [{ ...text("The following is the user's CLAUDE.md configuration."), ...CACHED }] },
      {
        role: 'user',
        content: [
          text('<transcript>\n'),
          ...transcript.map(text),
          { ...text(action), ...CACHED },
          text('</transcript>\n'),
          text(
            stage === 1
              ? '\nErr on the side of blocking. <block> immediately.'
              : '\nReview the classification process and follow it carefully. Use <thinking> before responding with <block>.',
          ),
        ],
      },
    ],
    ...(stage === 1 ? { stop_sequences: ['</block>'] } : {}),
    metadata: { user_id: '{"session_id":"s"}' },
  }
}

describe('requestKind — the agent loop', () => {
  test('the first request, and one that carries tool results back', () => {
    expect(requestKind(loopBody([PROMPT]))).toBe('main')
    expect(requestKind(loopBody([PROMPT, ...TOOL_TURN]))).toBe('main')
  })

  test('a sub-agent is a loop of its own, and so is the non-streaming fallback', () => {
    expect(requestKind(loopBody([PROMPT], 'You are an agent for Claudin. Given the user message, use the tools.'))).toBe('main')
    const { stream: _, ...fallback } = loopBody([PROMPT, ...TOOL_TURN])
    expect(requestKind(fallback)).toBe('main')
  })

  test('a prompt that only mentions a fork prompt or the classifier stays in the loop', () => {
    const asked = { role: 'user', content: [text('Why does it say "You are now acting as the memory extraction subagent"?')] }
    expect(requestKind(loopBody([asked]))).toBe('main')
    const memory = 'Memory: the classifier prompt opens with "You are a security classifier for an autonomous coding agent".'
    expect(requestKind(loopBody([PROMPT], `You are Claudin.\n${memory}`))).toBe('main')
  })
})

describe('requestKind — the auto-mode classifier', () => {
  test('both stages of the XML path', () => {
    expect(requestKind(classifierBody(1))).toBe('classifier')
    expect(requestKind(classifierBody(2))).toBe('classifier')
  })

  test('the tool_use path, by the tool it forces', () => {
    const body: Json = {
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: [text('A reworded classifier prompt.')],
      messages: [{ role: 'user', content: [text('User: hi\n'), text(ACTION)] }],
      tools: [schema('classify_result')],
      tool_choice: { type: 'tool', name: 'classify_result' },
    }
    expect(requestKind(body)).toBe('classifier')
  })

  test('each mark alone is enough', () => {
    const bare: Json = { model: 'claude-opus-5-5', max_tokens: 2112, system: [text('Some other prompt.')], messages: [PROMPT] }
    expect(requestKind(bare)).toBe('other')
    expect(requestKind({ ...bare, stop_sequences: ['</block>'] })).toBe('classifier')
    const wrapped = { role: 'user', content: [text('<transcript>\n'), text(ACTION), text('</transcript>\n'), text('\nDecide.')] }
    expect(requestKind({ ...bare, messages: [wrapped] })).toBe('classifier')
    const named = [ATTRIBUTION, text('You are a security classifier for an autonomous coding agent. Reworded after this.')]
    expect(requestKind({ ...bare, system: named })).toBe('classifier')
  })
})

describe('requestKind — side requests', () => {
  test('a small-model query sends no tool, a side query forces its one tool', () => {
    const title: Json = {
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: [ATTRIBUTION, text('Generate a concise title for this session.')],
      messages: [PROMPT],
      tools: [],
      thinking: { type: 'disabled' },
    }
    expect(requestKind(title)).toBe('other')
    const explainer = { ...title, tools: [schema('explain_command'), schema('unused')], tool_choice: { type: 'tool', name: 'explain_command' } }
    expect(requestKind(explainer)).toBe('other')
  })

  test('a fork: the main thread prefix plus its prompt, on its first request and on a later one', () => {
    const extract = { role: 'user', content: [text('You are now acting as the memory extraction subagent. Analyze the most recent ~12 messages above.')] }
    expect(requestKind(loopBody([PROMPT, ...TOOL_TURN, END_TURN, extract]))).toBe('other')
    expect(requestKind(loopBody([PROMPT, ...TOOL_TURN, END_TURN, extract, ...FORK_TOOL_TURN]))).toBe('other')
    const compact = { role: 'user', content: [text('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nYour task is to create a detailed summary.')] }
    expect(requestKind(loopBody([PROMPT, ...TOOL_TURN, END_TURN, compact]))).toBe('other')
    // A background agent's progress summary lands on a tool result, in the same user message.
    const progress = [...TOOL_TURN.slice(0, 1), { role: 'user', content: [...TOOL_TURN[1]!.content, text('Describe your most recent action in 3-5 words using present tense (-ing).')] }]
    expect(requestKind(loopBody([PROMPT, ...progress]))).toBe('other')
  })

  test('a keep-alive ping and a token count look like the loop but generate nothing', () => {
    expect(requestKind({ ...loopBody([PROMPT, ...TOOL_TURN]), max_tokens: 1, stream: false })).toBe('other')
    const { max_tokens: _, stream: __, ...counted } = loopBody([PROMPT, ...TOOL_TURN])
    expect(requestKind(counted)).toBe('other')
  })
})

describe('readKindedRequests — the answered requests of one label, in the order sent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wire-proxy-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('count_tokens and failed requests are left out; the stages of one judgment share it', () => {
    const label = 'auto-r1.p1'
    mkdirSync(join(dir, label), { recursive: true })
    const log = (n: number, path: string, status: number, body: Json, model: string | null): void => {
      const reqFile = `req-${String(n).padStart(3, '0')}.json.gz`
      writeFileSync(join(dir, label, reqFile), gzipSync(Buffer.from(JSON.stringify(body))))
      const line: ProxyRecord = {
        t: '2026-09-24T00:00:00.000Z',
        label,
        n,
        method: 'POST',
        path,
        status,
        ms: 10,
        headers: {},
        reqFile,
        response:
          status < 400
            ? { id: `msg_${n}`, model, stopReason: 'end_turn', usage: { input_tokens: n }, thinkingTokens: null, blocks: ['text'], thinkingChars: 0 }
            : null,
      }
      appendFileSync(join(dir, label, 'log.jsonl'), `${JSON.stringify(line)}\n`)
    }
    const messages = '/v1/messages?beta=true'
    // Lines land in completion order — a quick title call before the streamed
    // turn sent ahead of it — while `n` is the order the requests were sent.
    const title: Json = { model: 'claude-haiku-4-5', max_tokens: 1024, system: [text('Title this session.')], messages: [PROMPT], tools: [] }
    log(2, messages, 200, title, 'claude-haiku-4-5')
    log(1, messages, 200, loopBody([PROMPT]), 'claude-opus-5-5')
    log(3, messages, 200, classifierBody(1), 'claude-opus-5-5')
    log(8, '/v1/messages/count_tokens?beta=true', 200, loopBody([PROMPT]), null)
    log(4, messages, 200, classifierBody(2), null)
    log(6, messages, 200, loopBody([PROMPT, ...TOOL_TURN]), 'claude-opus-5-5')
    log(5, messages, 529, loopBody([PROMPT, ...TOOL_TURN]), null)
    log(7, messages, 200, classifierBody(1, ACTION, ['User: Add bulk tiers\n', `${ACTION}`, 'User: again\n']), 'claude-opus-5-5')

    const requests = readKindedRequests(dir, label)
    expect(requests.map(r => [r.n, r.kind])).toEqual([
      [1, 'main'],
      [2, 'other'],
      [3, 'classifier'],
      [4, 'classifier'],
      [6, 'main'],
      [7, 'classifier'],
    ])
    const [first, , s1, s2, second, later] = requests
    expect(first!.action).toBeUndefined()
    expect(second!.usage).toEqual({ input_tokens: 6 })
    expect(s2!.model).toBe('claude-opus-5-5') // the body's, when the response carried none
    expect([s1!.action, s2!.action, later!.action]).toEqual([ACTION, ACTION, ACTION])
    expect(s1!.judgment).toBe(s2!.judgment!)
    expect(later!.judgment).not.toBe(s1!.judgment!)
    expect(readKindedRequests(dir, 'no-such-label')).toEqual([])
  })
})

describe('bashCommandOf — the command of a judged Bash action', () => {
  test('from the default block, a multi-line command whole, and from the JSONL one', () => {
    expect(bashCommandOf('Bash git ls-files && cat src/*.ts\n')).toBe('git ls-files && cat src/*.ts')
    expect(bashCommandOf('Bash cat src/a.ts\ncat src/b.ts\n')).toBe('cat src/a.ts\ncat src/b.ts')
    expect(bashCommandOf('{"Bash":"cat \\"src/*.ts\\""}\n')).toBe('cat "src/*.ts"')
  })

  test("another tool's action has none, on either path", () => {
    expect(bashCommandOf('Read {"file_path":"/w/src/a.ts"}\n')).toBeNull()
    expect(bashCommandOf('{"Read":{"file_path":"/w/src/a.ts"}}\n')).toBeNull()
    expect(bashCommandOf('Bashful {"x":1}\n')).toBeNull()
    expect(bashCommandOf('{"Bash":\n')).toBeNull()
  })
})
