/**
 * Characterization of `runResumeBranch` (src/platform/main/defaultAction/resume.ts),
 * what `claudin --resume [value]` and `claudin --from-pr [value]` do, pinned
 * before the lever cut removes its `--remote` and `--teleport` branches. Those
 * two are not pinned.
 *
 * The branch ends in one of two screens:
 * - a session it could pin down (a session id, or a title only one session
 *   carries) is loaded, taken over, and handed to the REPL with its messages
 *   and its agent;
 * - anything else opens the session picker, searching for the value given
 *   and filtered to the PR given.
 * A session id that names no session is an error, and so is a file download
 * that fails outright; downloads that partly fail only warn.
 *
 * The world is real: transcripts written through the session storage API into
 * a temp CLAUDIN_CONFIG_DIR, and an Ink root drawing into a fake terminal.
 * The REPL is the one stand-in. It is handed over through `setPreloadedChunks`,
 * the launcher's own way to receive an already-imported REPL module, and only
 * records the props it was given; the real one belongs to another slice and
 * would start the whole session.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import React from 'react'
import { setPreloadedChunks } from 'src/agent/repl/replLauncher.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  closeScreen,
  ExitRequest,
  openScreen,
  outcome,
  SCREEN_CLOSED,
  type Screen,
  trapExits,
  waitFor,
} from 'src/platform/main/__testutils__/bootHarness.js'
import { runResumeBranch } from 'src/platform/main/defaultAction/resume.js'
import {
  agent,
  definitions,
  resumeContext,
  useRestoreSandbox,
  writeSession,
} from 'src/sessions/__testutils__/restoreHarness.js'
import type { Message } from 'src/shared/types/message.js'
import { createStatsStore } from 'src/terminal/contexts/stats.js'
import { Text } from 'src/terminal/ink.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'

const TIMEOUT = 30_000
const sandbox = useRestoreSandbox()

let prefetchSwitch: string | undefined
beforeAll(() => {
  prefetchSwitch = process.env.CLAUDIN_EXIT_AFTER_FIRST_RENDER
  process.env.CLAUDIN_EXIT_AFTER_FIRST_RENDER = '1'
})
afterAll(() => {
  if (prefetchSwitch === undefined) delete process.env.CLAUDIN_EXIT_AFTER_FIRST_RENDER
  else process.env.CLAUDIN_EXIT_AFTER_FIRST_RENDER = prefetchSwitch
})

// --- the REPL stand-in ---------------------------------------------------------

type ReplProps = Record<string, unknown> & {
  initialMessages?: Message[]
  mainThreadAgentDefinition?: { agentType: string }
}
let replProps: ReplProps | undefined

function ReplStandIn(props: ReplProps): React.ReactNode {
  replProps = props
  return <Text>REPL stand-in: {props.initialMessages?.length ?? 0} messages</Text>
}

function offerStandInRepl(): void {
  replProps = undefined
  setPreloadedChunks(import('src/agent/ui/App.js'), Promise.resolve({ REPL: ReplStandIn } as never))
}

/** Rewrites every message timestamp in a transcript: all the same, or one second apart. */
function restamp(transcript: string, tied: boolean): void {
  const base = Date.parse('2026-09-28T10:00:00.000Z')
  let index = 0
  const lines = readFileSync(transcript, 'utf8').split('\n').map(line => {
    if (!line) return line
    const entry = JSON.parse(line) as { timestamp?: string; uuid?: string }
    if (!entry.uuid || !entry.timestamp) return line
    entry.timestamp = new Date(base + (tied ? 0 : 1000 * index++)).toISOString()
    return JSON.stringify(entry)
  })
  writeFileSync(transcript, lines.join('\n'))
}

const textOf = (message: Message): string => {
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (part as { text?: string }).text ?? '').join('')
  return ''
}

// --- running the branch ----------------------------------------------------------

let screen: Screen | undefined
let exits: ReturnType<typeof trapExits> | undefined

afterEach(() => {
  if (screen) closeScreen(screen)
  screen = undefined
  exits?.release()
  exits = undefined
  // A stand-in the branch never consumed must not reach another suite's launchRepl.
  setPreloadedChunks(undefined as never, undefined as never)
})

type Options = { resume?: string | boolean | null; fromPr?: string | boolean; forkSession?: boolean }

