/**
 * What happens when someone presses Enter at the REPL prompt. `useOnSubmit`
 * has one caller, REPL.tsx, so these tests drive it from there: a whole REPL
 * on the fake terminal, keys typed in, the screen and the turn read back.
 *
 * No model is called. The REPL's own `onBeforeQuery` prop is the seam: it sees
 * every turn the submit starts, and it either refuses the turn (`false`) or
 * holds it open until the test lets go, which is how "a turn is running" is
 * set up below.
 *
 * Not pinned here, because the lever deletes it: the remote-session branch
 * (`activeRemote.isRemoteMode`) and speculation accept.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { makeHistoryReader } from 'src/agent/history.js'
import type { Message } from 'src/shared/types/message.js'
import { setupReplMocks, teardownReplMocks } from 'src/agent/repl/__testutils__/replTestHarness.js'
import {
  KEY,
  fixtureCommand,
  gate,
  mountLiveRepl,
  promptRow,
  releaseAllRepls,
  settle,
  transcriptPart,
  type CommandRun,
  type LiveRepl,
} from 'src/agent/repl/__testutils__/liveRepl.js'

const TIMEOUT = 60_000

beforeAll(setupReplMocks)
afterAll(teardownReplMocks)
afterEach(releaseAllRepls)

type Turn = { input: string; conversation: Message[] }

/** A REPL whose turns are recorded and, while `hold` is set, kept running. */
async function replWithTurns(extra: Parameters<typeof mountLiveRepl>[0] = {}) {
  const turns: Turn[] = []
  let hold: ReturnType<typeof gate<boolean>> | null = null
  const repl = await mountLiveRepl({
    ...extra,
    props: {
      ...extra.props,
      onBeforeQuery: async (input, conversation) => {
        turns.push({ input, conversation: [...conversation] })
        return hold ? hold.promise : false
      },
    },
  })
  return {
    repl,
    turns,
    /** Starts a turn with `text` and leaves it running until `finish()`. */
    async startTurn(text: string) {
      hold = gate<boolean>()
      const before = turns.length
      await submit(repl, text)
      await repl.waitFor('the turn to start', () => turns.length > before)
      await repl.waitFor('the spinner', screen => screen.includes('esc to interrupt'))
      await settle()
    },
    async finish() {
      const open = hold
      hold = null
      open?.open(false)
      await repl.waitFor('the turn to end', screen => !screen.includes('esc to interrupt'))
    },
  }
}

async function submit(repl: LiveRepl, text: string): Promise<void> {
  await repl.type(text)
  await repl.type(KEY.enter)
}

async function newestHistory(count: number): Promise<string[]> {
  const out: string[] = []
  for await (const entry of makeHistoryReader()) {
    out.push(entry.display)
    if (out.length === count) break
  }
  return out
}

function userTexts(conversation: Message[]): Array<{ text: string; meta: boolean }> {
  return conversation.flatMap(message => {
    if (message.type !== 'user') return []
    const content = message.message.content
    const text = typeof content === 'string'
      ? content
      : content.map(block => (block.type === 'text' ? block.text : '')).join('')
    return [{ text, meta: message.isMeta === true }]
  })
}

