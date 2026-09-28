import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHistoryReader } from 'src/agent/history.js'
import type { HistoryEntry } from 'src/platform/config/config.js'
import { createHistoryScan } from 'src/sessions/historySearch/historyScan.js'

const prompt = (display: string): HistoryEntry => ({ display, pastedContents: {} })

/** Newest first, the way the history reader hands prompts out. */
async function* newestFirst(entries: readonly HistoryEntry[]): AsyncGenerator<HistoryEntry> {
  yield* entries
}

async function drain(scan: ReturnType<typeof createHistoryScan>): Promise<string[]> {
  const found: string[] = []
  for (let entry = await scan.next(); entry; entry = await scan.next()) found.push(entry.display)
  return found
}

describe('createHistoryScan', () => {
  test('hands out the prompts containing the query, newest first, then nothing, and keeps saying so', async () => {
    const scan = createHistoryScan(newestFirst([prompt('npm test'), prompt('git log'), prompt('npm ci')]), 'npm')
    expect(await drain(scan)).toEqual(['npm test', 'npm ci'])
    expect(await scan.next()).toBeUndefined()
  })

  test('matches case-sensitively, on any line of a prompt', async () => {
    const scan = createHistoryScan(newestFirst([prompt('Build it'), prompt('first\nthen build')]), 'build')
    expect(await drain(scan)).toEqual(['first\nthen build'])
  })

  test('hands out each text once; with and without a leading ! they are two texts', async () => {
    const history = [prompt('ls -la'), prompt('!ls -la'), prompt('ls -la'), prompt('!ls -la')]
    expect(await drain(createHistoryScan(newestFirst(history), 'ls'))).toEqual(['ls -la', '!ls -la'])
  })

  test('the entry it hands out is the one the history gave, pastes and all', async () => {
    const withPaste: HistoryEntry = { display: 'see [Pasted text #1]', pastedContents: { 1: { id: 1, type: 'text', content: 'x' } } }
    expect(await createHistoryScan(newestFirst([withPaste]), 'see').next()).toBe(withPaste)
  })

  test('skips an entry that has no text and still reaches the older ones', async () => {
    const textless = { pastedContents: {} } as unknown as HistoryEntry
    const scan = createHistoryScan(newestFirst([prompt('alpha two'), textless, prompt('alpha one')]), 'alpha')
    expect(await drain(scan)).toEqual(['alpha two', 'alpha one'])
  })

  test('answers calls in the order they were made, even before the previous one settled', async () => {
    const scan = createHistoryScan(newestFirst([prompt('a1'), prompt('b'), prompt('a2'), prompt('a3')]), 'a')
    const answers = await Promise.all([scan.next(), scan.next(), scan.next(), scan.next()])
    expect(answers.map(entry => entry?.display)).toEqual(['a1', 'a2', 'a3', undefined])
  })

  test('once closed, it stops reading: a pending call finds nothing and the history is released', async () => {
    let reading = false
    let released = false
    let letGo = () => {}
    const gate = new Promise<void>(resolve => {
      letGo = resolve
    })
    async function* slowHistory(): AsyncGenerator<HistoryEntry> {
      try {
        reading = true
        await gate
        yield prompt('match one')
        yield prompt('match two')
      } finally {
        released = true
      }
    }
    const scan = createHistoryScan(slowHistory(), 'match')
    const pending = scan.next()
    while (!reading) await Bun.sleep(0)
    scan.close()
    letGo()
    expect(await pending).toBeUndefined()
    expect(await scan.next()).toBeUndefined()
    await Bun.sleep(0)
    expect(released).toBe(true)
  })

  test('a history that fails to read rejects that call, and the scan finds nothing after it', async () => {
    async function* broken(): AsyncGenerator<HistoryEntry> {
      yield prompt('fine match')
      throw new Error('disk gone')
    }
    const scan = createHistoryScan(broken(), 'match')
    expect((await scan.next())?.display).toBe('fine match')
    await expect(scan.next()).rejects.toThrow('disk gone')
    expect(await scan.next()).toBeUndefined()
  })
})

describe('createHistoryScan over the real history file', () => {
  let configHome = ''
  let previousDir: string | undefined

  beforeEach(() => {
    previousDir = process.env.CLAUDIN_CONFIG_DIR
    configHome = mkdtempSync(join(tmpdir(), 'history-scan-'))
    process.env.CLAUDIN_CONFIG_DIR = configHome
  })

  afterEach(() => {
    if (previousDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = previousDir
    rmSync(configHome, { recursive: true, force: true })
  })

  test('a line with a project but no text is passed over, and the prompts written before it are reached', async () => {
    const line = (fields: object) => JSON.stringify({ pastedContents: {}, timestamp: 1, project: '/p', ...fields })
    const lines = [line({ display: 'alpha one' }), line({}), line({ display: 42 }), line({ display: 'alpha two' })]
    writeFileSync(join(configHome, 'history.jsonl'), `${lines.join('\n')}\n`)
    expect(await drain(createHistoryScan(makeHistoryReader(), 'alpha'))).toEqual(['alpha two', 'alpha one'])
  })
})
