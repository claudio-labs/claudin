import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deferredToolNames, extract, runExtraction, type Seen } from './extract-claude-code-prompt.ts'

const DEFERRED_MESSAGE =
  '# Environment\n - Platform: linux\n\nThe following deferred tools are now available via ToolSearch. ' +
  'Their schemas are NOT loaded — use ToolSearch to load them:\nWebFetch\nCronList\n\nTrailing\n\nAvailable agent types:\n- Explore'

const tool = (name: string) => ({ name, description: `${name} does a thing`, input_schema: { type: 'object' } })

function seen(billing: string): Seen {
  return {
    path: '/v1/messages',
    headers: { 'anthropic-beta': 'fake-beta' },
    body: {
      model: 'fake-1',
      max_tokens: 100,
      system: [
        { type: 'text', text: `x-anthropic-billing-header: ${billing}` },
        { type: 'text', text: 'You are Fake Code.' },
      ],
      tools: [tool('Read'), tool('ToolSearch')],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: DEFERRED_MESSAGE },
      ],
      metadata: { user_id: 'device-and-account' },
    },
  }
}

describe('deferredToolNames', () => {
  test('reads the names listed under the ToolSearch header, stopping at the blank line', () => {
    expect(deferredToolNames(seen('a').body ?? {})).toEqual(['WebFetch', 'CronList'])
  })

  test('is empty when no message carries the header', () => {
    expect(deferredToolNames({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([])
  })
})

describe('extract', () => {
  const info = { version: '9.9.9', bin: 'claude', mode: 'print' as const }

  test('the system hash ignores the per-request billing header', () => {
    const a = extract(seen('cch=aaaaa'), seen('cch=aaaaa'), [], info)
    const b = extract(seen('cch=bbbbb'), seen('cch=bbbbb'), [], info)
    expect(a.meta.systemSha256).toBe(b.meta.systemSha256)
    expect(a.system).not.toBe(b.system)
  })

  test('takes tools from the last request and lists the deferred ones it still lacks', () => {
    const first = seen('x')
    const last = seen('x')
    ;(last.body as { tools: unknown[] }).tools.push(tool('WebFetch'))
    const e = extract(first, last, [first, last], info)
    expect(e.tools.map(t => t.name)).toEqual(['Read', 'ToolSearch', 'WebFetch'])
    expect(e.meta.deferredNotLoaded).toEqual(['CronList'])
  })
})

// A stand-in for `claude -p`: answers --version, sends the agent-loop request the way the real
// CLI does, and — when the stub replies with a tool call — sends the follow-up carrying the
// tools it asked for.
const FAKE_CLAUDE = `#!/usr/bin/env bun
if (process.argv.includes('--version')) { console.log('9.9.9 (Fake Code)'); process.exit(0) }
const tool = name => ({ name, description: name + ' does a thing', input_schema: { type: 'object' } })
const post = async body => {
  const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-beta': 'fake-beta' },
    body: JSON.stringify(body),
  })
  return res.text()
}
const base = tools => ({
  model: 'fake-1', max_tokens: 100, stream: true, tools, metadata: { user_id: 'device-and-account' },
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=' + Math.random() }, { type: 'text', text: 'You are Fake Code.' }],
  messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: ${JSON.stringify(DEFERRED_MESSAGE)} }],
})
const first = await post(base([tool('Read'), tool('ToolSearch')]))
if (first.includes('"tool_use"')) await post(base([tool('Read'), tool('ToolSearch'), tool('WebFetch'), tool('CronList')]))
`

describe('runExtraction against a fake claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extract-cc-test-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('loads the deferred tools through the scripted ToolSearch turn and writes every file', async () => {
    const bin = join(dir, 'fake-claude')
    writeFileSync(bin, FAKE_CLAUDE)
    chmodSync(bin, 0o755)
    const out = join(dir, 'out')

    const { extraction } = await runExtraction({
      bin,
      out,
      model: null,
      prompt: 'hi',
      config: null,
      timeoutSecs: 20,
      loadDeferred: true,
      mode: 'print',
    })

    expect(extraction.meta.toolCount).toBe(4)
    expect(extraction.meta.deferredNotLoaded).toEqual([])
    for (const file of ['system.txt', 'messages.txt', 'tools.json', 'request.json', 'meta.json', 'tools/WebFetch.txt']) {
      expect(existsSync(join(out, file))).toBe(true)
    }
    expect(readFileSync(join(out, 'messages.txt'), 'utf8')).toContain('role=system')
    const request = readFileSync(join(out, 'request.json'), 'utf8')
    expect(request).toContain('"metadata": "<redacted>"')
    expect(request).not.toContain('device-and-account')
  })

  test('with --no-deferred it stays on one request and the tools are the eager ones', async () => {
    const bin = join(dir, 'fake-claude')
    const { extraction } = await runExtraction({
      bin,
      out: join(dir, 'out-eager'),
      model: null,
      prompt: 'hi',
      config: null,
      timeoutSecs: 20,
      loadDeferred: false,
      mode: 'print',
    })
    expect(extraction.meta.toolCount).toBe(2)
    expect(extraction.meta.deferredNotLoaded).toEqual(['WebFetch', 'CronList'])
  })
})
