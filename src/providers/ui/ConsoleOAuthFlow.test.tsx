import { PassThrough } from 'node:stream'

import { expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { Box, createRoot } from 'src/terminal/ink.js'
import { KeybindingSetup } from 'src/terminal/keybindings/KeybindingProviderSetup.js'
import { ConsoleOAuthFlow, SignInUrl } from 'src/providers/ui/ConsoleOAuthFlow.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) {
      break
    }

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) {
      break
    }

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) {
      lastFrame = frame
    }
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

  return {
    stdout,
    stdin,
    getOutput: () => output,
  }
}

async function renderFrame(node: React.ReactNode): Promise<string> {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>,
  )

  await Bun.sleep(50)
  root.unmount()
  stdin.end()
  stdout.end()
  await Bun.sleep(25)

  return stripAnsi(extractLastFrame(getOutput()))
}

test('login picker offers Anthropic-only options (third-party flow lives in /provider)', async () => {
  const output = await renderFrame(<ConsoleOAuthFlow onDone={() => {}} />)

  expect(output).toContain('Select login method:')
  expect(output).toContain('Claude account with subscription')
  expect(output).toContain('Anthropic Console account')
  expect(output).not.toContain('3rd-party platform')
})

// The /provider Pane pads 2 columns. A wrapped URL that keeps that padding on
// its continuation rows reaches the browser as `…-594  4d19…` once the line
// breaks are stripped, and claude.com rejects the client_id.
test('the sign-in URL wraps from column 0 even inside a padded pane', async () => {
  const url =
    'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=JScala47j3Zn_QB8zt7e2FmJYRdD3keCyXr9VUJUuD4&code_challenge_method=S256&state=vv_CeehPRk6kYpB0nhG6gez9v5MAkTXezyL0Jsyhg4U'
  const output = await renderFrame(
    <Box flexDirection="column" paddingX={2}>
      <SignInUrl url={url} />
    </Box>,
  )

  const rows = output.split('\n').filter(row => row.trim().length > 0)
  expect(rows.length).toBeGreaterThan(1)
  for (const row of rows) expect(row).not.toMatch(/^\s/)
  expect(rows.map(row => row.trimEnd()).join('')).toBe(url)
})