describe('a prompt submitted while nothing runs', () => {
  test('is echoed, starts a turn carrying the conversation, empties the input and lands in history', async () => {
    const { repl, turns } = await replWithTurns()
    await submit(repl, 'explain the build')
    await repl.waitFor('the turn', () => turns.length === 1)
    const screen = await repl.waitFor('the echo', s => transcriptPart(s).includes('❯ explain the build'))

    expect(turns[0]!.input).toBe('explain the build')
    expect(userTexts(turns[0]!.conversation)).toEqual([{ text: 'explain the build', meta: false }])
    expect(promptRow(screen)).toBe('❯')
    expect(await newestHistory(1)).toEqual(['explain the build'])
  }, TIMEOUT)

  test('a second prompt carries the first one in its conversation', async () => {
    const { repl, turns } = await replWithTurns()
    for (const text of ['one', 'two']) {
      await submit(repl, text)
      await repl.waitFor(`turn "${text}"`, () => turns.some(turn => turn.input === text))
    }
    expect(userTexts(turns[1]!.conversation).map(entry => entry.text)).toEqual(['one', 'two'])
  }, TIMEOUT)

  test('in bash mode it runs the command itself, keeps the ! in history, and starts no turn', async () => {
    const { repl, turns } = await replWithTurns()
    await repl.type('!')
    await submit(repl, 'echo from-the-shell')
    await repl.waitFor('the command output', s => s.includes('⎿  from-the-shell'))

    expect(turns).toEqual([])
    expect(await newestHistory(1)).toEqual(['!echo from-the-shell'])
  }, TIMEOUT)
})

describe('a stashed prompt comes back to the input', () => {
  type Ctx = Awaited<ReturnType<typeof replWithTurns>>
  const STASHED = '❯ kept for later'
  const cases: Array<{ name: string; busy: boolean; send: (ctx: Ctx) => Promise<void> }> = [
    {
      name: 'after a plain prompt is sent',
      busy: false,
      send: async ({ repl, turns }) => {
        await submit(repl, 'sent now')
        await repl.waitFor('the turn', () => turns.length === 1)
      },
    },
    {
      name: 'after a slash command has finished',
      busy: false,
      send: async ({ repl }) => {
        await submit(repl, '/viewer')
        await repl.waitFor('the command to close', s => transcriptPart(s).includes('viewer closed'))
      },
    },
    {
      name: 'after a prompt is queued behind a running turn',
      busy: true,
      send: async ({ repl }) => {
        await submit(repl, 'queued while busy')
        await repl.waitFor('the queued prompt', s => s.includes('queued while busy'))
      },
    },
    {
      name: 'after an immediate command is closed',
      busy: true,
      send: async ({ repl }) => {
        await submit(repl, '/peek')
        await repl.waitFor('the command view', s => s.includes('peek view:'))
        expect(promptRow(repl.screen())).toBe('❯')
      },
    },
  ]

  for (const { name, busy, send } of cases) {
    test(name, async () => {
      const viewer = fixtureCommand('viewer', {
        view: run => {
          setTimeout(() => run.done('viewer closed'), 50)
          return null
        },
      })
      const peek = fixtureCommand('peek', {
        immediate: true,
        view: run => {
          setTimeout(() => run.done(), 300)
          return undefined
        },
      })
      const ctx = await replWithTurns({ props: { commands: [viewer.command, peek.command] } })
      if (busy) await ctx.startTurn('busy')
      await ctx.repl.type('kept for later')
      await ctx.repl.type(KEY.ctrlS)
      await ctx.repl.waitFor('the stash', s => s.includes('Stashed') && promptRow(s) === '❯')
      await send(ctx)
      await ctx.repl.waitFor('the stash back', s => promptRow(s) === STASHED)
      if (busy) await ctx.finish()
    }, TIMEOUT)
  }
})

