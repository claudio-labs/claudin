import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import type { LiveSession } from 'src/sessions/concurrentSessions.js'
import { SessionsScreen, type SessionsScreenProps } from 'src/sessions/ui/SessionsScreen.js'
import type { LogOption } from 'src/shared/types/logs.js'
import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const ENTER = '\r'

function log(sessionId: string, minutesAgo: number, title: string): LogOption {
  const modified = new Date(Date.now() - minutesAgo * 60_000)
  return {
    date: modified.toISOString(),
    messages: [],
    value: 0,
    created: modified,
    modified,
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    sessionId,
    customTitle: title,
    fullPath: `/tmp/sessions-screen-test/${sessionId}.jsonl`,
  }
}

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function lastFrame(output: string): string {
  let frame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const end = output.indexOf(SYNC_END, start + SYNC_START.length)
    if (end === -1) break
    const candidate = output.slice(start + SYNC_START.length, end)
    if (candidate.trim().length > 0) frame = candidate
    cursor = end + SYNC_END.length
  }
  return stripAnsi(frame ?? output)
}

async function waitFor(read: () => string, predicate: (value: string) => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (predicate(read())) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${label}. Last value:\n${read().slice(-1500)}`)
}

// A key written before the handler subscribes is dropped (see Stats.test.tsx),
// so a press is re-sent until its effect shows.
async function pressUntil(
  write: (sequence: string) => void,
  sequence: string,
  done: () => boolean,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    write(sequence)
    const settle = Date.now() + 1000
    while (Date.now() < settle) {
      await Bun.sleep(20)
      if (done()) return
    }
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function mount(props: Partial<SessionsScreenProps> & Pick<SessionsScreenProps, 'logs'>) {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const selected: LogOption[] = []
  let cancelled = 0
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(
    <AppStateProvider>
      <KeybindingSetup>
        <SessionsScreen
          currentSessionId="cur"
          instanceSessionIds={['cur']}
          showAllProjects={false}
          maxHeight={20}
          onSelect={l => selected.push(l)}
          onCancel={() => cancelled++}
          loadLiveSessions={async () => []}
          {...props}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )
  const frame = (): string => lastFrame(output)
  await waitFor(frame, f => f.includes('Sessions'), 'the sessions screen')
  return {
    frame,
    press: (sequence: string, done: () => boolean, label: string) =>
      pressUntil(s => stdin.write(s), sequence, done, label),
    selected,
    cancelled: () => cancelled,
    unmount: () => root.unmount(),
  }
}

describe('SessionsScreen', () => {
  test('a session another claudin holds is not resumed; the screen says where it is', async () => {
    const held: LiveSession = { sessionId: 'held', pid: 4242, cwd: '/elsewhere' }
    const screen = await mount({
      logs: [log('cur', 0, 'This one'), log('held', 5, 'Held elsewhere')],
      loadLiveSessions: async () => [held],
    })
    try {
      await screen.press(
        ENTER,
        () => screen.frame().includes('Open in another claudin (pid 4242, /elsewhere)'),
        'the elsewhere notice',
      )
      expect(screen.selected).toEqual([])
    } finally {
      screen.unmount()
    }
  }, 30_000)

  test('switching away from running work asks first, then switches on Enter', async () => {
    const other = log('other', 5, 'Another session')
    const screen = await mount({
      logs: [log('cur', 0, 'This one'), other],
      getRunningWork: () => 'the running turn',
    })
    try {
      await screen.press(
        ENTER,
        () => screen.frame().includes('Switching stops the running turn'),
        'the confirmation',
      )
      expect(screen.selected).toEqual([])
      await screen.press(ENTER, () => screen.selected.length > 0, 'the switch')
      expect(screen.selected).toEqual([other])
    } finally {
      screen.unmount()
    }
  }, 30_000)

  test('with nothing running, Enter switches at once; Enter on this session closes', async () => {
    const other = log('other', 5, 'Another session')
    const screen = await mount({ logs: [log('cur', 0, 'This one'), other] })
    try {
      await screen.press(ENTER, () => screen.selected.length > 0, 'the switch')
      expect(screen.selected).toEqual([other])
    } finally {
      screen.unmount()
    }

    const alone = await mount({ logs: [log('cur', 0, 'This one')] })
    try {
      await alone.press(ENTER, () => alone.cancelled() > 0, 'the close')
      expect(alone.selected).toEqual([])
    } finally {
      alone.unmount()
    }
  }, 30_000)
})
