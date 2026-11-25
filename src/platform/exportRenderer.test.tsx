import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { z } from 'zod/v4'
import { createAssistantMessage } from 'src/agent/messages/factories.js'
import { renderMessagesToPlainText, streamRenderedMessages } from 'src/platform/exportRenderer.js'
import type { Tool, Tools } from 'src/tools/Tool.js'

// /export and the ctrl+e transcript write text an editor opens, with no reason
// to have a Nerd Font; the `[` dump goes back to this terminal, which has one.

// Every Nerd Font codepoint lives in a Private Use Area.
const PUA_RE = /[\u{e000}-\u{f8ff}\u{f0000}-\u{ffffd}]/u

const BASH = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  userFacingName: () => 'Bash',
  renderToolUseMessage: (input: { command: string }) => input.command,
} as unknown as Tool

const messages = [
  createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }] as never }),
]

// The logo header's status notices ask for an Anthropic credential and throw
// under test without one; a placeholder token keeps them quiet.
const ENV = { CLAUDIN_NERD_FONT: '1', CLAUDE_CODE_OAUTH_TOKEN: 'placeholder-token' }
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
})
afterEach(() => {
  for (const key of Object.keys(ENV)) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('exported transcripts', () => {
  test('the plain-text export draws its tool rows without Nerd Font icons', async () => {
    const text = await renderMessagesToPlainText(messages, [BASH] as Tools)
    expect(text).toContain('Bash(ls -la)')
    expect(text).not.toMatch(PUA_RE)
  })

  test('the scrollback dump keeps them', async () => {
    let ansi = ''
    await streamRenderedMessages(messages, [BASH] as Tools, chunk => {
      ansi += chunk
    })
    expect(stripAnsi(ansi)).toContain('Bash(ls -la)')
    expect(stripAnsi(ansi)).toMatch(PUA_RE)
  })
})
