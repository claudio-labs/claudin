/**
 * The ends of an inline search that the characterization suite leaves open:
 * what cancelling does to the mode, and that a Backspace on an empty query
 * ends the search without submitting. The prompt below keeps the fields the
 * real prompt input keeps and hands the hook a setter for each; the test sets
 * the query directly, standing in for the footer's query box.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React, { useEffect, useReducer } from 'react'
import type { HistoryEntry } from 'src/platform/config/config.js'
import { useHistorySearch } from 'src/sessions/hooks/useHistorySearch.js'
import type { PromptInputMode } from 'src/shared/types/textInputTypes.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'

const CTRL_R = '\x12'
const CTRL_C = '\x03'
const BACKSPACE = '\x7f'
const SLOW = 20_000

/** What the prompt holds. A search starts from a draft with the cursor inside it. */
type PromptFields = {
  input: string
  cursor: number
  mode: PromptInputMode
  pasted: HistoryEntry['pastedContents']
  searching: boolean
}

const DRAFT: PromptFields = { input: 'draft', cursor: 2, mode: 'prompt', pasted: {}, searching: false }

/** One field and its new value. */
type FieldChange = { [K in keyof PromptFields]: [K, PromptFields[K]] }[keyof PromptFields]

/** A field given the value it holds changes nothing and re-renders nothing, as with a state setter. */
function applyChange(fields: PromptFields, [field, value]: FieldChange): PromptFields {
  return Object.is(fields[field], value) ? fields : { ...fields, [field]: value }
}

type Seen = PromptFields & {
  query: string
  match: HistoryEntry | undefined
  setQuery: (query: string) => void
}

type Probe = { seen?: Seen; mounted: boolean; submitted: HistoryEntry[] }

function Prompt({ probe }: { probe: Probe }): React.ReactNode {
  const [fields, change] = useReducer(applyChange, DRAFT)
  const search = useHistorySearch(
    entry => {
      probe.submitted.push(entry)
    },
    fields.input,
    input => change(['input', input]),
    cursor => change(['cursor', cursor]),
    fields.cursor,
    mode => change(['mode', mode]),
    fields.mode,
    fields.searching,
    searching => change(['searching', searching]),
    pasted => change(['pasted', pasted]),
    fields.pasted,
  )
  probe.seen = { ...fields, query: search.historyQuery, match: search.historyMatch, setQuery: search.setHistoryQuery }
  // Declared after the hook, so the hook's key handlers are subscribed once this has run.
  useEffect(() => {
    probe.mounted = true
  }, [probe])
  return null
}

let configHome = ''
let previousDir: string | undefined

beforeEach(() => {
  previousDir = process.env.CLAUDIN_CONFIG_DIR
  configHome = mkdtempSync(join(tmpdir(), 'use-history-search-'))
  process.env.CLAUDIN_CONFIG_DIR = configHome
  const record = { display: '!git status', pastedContents: {}, timestamp: Date.now() - 60_000, project: '/work/hook' }
  writeFileSync(join(configHome, 'history.jsonl'), `${JSON.stringify(record)}\n`)
})

afterEach(() => {
  if (previousDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = previousDir
  rmSync(configHome, { recursive: true, force: true })
})

async function until(check: () => boolean, what: string, probe: Probe): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(probe.seen)}`)
    await Bun.sleep(10)
  }
}

/** Mounts the prompt, starts a search, and lets it switch the prompt to bash mode on `!git status`. */
async function searchIntoBashMode(check: (probe: Probe, press: (keys: string) => void) => Promise<void>): Promise<void> {
  const terminal = createFakeTerminal({ columns: 80 })
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false, exitOnCtrlC: false })
  const probe: Probe = { mounted: false, submitted: [] }
  root.render(
    <KeybindingSetup>
      <Prompt probe={probe} />
    </KeybindingSetup>,
  )
  try {
    await until(() => probe.mounted, 'the prompt to mount', probe)
    terminal.type(CTRL_R)
    await until(() => probe.seen?.searching === true, 'Ctrl+R to start a search', probe)
    probe.seen?.setQuery('status')
    await until(() => probe.seen?.match?.display === '!git status', 'the bash-mode prompt to match', probe)
    expect(probe.seen).toMatchObject({ input: '!git status', mode: 'bash' })
    await check(probe, keys => terminal.type(keys))
  } finally {
    root.unmount()
    terminal.close()
  }
}

describe('useHistorySearch: cancelling', () => {
  test(
    'Ctrl+C after a match switched to bash mode gives back the prompt in the mode it was in',
    async () => {
      await searchIntoBashMode(async (probe, press) => {
        press(CTRL_C)
        await until(() => probe.seen?.searching === false, 'Ctrl+C to end the search', probe)
        expect(probe.seen).toMatchObject({ input: 'draft', cursor: 2, mode: 'prompt', query: '', match: undefined })
        expect(probe.submitted).toEqual([])
      })
    },
    SLOW,
  )

  test(
    'Backspace on an empty query ends the search, submitting nothing',
    async () => {
      await searchIntoBashMode(async (probe, press) => {
        probe.seen?.setQuery('')
        await until(() => probe.seen?.query === '' && probe.seen.mode === 'prompt', 'the empty query to restore the prompt', probe)
        press(BACKSPACE)
        await until(() => probe.seen?.searching === false, 'Backspace to end the search', probe)
        await Bun.sleep(100)
        expect(probe.seen).toMatchObject({ input: 'draft', cursor: 2, mode: 'prompt' })
        expect(probe.submitted).toEqual([])
      })
    },
    SLOW,
  )
})
