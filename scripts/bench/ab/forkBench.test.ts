import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callAfter, cost, ctx, fixture, loadSession, priceFor, spawnCall } from './forkBench.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.CLAUDIN_CONFIG_DIR
})

function assistant(id: string, ts: string, usage: Record<string, unknown>, tools: string[] = []): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { id, usage, content: tools.map((name, i) => ({ type: 'tool_use', id: `${id}-t${i}`, name })) },
  })
}

/** Writes a parent transcript plus one child that mirrors the parent's ids. */
function writeSession(): { cwd: string; sessionId: string } {
  const cfg = mkdtempSync(join(tmpdir(), 'forkbench-cfg-'))
  dirs.push(cfg)
  process.env.CLAUDIN_CONFIG_DIR = cfg
  const cwd = '/tmp/scratch-x'
  const sessionId = 'sess1'
  const proj = join(cfg, 'projects', cwd.replace(/\//g, '-'))
  mkdirSync(join(proj, sessionId, 'subagents'), { recursive: true })
  const p1 = assistant('p1', '2026-09-09T10:00:00Z', { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000, output_tokens: 10 }, ['Read'])
  const p2 = assistant('p2', '2026-09-09T10:00:10Z', { input_tokens: 50, cache_read_input_tokens: 20000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3000 }, output_tokens: 30 }, ['Agent'])
  const p3 = assistant('p3', '2026-09-09T10:01:00Z', { input_tokens: 40, cache_read_input_tokens: 23000, cache_creation_input_tokens: 500, output_tokens: 20 })
  // The stream repeats a message once per content block: the second copy of
  // c1 carries the final usage (higher output_tokens) and must win.
  const c1a = assistant('c1', '2026-09-09T10:00:20Z', { input_tokens: 10, cache_read_input_tokens: 23000, cache_creation_input_tokens: 700, output_tokens: 1 }, ['Bash'])
  const c1b = assistant('c1', '2026-09-09T10:00:20Z', { input_tokens: 10, cache_read_input_tokens: 23000, cache_creation_input_tokens: 700, output_tokens: 25 })
  const c2 = assistant('c2', '2026-09-09T10:00:40Z', { input_tokens: 5, cache_read_input_tokens: 23700, cache_creation_input_tokens: 100, output_tokens: 15 })
  writeFileSync(join(proj, `${sessionId}.jsonl`), [p1, p2, p3].join('\n') + '\n')
  writeFileSync(join(proj, sessionId, 'subagents', 'agent-abc.jsonl'), [p1, p2, c1a, c1b, c2].join('\n') + '\n')
  writeFileSync(join(proj, sessionId, 'subagents', 'agent-abc.meta.json'), JSON.stringify({ agentType: 'fork', description: 'x' }))
  return { cwd, sessionId }
}

describe('loadSession', () => {
  test('drops the parent ids a fork child mirrors and keeps the final usage copy', () => {
    const { cwd, sessionId } = writeSession()
    const s = loadSession(cwd, sessionId)
    expect(s.parent.map(c => c.id)).toEqual(['p1', 'p2', 'p3'])
    expect(s.children).toHaveLength(1)
    expect(s.children[0]!.agentType).toBe('fork')
    expect(s.children[0]!.calls.map(c => c.id)).toEqual(['c1', 'c2'])
    expect(s.children[0]!.calls[0]!.out).toBe(25)
    expect(s.children[0]!.calls[0]!.tools).toEqual(['Bash'])
  })

  test('splits cache writes by tier when the API reports it, else charges 1h', () => {
    const { cwd, sessionId } = writeSession()
    const s = loadSession(cwd, sessionId)
    expect(s.parent[1]).toMatchObject({ write5m: 0, write1h: 3000 })
    expect(s.parent[0]).toMatchObject({ write5m: 0, write1h: 20000 })
    expect(ctx(s.parent[1]!)).toBe(50 + 20000 + 3000)
  })

  test('spawnCall is the parent call holding an Agent tool_use; callAfter is the next by time', () => {
    const { cwd, sessionId } = writeSession()
    const s = loadSession(cwd, sessionId)
    expect(spawnCall(s.parent)?.id).toBe('p2')
    const lastChild = s.children[0]!.calls[1]!
    expect(callAfter(s.parent, lastChild.ts)?.id).toBe('p3')
  })
})

describe('cost', () => {
  test('prices each bucket at the tier and sums them', () => {
    const { price } = priceFor('claude-sonnet-5')
    const c = cost([{ id: 'x', ts: 0, in: 1e6, read: 1e6, write5m: 1e6, write1h: 1e6, out: 1e6, tools: [] }], price)
    expect(c).toEqual({ input: 2, write: 2.5 + 4, read: 0.2, output: 10, total: 2 + 6.5 + 0.2 + 10 })
  })

  test('priceFor falls back to Sonnet 5 and says so', () => {
    expect(priceFor(undefined).label).toContain('default')
    expect(priceFor('claude-fable-5-1').price.read).toBe(0.25)
  })
})

describe('fixture', () => {
  test('is deterministic per seed and reports the wc -l line count', () => {
    const a = fixture(7), b = fixture(7)
    expect(a.text).toBe(b.text)
    expect(a.lines).toBe(a.text.split('\n').length - 1)
    expect(fixture(7, 'deadbeef').text).toContain('SECRET_TOKEN=deadbeef')
  })
})
