import { PassThrough } from 'node:stream'

import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import stripAnsi from 'strip-ansi'

import { createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

// Capture the real claudinMigration module before installing the partial
// mock so afterAll can restore it cleanly. Bun's mock.module is process-global
// and shape-locked — without restore, this file's mocks leak into every later
// test that imports the same specifier (CLAUDE.md mock.module pitfalls).
const realMigration = { ...(await import('src/platform/config/claudinMigration.js')) }

const markMigrationSkippedSpy = mock(() => {})
const migrateLegacyClaudeDirSpy = mock(async () => ({
  tokens: 1,
  settingsKeys: 0,
  globalConfigKeys: 0,
  anthropicProfileCreated: false,
  errors: [] as string[],
  warnings: [] as string[],
  alreadyMigrated: false,
  legacyDir: '/tmp/.claude',
  newDir: '/tmp/.claudin',
  migratedAt: '2026-04-29T00:00:00Z',
}))

mock.module('src/platform/config/claudinMigration.js', () => ({
  ...realMigration,
  markMigrationSkipped: markMigrationSkippedSpy,
  migrateLegacyClaudeDir: migrateLegacyClaudeDirSpy,
  formatMigrationReport: () => 'mocked summary',
}))

afterAll(() => {
  mock.module('src/platform/config/claudinMigration.js', () => realMigration)
})

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }
  return lastFrame ?? output
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
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
  return { stdout, stdin, getOutput: () => output }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for MigrationBanner test condition')
}

async function waitForFrame(
  getOutput: () => string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  let frame = ''
  await waitForCondition(() => {
    frame = stripAnsi(extractLastFrame(getOutput()))
    return predicate(frame)
  })
  return frame
}

beforeEach(() => {
  markMigrationSkippedSpy.mockClear()
  migrateLegacyClaudeDirSpy.mockClear()
})

afterEach(async () => {
  await Bun.sleep(0)
})

test("calls onDismiss with 'skipped' when user picks Skip — start fresh", async () => {
  const { MigrationBanner } = await import('src/platform/MigrationBanner.js')
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  const outcomes: string[] = []
  root.render(
    <AppStateProvider>
      <KeybindingSetup>
        <MigrationBanner
          enabled={true}
          onDismiss={outcome => outcomes.push(outcome)}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )

  try {
    await waitForFrame(getOutput, frame =>
      frame.includes('Found Claude Code config'),
    )

    // Move focus to the Skip option and submit.
    stdin.write('j')
    await Bun.sleep(20)
    stdin.write('\r')

    await waitForCondition(() => outcomes.length > 0)
    expect(outcomes).toEqual(['skipped'])
    expect(markMigrationSkippedSpy).toHaveBeenCalledTimes(1)
    expect(migrateLegacyClaudeDirSpy).not.toHaveBeenCalled()
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})

test("calls onDismiss with 'migrated' after successful migration", async () => {
  const { MigrationBanner } = await import('src/platform/MigrationBanner.js')
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  const outcomes: string[] = []
  root.render(
    <AppStateProvider>
      <KeybindingSetup>
        <MigrationBanner
          enabled={true}
          onDismiss={outcome => outcomes.push(outcome)}
        />
      </KeybindingSetup>
    </AppStateProvider>,
  )

  try {
    await waitForFrame(getOutput, frame =>
      frame.includes('Found Claude Code config'),
    )

    // First option ("Copy my sign-in") is focused on mount; just press Enter.
    stdin.write('\r')

    await waitForCondition(() => outcomes.length > 0)
    expect(outcomes).toEqual(['migrated'])
    expect(migrateLegacyClaudeDirSpy).toHaveBeenCalledTimes(1)
    expect(markMigrationSkippedSpy).not.toHaveBeenCalled()
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})