async function resume(
  options: Options,
  extra: {
    fileDownloadPromise?: Promise<Array<{ success: boolean }>>
    agentDefinitions?: ReturnType<typeof definitions>
    sessionConfig?: Record<string, unknown>
  } = {},
) {
  screen = await openScreen(160)
  exits = trapExits()
  offerStandInRepl()
  const agentRef = { current: undefined as unknown }
  const run = runResumeBranch({
    root: screen.root,
    ctx: { fileDownloadPromise: extra.fileDownloadPromise } as never,
    options,
    teleport: undefined,
    remote: null,
    mainThreadAgentDefinitionRef: agentRef,
    sessionConfig: {
      commands: [],
      initialTools: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      charMarker: 'session-config-passed',
      ...extra.sessionConfig,
    },
    resumeContext: resumeContext(sandbox.projectDir, { agentDefinitions: extra.agentDefinitions }) as never,
    getFpsMetrics: () => undefined,
    stats: createStatsStore(),
    initialState: getDefaultAppState(),
  })
  // Most tests leave the branch running and let afterEach close its screen.
  run.catch(() => {})
  return { run, agentRef, term: screen.term }
}

const showsRepl = (s: string) => s.includes('REPL stand-in')
const showsPicker = (s: string) => s.includes('No conversations found') || /Resume|Search/.test(s)

// --- a session it can pin down -------------------------------------------------------

describe('runResumeBranch — a session it can pin down goes to the REPL', () => {
  const lookups = [
    { by: 'session id', value: (s: { id: string }) => s.id },
    { by: 'exact title', value: () => 'Parser rewrite' },
    { by: 'exact title, padded', value: () => '   Parser rewrite  ' },
  ]
  for (const lookup of lookups) {
    test(`--resume <${lookup.by}> loads that session's messages and takes the session over`, async () => {
      const written = await writeSession({ title: 'Parser rewrite' })
      await writeSession({ title: 'Something else' })
      const { run, agentRef, term } = await resume({ resume: lookup.value(written) })
      await waitFor(term.screen, showsRepl)
      expect(replProps!.initialMessages!.map(textOf)[0]).toBe('Let us fix the parser.')
      expect(replProps!.charMarker).toBe('session-config-passed')
      expect(getSessionId()).toBe(written.id as never)
      expect(agentRef.current).toBeUndefined()
      closeScreen(screen!)
      expect(((await outcome(run)).error as Error).message).toBe(SCREEN_CLOSED)
    }, TIMEOUT)
  }

  // Fixed on 2026-10-03 (was pinned as a defect): a session id is resolved by
  // getLastSessionLog, which used to keep the FIRST of several messages sharing
  // the latest timestamp and rebuild the chain from it, losing every later one.
  // On a tie the later-written message now wins, so every resume keeps them all.
  const stampCases = [
    { by: 'session id', stamps: 'distinct', texts: ['Let us fix the parser.', 'On it.', 'That is all for now.'] },
    { by: 'session id', stamps: 'tied', texts: ['Let us fix the parser.', 'On it.', 'That is all for now.'] },
    { by: 'exact title', stamps: 'tied', texts: ['Let us fix the parser.', 'On it.', 'That is all for now.'] },
  ]
  for (const c of stampCases) {
    test(`messages with ${c.stamps} timestamps, resumed by ${c.by}`, async () => {
      const written = await writeSession({ title: 'Parser rewrite' })
      restamp(written.transcript, c.stamps === 'tied')
      const { term } = await resume({ resume: c.by === 'session id' ? written.id : 'Parser rewrite' })
      await waitFor(term.screen, showsRepl)
      expect(replProps!.initialMessages!.map(textOf)).toEqual(c.texts)
    }, TIMEOUT)
  }

  test('--fork-session keeps the messages but not the session id', async () => {
    const written = await writeSession({ title: 'Parser rewrite' })
    const { term } = await resume({ resume: written.id, forkSession: true })
    await waitFor(term.screen, showsRepl)
    expect(replProps!.initialMessages!.map(textOf)[0]).toBe('Let us fix the parser.')
    expect(getSessionId()).not.toBe(written.id as never)
  }, TIMEOUT)

  test("brings back the session's agent and hands it to the REPL", async () => {
    const written = await writeSession({ agentSetting: 'reviewer' })
    const reviewer = agent('reviewer')
    const { term, agentRef } = await resume({ resume: written.id }, { agentDefinitions: definitions([reviewer]) })
    await waitFor(term.screen, showsRepl)
    expect(agentRef.current).toBe(reviewer)
    expect(replProps!.mainThreadAgentDefinition).toBe(reviewer)
  }, TIMEOUT)

  test('waits for file downloads first, and only warns when some fail', async () => {
    const written = await writeSession({ title: 'Parser rewrite' })
    const warnings: string[] = []
    const realWrite = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const downloads = [{ success: true }, { success: false }, { success: false }]
      const { term } = await resume({ resume: written.id }, { fileDownloadPromise: Promise.resolve(downloads) })
      await waitFor(term.screen, showsRepl)
    } finally {
      process.stderr.write = realWrite
    }
    expect(warnings.join('')).toContain('Warning: 2/3 file(s) failed to download.')
  }, TIMEOUT)
})