describe('an immediate command typed while a turn runs', () => {
  test('opens at once with its arguments, clears the input and leaves the turn running', async () => {
    const peek = fixtureCommand('peek', { immediate: true })
    const { repl, turns, startTurn, finish } = await replWithTurns({ props: { commands: [peek.command] } })
    await startTurn('busy')
    await submit(repl, '/peek  some args ')
    const screen = await repl.waitFor('the view', s => s.includes('peek view: some args'))

    expect(peek.runs.map(run => run.args)).toEqual(['some args'])
    expect(promptRow(screen)).toBe('❯')
    expect(screen).toContain('esc to interrupt')
    expect(turns.map(turn => turn.input)).toEqual(['busy'])
    expect(await newestHistory(1)).toEqual(['busy'])
    await finish()
  }, TIMEOUT)

  const closings: Array<{
    name: string
    close: (done: CommandRun['done']) => void
    transcript: string[]
    absent: string[]
    meta: string[]
  }> = [
    {
      name: 'a result is shown and echoed into the transcript',
      close: done => done('peek says hi'),
      transcript: ['❯ /peek abc', '⎿  peek says hi'],
      absent: [],
      meta: [],
    },
    {
      name: 'a skipped result stays out of the transcript',
      close: done => done('quiet result', { display: 'skip' }),
      transcript: [],
      absent: ['quiet result', '/peek abc'],
      meta: [],
    },
    {
      name: 'meta messages reach the next turn without being shown',
      close: done => done(undefined, { metaMessages: ['hidden context line'] }),
      transcript: [],
      absent: ['hidden context line'],
      meta: ['hidden context line'],
    },
  ]

  for (const { name, close, transcript, absent, meta } of closings) {
    test(`when it is closed: ${name}`, async () => {
      const peek = fixtureCommand('peek', { immediate: true })
      const { repl, turns, startTurn, finish } = await replWithTurns({ props: { commands: [peek.command] } })
      await startTurn('busy')
      await submit(repl, '/peek abc')
      await repl.waitFor('the view', s => s.includes('peek view: abc'))

      close(peek.runs[0]!.done)
      const screen = await repl.waitFor('the view to close', s => !s.includes('peek view: abc'))
      for (const line of transcript) expect(transcriptPart(screen)).toContain(line)
      for (const text of absent) expect(transcriptPart(screen)).not.toContain(text)

      await finish()
      await submit(repl, 'next')
      await repl.waitFor('the next turn', () => turns.length === 2)
      const hidden = userTexts(turns[1]!.conversation).filter(entry => entry.meta).map(entry => entry.text)
      expect(hidden).toEqual(meta)
    }, TIMEOUT)
  }

  test('one that closes inside its own call never shows a view', async () => {
    const quick = fixtureCommand('quick', {
      immediate: true,
      view: run => {
        run.done('done already')
        return null
      },
    })
    const { repl, startTurn, finish } = await replWithTurns({ props: { commands: [quick.command] } })
    await startTurn('busy')
    await submit(repl, '/quick')
    const screen = await repl.waitFor('the echo', s => transcriptPart(s).includes('⎿  done already'))
    expect(screen).not.toContain('quick view:')
    expect(quick.runs).toHaveLength(1)
    await finish()
  }, TIMEOUT)

  test('a command that is not immediate waits for the turn to end', async () => {
    const later = fixtureCommand('later')
    const { repl, startTurn, finish } = await replWithTurns({ props: { commands: [later.command] } })
    await startTurn('busy')
    await submit(repl, '/later')
    await Bun.sleep(300)
    expect(later.runs).toHaveLength(0)

    await finish()
    await repl.waitFor('the view', s => s.includes('later view:'))
    expect(later.runs).toHaveLength(1)
  }, TIMEOUT)
})

describe('the ← key on an empty prompt opens /resume', () => {
  test('while idle: the command runs, the prompt is untouched and history skips it', async () => {
    const resume = fixtureCommand('resume')
    const { repl, turns } = await replWithTurns({ props: { commands: [resume.command] } })
    await submit(repl, 'earlier prompt')
    await repl.waitFor('the turn', () => turns.length === 1)

    await repl.type(KEY.left)
    await repl.waitFor('the view', s => s.includes('resume view:'))
    expect(resume.runs).toHaveLength(1)
    expect(await newestHistory(1)).toEqual(['earlier prompt'])
  }, TIMEOUT)

  test('while a turn runs: it opens at once instead of queueing', async () => {
    const resume = fixtureCommand('resume')
    const { repl, startTurn, finish } = await replWithTurns({ props: { commands: [resume.command] } })
    await startTurn('busy')
    await repl.type(KEY.left)
    const screen = await repl.waitFor('the view', s => s.includes('resume view:'))
    expect(screen).toContain('esc to interrupt')
    expect(resume.runs).toHaveLength(1)
    await finish()
  }, TIMEOUT)
})
