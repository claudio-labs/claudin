import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTimestampedHistory, type TimestampedHistoryEntry } from 'src/agent/history.js'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { emptyListNotice, filterPrompts, readListedPrompts } from 'src/sessions/historySearch/pickerList.js'
import { getInMemoryErrors } from 'src/shared/log.js'

function stored(display: string, timestamp = 1_000): TimestampedHistoryEntry {
  return { display, timestamp, resolve: async () => ({ display, pastedContents: {} }) }
}

async function* history(entries: readonly TimestampedHistoryEntry[]): AsyncGenerator<TimestampedHistoryEntry> {
  yield* entries
}

const displays = (prompts: readonly { display: string }[]): string[] => prompts.map(prompt => prompt.display)
const reading = () => new AbortController().signal

describe('readListedPrompts', () => {
  test('lists the prompts in the order the history gives them, each under a key of its own', async () => {
    const listed = await readListedPrompts(history([stored('twin one', 5), stored('twin two', 5), stored('other', 4)]), reading())
    expect(displays(listed)).toEqual(['twin one', 'twin two', 'other'])
    expect(listed.map(prompt => prompt.timestamp)).toEqual([5, 5, 4])
    expect(new Set(listed.map(prompt => prompt.key)).size).toBe(3)
  })

  test('hands on the way to read the pastes', async () => {
    const [listed] = await readListedPrompts(history([stored('with pastes')]), reading())
    expect(await listed?.resolve()).toEqual({ display: 'with pastes', pastedContents: {} })
  })

  test('passes over an entry that has no text and lists the rest', async () => {
    const textless = { timestamp: 3, resolve: async () => ({ display: '', pastedContents: {} }) } as unknown as TimestampedHistoryEntry
    const listed = await readListedPrompts(history([stored('newer'), textless, stored('older')]), reading())
    expect(displays(listed)).toEqual(['newer', 'older'])
  })

  test('stops reading once aborted, and lets go of the history', async () => {
    const aborting = new AbortController()
    let released = false
    async function* slowToEnd(): AsyncGenerator<TimestampedHistoryEntry> {
      try {
        yield stored('first')
        aborting.abort()
        yield stored('second')
        yield stored('third')
      } finally {
        released = true
      }
    }
    expect(displays(await readListedPrompts(slowToEnd(), aborting.signal))).toEqual(['first'])
    expect(released).toBe(true)
  })

  test('keeps what it read before the history failed, and logs the failure', async () => {
    async function* failing(): AsyncGenerator<TimestampedHistoryEntry> {
      yield stored('read in time')
      throw new Error('history unreadable')
    }
    const previous = process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC
    // logError records nothing at the default privacy level.
    process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
    const before = getInMemoryErrors().length
    try {
      expect(displays(await readListedPrompts(failing(), reading()))).toEqual(['read in time'])
      expect(getInMemoryErrors().slice(before)).toEqual([expect.objectContaining({ error: expect.stringContaining('history unreadable') })])
    } finally {
      if (previous === undefined) delete process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC
      else process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = previous
    }
  })
})

describe('readListedPrompts over the real history file', () => {
  const PROJECT = '/work/listed'
  let configHome = ''
  let restore = () => {}

  beforeEach(() => {
    const previousDir = process.env.CLAUDIN_CONFIG_DIR
    const previousRoot = getProjectRoot()
    configHome = mkdtempSync(join(tmpdir(), 'picker-list-'))
    process.env.CLAUDIN_CONFIG_DIR = configHome
    setProjectRoot(PROJECT)
    restore = () => {
      if (previousDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
      else process.env.CLAUDIN_CONFIG_DIR = previousDir
      setProjectRoot(previousRoot)
      rmSync(configHome, { recursive: true, force: true })
    }
  })

  afterEach(() => restore())

  test("a line of this project with no text is left out, and the picker still lists the prompts around it", async () => {
    const line = (fields: object) => JSON.stringify({ pastedContents: {}, timestamp: Date.now(), project: PROJECT, ...fields })
    const lines = [line({ display: 'older prompt' }), line({}), line({ display: ['not', 'text'] }), line({ display: 'newer prompt' })]
    writeFileSync(join(configHome, 'history.jsonl'), `${lines.join('\n')}\n`)
    expect(displays(await readListedPrompts(getTimestampedHistory(), reading()))).toEqual(['newer prompt', 'older prompt'])
  })
})

describe('filterPrompts', () => {
  const prompts = [{ display: 'GIT push' }, { display: 'print git log' }, { display: 'go into tmp' }, { display: 'grep todo' }]

  test('an empty query, or one of spaces, keeps every prompt in its order', () => {
    expect(filterPrompts(prompts, '')).toEqual(prompts)
    expect(filterPrompts(prompts, '   ')).toEqual(prompts)
  })

  test('prompts containing the query come first, then those holding its characters in order, each group in its order', () => {
    expect(displays(filterPrompts(prompts, 'git'))).toEqual(['GIT push', 'print git log', 'go into tmp'])
  })

  test('case and the spaces around the query are ignored', () => {
    expect(displays(filterPrompts(prompts, '  PUSH '))).toEqual(['GIT push'])
  })

  test('a space inside the query is a character to find like any other', () => {
    const spaced = [{ display: 'a-b' }, { display: 'a xb' }, { display: 'ab c' }]
    expect(displays(filterPrompts(spaced, 'a b'))).toEqual(['a xb'])
  })

  test('any line of a prompt can match', () => {
    expect(displays(filterPrompts([{ display: 'refactor\nthe tokenizer' }, { display: 'other' }], 'tokenizer'))).toEqual([
      'refactor\nthe tokenizer',
    ])
  })
})

describe('emptyListNotice', () => {
  test('says Loading… until the history is read, whatever the query', () => {
    expect(emptyListNotice(true, '')).toBe('Loading…')
    expect(emptyListNotice(true, 'git')).toBe('Loading…')
  })

  test('once read, an empty list is an empty history unless a query filtered it', () => {
    expect(emptyListNotice(false, '')).toBe('No history yet')
    expect(emptyListNotice(false, 'git')).toBe('No matching prompts')
  })

  test('a query of spaces filters nothing out, so it reads as an empty history', () => {
    expect(emptyListNotice(false, '   ')).toBe('No history yet')
  })
})