// --- errors -----------------------------------------------------------------------------

describe('runResumeBranch — errors end the process with code 1', () => {
  test('a session id that names no session', async () => {
    await writeSession({ title: 'Parser rewrite' })
    const missing = randomUUID()
    const { run, term } = await resume({ resume: missing })
    const settled = await outcome(run)
    expect(settled.error).toBeInstanceOf(ExitRequest)
    expect(exits!.codes[0]).toBe(1)
    expect(term.screen()).toContain(`No conversation found with session ID: ${missing}`)
    expect(replProps).toBeUndefined()
  }, TIMEOUT)

  test('a file download that fails outright', async () => {
    const { run, term } = await resume({ resume: true }, { fileDownloadPromise: Promise.reject(new Error('network is down')) })
    const settled = await outcome(run)
    expect(settled.error).toBeInstanceOf(ExitRequest)
    expect(exits!.codes).toEqual([1])
    expect(term.screen()).toContain('Error downloading files: network is down')
  }, TIMEOUT)
})

// --- the picker ----------------------------------------------------------------------------

describe('runResumeBranch — anything else opens the session picker', () => {
  async function seedSessions(): Promise<void> {
    await writeSession({
      title: 'Linked to seventeen',
      pr: { number: 17, url: 'https://github.com/acme/app/pull/17', repository: 'acme/app' },
    })
    await writeSession({
      title: 'Linked to eighteen',
      pr: { number: 18, url: 'https://github.com/acme/app/pull/18', repository: 'acme/app' },
    })
    await writeSession({ title: 'Parser rewrite' })
    await writeSession({ title: 'Parser rewrite' })
  }

  /** The text in the picker's search box, as drawn. */
  const searchBox = (screenText: string): string | undefined => /│ ⌕ (.*?) *│/.exec(screenText)?.[1]

  const cases: Array<{ name: string; options: Options; shown: string[]; hidden: string[]; searchBox: string }> = [
    {
      name: '--resume with no value lists every session of the project',
      options: { resume: true },
      shown: ['Linked to seventeen', 'Linked to eighteen', 'Parser rewrite'],
      hidden: [],
      searchBox: 'Search…',
    },
    {
      name: '--resume with only blanks is the same as no value',
      options: { resume: '   ' },
      shown: ['Linked to seventeen', 'Linked to eighteen', 'Parser rewrite'],
      hidden: [],
      searchBox: 'Search…',
    },
    {
      name: '--resume <title two sessions share> searches for it',
      options: { resume: 'Parser rewrite' },
      shown: ['Parser rewrite'],
      hidden: ['Linked to seventeen', 'Linked to eighteen'],
      searchBox: 'Parser rewrite',
    },
    {
      name: '--resume <words no title matches exactly> searches for them',
      options: { resume: '  eighteen ' },
      shown: ['Linked to eighteen'],
      hidden: ['Linked to seventeen', 'Parser rewrite'],
      searchBox: 'eighteen',
    },
    {
      name: '--from-pr with no value keeps only sessions linked to a PR',
      options: { fromPr: true },
      shown: ['Linked to seventeen', 'Linked to eighteen'],
      hidden: ['Parser rewrite'],
      searchBox: 'Search…',
    },
    {
      name: '--from-pr <number> keeps only that PR',
      options: { fromPr: '17' },
      shown: ['Linked to seventeen'],
      hidden: ['Linked to eighteen', 'Parser rewrite'],
      searchBox: 'Search…',
    },
  ]

  for (const c of cases) {
    test(c.name, async () => {
      await seedSessions()
      const { run, term } = await resume(c.options)
      await waitFor(term.screen, s => c.shown.every(title => s.includes(title)))
      await Bun.sleep(150)
      const shown = term.screen()
      expect(searchBox(shown)).toBe(c.searchBox)
      for (const title of c.hidden) expect(shown).not.toContain(title)
      expect(replProps).toBeUndefined()
      closeScreen(screen!)
      expect(((await outcome(run)).error as Error).message).toBe(SCREEN_CLOSED)
    }, TIMEOUT)
  }

  test('with no session at all, the picker says so', async () => {
    const { term } = await resume({ resume: true })
    expect(await waitFor(term.screen, showsPicker)).toContain('No conversations found to resume.')
  }, TIMEOUT)

  test('a download that partly fails still warns before the picker opens', async () => {
    await seedSessions()
    const warnings: string[] = []
    const realWrite = process.stderr.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const { term } = await resume({ resume: true }, { fileDownloadPromise: Promise.resolve([{ success: false }]) })
      await waitFor(term.screen, s => s.includes('Parser rewrite'))
    } finally {
      process.stderr.write = realWrite
    }
    expect(warnings.join('')).toContain('Warning: 1/1 file(s) failed to download.')
  }, TIMEOUT)
})
