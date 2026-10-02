/**
 * Characterization of the prompt box (PromptInput.tsx), written before the
 * levers cut edits it.
 *
 * The prompt is mounted the way the REPL mounts it: real app state, real
 * keybindings, a fake TTY. Keys go in as the bytes a terminal sends. What a
 * test reads back is what a caller can observe: the frame on screen, the
 * values the host was handed (text, mode, pastes, stash, help), the
 * submissions, and the app state the prompt writes (footer selection,
 * notifications, permission mode, effort, model, thinking).
 *
 * Not pinned here, because the cut deletes them: the speculation accept and
 * abort paths and the bridge pill and dialog.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { clearCommandQueue, enqueue } from 'src/agent/messageQueueManager.js'
import { getIsInteractive, setIsInteractive } from 'src/platform/bootstrap/state.js'
import { getCurrentProjectConfig, getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import type { Command } from 'src/commands/commands.js'
import {
  clearCliTeammateModeOverride,
  getTeammateModeFromSnapshot,
} from 'src/agent/coordinator/swarm/backends/teammateModeSnapshot.js'
import { KEY, openPrompt, type Rig, useSandbox, withPrompt } from 'src/terminal/prompt-input/__testutils__/promptRig.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

const SLOW = 30_000
const sandbox = useSandbox()

afterEach(() => {
  clearCommandQueue()
})

/** The rows of the latest frame, trimmed on the right. */
function rows(rig: Rig): string[] {
  return rig
    .screen()
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(row => row.trimEnd())
}

/** The row holding the caret glyph the prompt draws before the typed text. */
function promptRow(rig: Rig): string {
  return rows(rig).find(row => /^[❯!]/.test(row)) ?? ''
}

/** Backspaces one at a time, letting each one render, the way a person clears text. */
async function eraseSlowly(rig: Rig, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    rig.terminal.type(KEY.backspace)
    await Bun.sleep(25)
  }
  await rig.settle()
}

function currentNotice(rig: Rig): { key?: string; text?: string } {
  const current = rig.state().notifications.current as { key?: string; text?: string } | null
  return current ?? {}
}

/** Writes history.jsonl the way the app appends it: oldest first, all in this project. */
function rememberPrompts(displays: string[]): void {
  const now = Date.now()
  const lines = displays.map((display, index) =>
    JSON.stringify({
      display,
      pastedContents: {},
      timestamp: now - (displays.length - index) * 60_000,
      project: sandbox().projectDir,
      sessionId: '0c7d1e2a-5b6c-4d7e-8f90-a1b2c3d4e5f6',
    }),
  )
  writeFileSync(join(sandbox().configDir, 'history.jsonl'), `${lines.join('\n')}\n`)
}

/** A one-pixel PNG. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

// --- background work the footer shows ------------------------------------------------

type Tasks = AppState['tasks']

function panelAgent(id: string, status: 'running' | 'completed', startedAgo: number): Tasks[string] {
  return {
    id,
    type: 'local_agent',
    status,
    description: `look into ${id}`,
    agentType: 'general-purpose',
    prompt: 'look around',
    startTime: Date.now() - startedAgo,
    outputFile: '/dev/null',
    outputOffset: 0,
    notified: false,
    isBackgrounded: true,
    pendingMessages: [],
    retrieved: false,
  } as unknown as Tasks[string]
}

function databaseContainer(id: string): Tasks[string] {
  return {
    id,
    type: 'container',
    status: 'running',
    description: 'database',
    container: {
      id: 'f00d',
      name: 'orders-db-1',
      image: 'postgres:16',
      state: 'running',
      status: 'Up 5 minutes',
      health: 'none',
      exitCode: null,
      ports: [],
      project: 'orders',
      service: 'db',
      workingDir: '/srv/orders',
      createdAt: 1,
    },
    startedByUs: false,
    restartCount: 0,
    lastNotifiedSignature: null,
    diedAt: null,
    startTime: Date.now() - 1_000,
    outputFile: '/dev/null',
    outputOffset: 0,
    notified: false,
  } as unknown as Tasks[string]
}

function connectedServer(id: string): Tasks[string] {
  return {
    id,
    type: 'mcp_server',
    status: 'running',
    description: 'docs server',
    serverName: 'docs',
    connectionType: 'connected',
    transport: 'stdio',
    scope: 'local',
    toolCount: 3,
    resourceCount: 0,
    serverInfo: { name: 'Docs', version: '1.0.0' },
    error: null,
    startTime: Date.now() - 1_000,
    outputFile: '/dev/null',
    outputOffset: 0,
    notified: false,
  } as unknown as Tasks[string]
}

function teammate(id: string, name: string): Tasks[string] {
  return {
    id,
    type: 'in_process_teammate',
    status: 'running',
    description: `${name} works`,
    identity: {
      agentId: `${name}@crew`,
      agentName: name,
      teamName: 'crew',
      color: 'green',
      planModeRequired: false,
      parentSessionId: 'lead-session',
    },
    prompt: 'help out',
    // Working, in the default permission mode, with nothing waiting on it.
    ...{ isIdle: false, permissionMode: 'default', shutdownRequested: false, awaitingPlanApproval: false },
    messages: [],
    pendingUserMessages: [],
    startTime: Date.now() - 2_000,
    outputFile: '/dev/null',
    outputOffset: 0,
    notified: false,
  } as unknown as Tasks[string]
}

// =====================================================================================
// Typing, modes, help
// =====================================================================================

describe('typing and submitting', () => {
  test(
    'Enter hands the typed text, trailing whitespace dropped, to the host submit',
    async () => {
      await withPrompt({}, async rig => {
        await rig.type('fix the parser   ')
        expect(promptRow(rig)).toBe('❯ fix the parser')
        await rig.press(KEY.enter)
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['fix the parser'])
        expect(rig.ledger.submissions[0]?.options).toBeUndefined()
        expect(rig.ledger.lastHelpers).toBeDefined()
      })
    },
    SLOW,
  )

  test(
    'Enter on an empty or blank prompt submits nothing',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press(KEY.enter)
        await rig.type('   ')
        await rig.press(KEY.enter)
        expect(rig.ledger.submissions).toEqual([])
      })
    },
    SLOW,
  )

  test(
    'a mode character typed first switches the mode instead of being typed',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press('!')
        expect(rig.ledger.mode).toBe('bash')
        expect(rig.ledger.input).toBe('')
        expect(rows(rig).some(row => row.includes('bash mode'))).toBe(true)
        expect(promptRow(rig).startsWith('!')).toBe(true)
      })
    },
    SLOW,
  )

  test(
    'a burst that starts with the mode character fills an empty prompt without it',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press('!git log')
        expect(rig.ledger.mode).toBe('bash')
        expect(rig.ledger.input).toBe('git log')
      })
    },
    SLOW,
  )

  test(
    'defect: after the mode character the cursor sits past the end of the empty text',
    async () => {
      // The mode switch returns before the text changes, but the text input
      // still advances the cursor by one. So Backspace or Escape "at the
      // start" do not leave bash mode, and the next burst is typed verbatim.
      await withPrompt({}, async rig => {
        await rig.press('!')
        expect(rig.insert().cursorOffset).toBe(1)
        await rig.press(KEY.backspace, KEY.escape)
        expect(rig.ledger.mode).toBe('bash')
        await rig.press('!ls')
        expect(rig.ledger.input).toBe('!ls')
      })
    },
    SLOW,
  )

  const LEAVING_KEYS: Array<[string, string]> = [
    ['Escape', KEY.escape],
    ['Backspace', KEY.backspace],
    ['Ctrl+U', KEY.ctrlU],
  ]
  for (const [name, key] of LEAVING_KEYS) {
    test(
      `${name} with the cursor at the start returns bash mode to prompt mode`,
      async () => {
        await withPrompt({ mode: 'bash' }, async rig => {
          await rig.press(key)
          expect(rig.ledger.mode).toBe('prompt')
        })
      },
      SLOW,
    )
  }

  test(
    'a tab typed into the text arrives as four spaces',
    async () => {
      await withPrompt({ input: 'a' }, async rig => {
        rig.terminal.type('b\tc')
        await rig.settle()
        expect(rig.ledger.input).toBe('ab    c')
      })
    },
    SLOW,
  )

  const CLOSING_KEYS: Array<[string, string]> = [
    ['Escape', KEY.escape],
    ['Return', KEY.enter],
    ['Backspace', KEY.backspace],
  ]
  for (const [name, key] of CLOSING_KEYS) {
    test(
      `? on an empty prompt opens the shortcut help, and ${name} closes it`,
      async () => {
        await withPrompt({}, async rig => {
          await rig.press('?')
          expect(rig.ledger.helpOpen).toBe(true)
          expect(rig.ledger.input).toBe('')
          await rig.press(key)
          expect(rig.ledger.helpOpen).toBe(false)
          expect(rig.ledger.submissions).toEqual([])
        })
      },
      SLOW,
    )
  }

  test(
    'typing with the help open closes it and types',
    async () => {
      await withPrompt({ helpOpen: true }, async rig => {
        await rig.press('a')
        expect(rig.ledger.helpOpen).toBe(false)
        expect(rig.ledger.input).toBe('a')
      })
    },
    SLOW,
  )

  test(
    'text replaced from outside moves the cursor to its end',
    async () => {
      await withPrompt({ input: 'one' }, async rig => {
        await rig.press(KEY.left)
        expect(rig.insert().cursorOffset).toBe(2)
        rig.ledger.replaceInput?.('dictated words')
        await rig.settle()
        expect(rig.insert().cursorOffset).toBe('dictated words'.length)
      })
    },
    SLOW,
  )

  test(
    'the insert handle splices at the cursor and adds a space after a word',
    async () => {
      await withPrompt({ input: 'hello' }, async rig => {
        rig.insert().insert('world')
        await rig.settle()
        expect(rig.ledger.input).toBe('hello world')
        expect(rig.insert().cursorOffset).toBe(11)
        rig.insert().setInputWithCursor('abc def', 3)
        await rig.settle()
        expect(rig.ledger.input).toBe('abc def')
        expect(rig.insert().cursorOffset).toBe(3)
        rig.insert().insert('!')
        await rig.settle()
        expect(rig.ledger.input).toBe('abc! def')
      })
    },
    SLOW,
  )

  test(
    'Waiting for permission shows while dialogs are held back',
    async () => {
      await withPrompt({ hasSuppressedDialogs: true }, async rig => {
        expect(rig.screen()).toContain('Waiting for permission…')
      })
    },
    SLOW,
  )

  test(
    'gradually clearing a long text offers the stash shortcut once',
    async () => {
      await withPrompt({}, async rig => {
        await rig.type('a fairly long draft of a prompt')
        // 31 characters down to 5: the hint fires on the step that reaches 5.
        await eraseSlowly(rig, 26)
        await rig.until(() => currentNotice(rig).key === 'stash-hint', 'the stash hint')
        expect(rig.screen()).toContain('Tip: ctrl+s to stash')
      })
    },
    SLOW,
  )

  test(
    'no stash hint once the stash has been used, nor for a clear in one step',
    async () => {
      await withPrompt({}, async rig => {
        await rig.type('a fairly long draft of a prompt')
        await rig.press(KEY.ctrlU)
        await rig.settle()
        expect(currentNotice(rig).key).not.toBe('stash-hint')
      })
      saveGlobalConfig(c => ({ ...c, hasUsedStash: true }))
      await withPrompt({}, async rig => {
        await rig.type('a fairly long draft of a prompt')
        await eraseSlowly(rig, 26)
        expect(currentNotice(rig).key).not.toBe('stash-hint')
      })
    },
    SLOW,
  )
})

// =====================================================================================
// The stash
// =====================================================================================

describe('Ctrl+S stash', () => {
  test(
    'stashes the text, its cursor and its pastes, then restores them on an empty prompt',
    async () => {
      const paste = { 1: { id: 1, type: 'text' as const, content: 'x\ny\nz\nw' } }
      await withPrompt({ input: 'draft [Pasted text #1 +3 lines]', pasted: paste }, async rig => {
        await rig.press(KEY.ctrlS)
        expect(rig.ledger.stash).toEqual({
          text: 'draft [Pasted text #1 +3 lines]',
          cursorOffset: 31,
          pastedContents: paste,
        })
        expect(rig.ledger.input).toBe('')
        expect(rig.ledger.pasted).toEqual({})
        expect(getGlobalConfig().hasUsedStash).toBe(true)
        expect(rig.screen()).toContain('Stashed (auto-restores after submit)')

        await rig.press(KEY.ctrlS)
        expect(rig.ledger.stash).toBeUndefined()
        expect(rig.ledger.input).toBe('draft [Pasted text #1 +3 lines]')
        expect(rig.ledger.pasted).toEqual(paste)
      })
    },
    SLOW,
  )

  test(
    'does nothing on a blank prompt with nothing stashed',
    async () => {
      await withPrompt({ input: '  ' }, async rig => {
        await rig.press(KEY.ctrlS)
        expect(rig.ledger.stash).toBeUndefined()
        expect(rig.ledger.input).toBe('  ')
      })
    },
    SLOW,
  )
})

// =====================================================================================
// History and the queue
// =====================================================================================

describe('history and queued commands', () => {
  test(
    'Up walks back through earlier prompts, restoring their mode; Down walks forward',
    async () => {
      rememberPrompts(['first thing', '!make test', 'latest thing'])
      await withPrompt({}, async rig => {
        await rig.press(KEY.up)
        expect([rig.ledger.mode, rig.ledger.input]).toEqual(['prompt', 'latest thing'])
        await rig.press(KEY.up)
        expect([rig.ledger.mode, rig.ledger.input]).toEqual(['bash', 'make test'])
        await rig.press(KEY.down)
        await rig.press(KEY.down)
        expect([rig.ledger.mode, rig.ledger.input]).toEqual(['prompt', 'latest thing'])
      })
    },
    SLOW,
  )

  test(
    'Up and Escape pull editable queued commands back into the prompt',
    async () => {
      for (const key of [KEY.up, KEY.escape]) {
        enqueue({ value: 'queued follow-up', mode: 'prompt' })
        enqueue({ value: 'second one', mode: 'prompt' })
        await withPrompt({}, async rig => {
          await rig.press(key)
          expect(rig.ledger.input).toBe('queued follow-up\nsecond one')
          expect(rig.ledger.mode).toBe('prompt')
          expect(rig.insert().cursorOffset).toBe('queued follow-up\nsecond one'.length + 1)
        })
        clearCommandQueue()
      }
    },
    SLOW,
  )

  test(
    'queued images come back into the pastes',
    async () => {
      const image = { id: 9, type: 'image' as const, content: PIXEL_PNG.toString('base64'), mediaType: 'image/png' }
      enqueue({ value: 'look [Image #9]', mode: 'prompt', pastedContents: { 9: image } })
      await withPrompt({}, async rig => {
        await rig.press(KEY.up)
        expect(rig.ledger.input).toBe('look [Image #9]')
        expect(rig.ledger.pasted[9]).toEqual(image)
      })
    },
    SLOW,
  )

  test(
    'Down past the newest prompt steps into the footer, and the tasks hint is marked seen',
    async () => {
      saveGlobalConfig(c => ({ ...c, hasSeenTasksHint: false }))
      await withPrompt({ appState: { tasks: { a1: panelAgent('a1', 'running', 1_000) } } }, async rig => {
        await rig.press(KEY.down)
        expect(rig.state().footerSelection).toBe('tasks')
        expect(getGlobalConfig().hasSeenTasksHint).toBe(true)
        // Typing a printable character leaves the footer and types it.
        await rig.press('w')
        expect(rig.state().footerSelection).toBeNull()
        expect(rig.ledger.input).toBe('w')
      })
    },
    SLOW,
  )

  test(
    'Down with no footer pill leaves the selection empty',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press(KEY.down)
        expect(rig.state().footerSelection).toBeNull()
      })
    },
    SLOW,
  )
})

// =====================================================================================
// Pastes
// =====================================================================================

describe('pasting', () => {
  test(
    'a paste longer than the prompt shows becomes a numbered reference',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press(KEY.paste('one\r\ntwo\tcol\nthree\nfour'))
        await rig.until(() => rig.ledger.input !== '', 'the paste to land')
        expect(rig.ledger.input).toBe('[Pasted text #1 +4 lines]')
        expect(rig.ledger.pasted).toEqual({
          1: { id: 1, type: 'text', content: 'one\n\ntwo    col\nthree\nfour' },
        })
      })
    },
    SLOW,
  )

  test(
    'reference numbers continue after the ones already in the conversation',
    async () => {
      const messages = [
        createUserMessage({ content: 'see [Pasted text #4 +9 lines]' }),
        createUserMessage({ content: [{ type: 'text', text: 'and [Image #2]' }], imagePasteIds: [6] }),
        createAssistantMessage({ content: 'noted [Pasted text #40]' }),
      ]
      await withPrompt({ messages }, async rig => {
        await rig.press(KEY.paste('a\nb\nc\nd'))
        await rig.until(() => rig.ledger.input !== '', 'the paste to land')
        expect(rig.ledger.input).toBe('[Pasted text #7 +3 lines]')
      })
    },
    SLOW,
  )

  test(
    'a short paste is typed in place, tabs widened to four spaces',
    async () => {
      await withPrompt({ input: 'say ' }, async rig => {
        await rig.press(KEY.paste('hi\tthere'))
        await rig.until(() => rig.ledger.input !== 'say ', 'the paste to land')
        expect(rig.ledger.input).toBe('say hi    there')
        expect(rig.ledger.pasted).toEqual({})
      })
    },
    SLOW,
  )

  test(
    'a pasted bash command on an empty prompt enters bash mode',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press(KEY.paste('!git status'))
        await rig.until(() => rig.ledger.input !== '', 'the paste to land')
        expect(rig.ledger.mode).toBe('bash')
        expect(rig.ledger.input).toBe('git status')
      })
    },
    SLOW,
  )

  test(
    'a dragged-in file becomes an @-mention, quoted when its path has a space',
    async () => {
      const plain = join(sandbox().projectDir, 'notes.md')
      const spaced = join(sandbox().projectDir, 'my notes.md')
      writeFileSync(plain, 'notes')
      writeFileSync(spaced, 'notes')
      await withPrompt({ input: 'read' }, async rig => {
        await rig.press(KEY.paste(plain))
        await rig.until(() => rig.ledger.input !== 'read', 'the first mention')
        expect(rig.ledger.input).toBe(`read @${plain} `)
        await rig.press(KEY.paste(spaced))
        await rig.until(() => rig.ledger.input.includes('my notes'), 'the second mention')
        expect(rig.ledger.input).toBe(`read @${plain} @"${spaced}" `)
      })
    },
    SLOW,
  )

  test(
    'a dragged-in image becomes an [Image #N] chip; the next character gets a space before it',
    async () => {
      const shot = join(sandbox().projectDir, 'shot.png')
      writeFileSync(shot, PIXEL_PNG)
      await withPrompt({}, async rig => {
        await rig.press(KEY.paste(shot))
        await rig.until(() => rig.ledger.input !== '', 'the image to land')
        expect(rig.ledger.input).toBe('[Image #1]')
        const image = rig.ledger.pasted[1] as { type: string; filename?: string; mediaType?: string; sourcePath?: string }
        expect([image.type, image.filename, image.mediaType, image.sourcePath]).toEqual([
          'image',
          'shot.png',
          'image/png',
          shot,
        ])
        await rig.press('x')
        expect(rig.ledger.input).toBe('[Image #1] x')
        await rig.press(' ')
        expect(rig.ledger.input).toBe('[Image #1] x ')
      })
    },
    SLOW,
  )

  test(
    'a space typed after the chip is not doubled',
    async () => {
      const shot = join(sandbox().projectDir, 'shot.png')
      writeFileSync(shot, PIXEL_PNG)
      await withPrompt({}, async rig => {
        await rig.press(KEY.paste(shot))
        await rig.until(() => rig.ledger.input !== '', 'the image to land')
        await rig.press(' ')
        expect(rig.ledger.input).toBe('[Image #1] ')
      })
    },
    SLOW,
  )

  test(
    'an image whose chip leaves the text is dropped from the pastes',
    async () => {
      const image = { id: 3, type: 'image' as const, content: 'AAAA', mediaType: 'image/png' }
      const kept = { id: 4, type: 'text' as const, content: 'kept' }
      await withPrompt({ input: 'no chip here', pasted: { 3: image, 4: kept } }, async rig => {
        await rig.until(() => !(3 in rig.ledger.pasted), 'the orphan image to go')
        expect(rig.ledger.pasted).toEqual({ 4: kept })
      })
    },
    SLOW,
  )

  test(
    'Ctrl+V with no image on the clipboard says so',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press('\x16')
        await rig.until(() => currentNotice(rig).key === 'no-image-in-clipboard', 'the clipboard notice')
        expect(currentNotice(rig).text).toBe('No image found in clipboard. Use ctrl+v to paste images.')
        expect(rig.ledger.input).toBe('')
      })
    },
    SLOW,
  )
})

// =====================================================================================
// Shortcuts that act on the prompt or open something
// =====================================================================================

describe('shortcuts', () => {
  test(
    'Ctrl+G with no side panel submits /diff and clears the prompt',
    async () => {
      await withPrompt({ input: 'stray' }, async rig => {
        await rig.press(KEY.ctrlG)
        await rig.until(() => rig.ledger.submissions.length > 0, 'the /diff submission')
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['/diff'])
        expect(rig.ledger.input).toBe('')
      })
    },
    SLOW,
  )

  test(
    'Ctrl+E submits /explorer and clears the prompt',
    async () => {
      await withPrompt({ input: 'stray' }, async rig => {
        await rig.press('\x05')
        await rig.until(() => rig.ledger.submissions.length > 0, 'the /explorer submission')
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['/explorer'])
        expect(rig.ledger.input).toBe('')
      })
    },
    SLOW,
  )

  test(
    'Left on an empty prompt opens the session list through the keybinding path',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press(KEY.left)
        expect(rig.ledger.submissions).toEqual([{ text: '/resume', options: { fromKeybinding: true }, speculation: false }])
      })
      await withPrompt({ input: 'ab' }, async rig => {
        await rig.press(KEY.left)
        expect(rig.ledger.submissions).toEqual([])
        expect(rig.insert().cursorOffset).toBe(1)
      })
    },
    SLOW,
  )

  test(
    'Ctrl+C on an empty prompt asks for a second press',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press(KEY.ctrlC)
        expect(rig.screen()).toContain('Press Ctrl-C again to exit')
        await rig.press(KEY.ctrlC)
        expect(rig.ledger.exits).toBe(1)
      })
    },
    SLOW,
  )

  test(
    'Escape twice on an empty prompt opens the message selector once there is a conversation',
    async () => {
      const messages = [createUserMessage({ content: 'hi' }), createAssistantMessage({ content: 'hello' })]
      await withPrompt({ messages }, async rig => {
        await rig.press(KEY.escape, KEY.escape)
        expect(rig.ledger.messageSelectorOpened).toBe(1)
      })
      await withPrompt({}, async rig => {
        await rig.press(KEY.escape, KEY.escape)
        expect(rig.ledger.messageSelectorOpened).toBe(0)
      })
      await withPrompt({ messages, isLoading: true }, async rig => {
        await rig.press(KEY.escape, KEY.escape)
        expect(rig.ledger.messageSelectorOpened).toBe(0)
      })
    },
    SLOW,
  )

  test(
    'Escape dismisses a visible side answer before anything else',
    async () => {
      const messages = [createUserMessage({ content: 'hi' }), createAssistantMessage({ content: 'hello' })]
      await withPrompt({ sideQuestionVisible: true, messages }, async rig => {
        await rig.press(KEY.escape, KEY.escape)
        expect(rig.sideQuestionDismissals()).toBe(1)
        expect(rig.ledger.messageSelectorOpened).toBe(0)
      })
    },
    SLOW,
  )

  test(
    'defect: Ctrl+_ goes back to the text before the previous edit, skipping the latest',
    async () => {
      // Edits a second apart each leave a snapshot of the text before them.
      // Undo steps one snapshot back from the newest, so the text from just
      // before the latest edit is never offered.
      await withPrompt({}, async rig => {
        // Pasted, so each edit is a single change of the text.
        await rig.press(KEY.paste('one'))
        await Bun.sleep(1_100)
        await rig.press(KEY.paste(' two'))
        await Bun.sleep(1_100)
        expect(rig.ledger.input).toBe('one two')
        await rig.press(KEY.ctrlU)
        expect(rig.ledger.input).toBe('')
        await rig.press(KEY.ctrlUnderscore)
        expect(rig.ledger.input).toBe('one')
        expect(rig.insert().cursorOffset).toBe(3)
        await rig.press(KEY.ctrlUnderscore)
        expect(rig.ledger.input).toBe('')
        await rig.press(KEY.ctrlUnderscore)
        expect(rig.ledger.input).toBe('')
      })
    },
    SLOW,
  )

  test(
    'the external editor reports a failure as a notice and leaves the text alone',
    async () => {
      // Under test the renderer is not on process.stdout, so the editor cannot
      // take the terminal over; that is the failure path a user also sees
      // when the handoff throws.
      process.env.EDITOR = 'true'
      await withPrompt({ input: 'keep me' }, async rig => {
        await rig.press('\x18')
        await rig.press('\x05')
        await rig.until(() => currentNotice(rig).key === 'external-editor-error', 'the editor notice')
        expect(currentNotice(rig).text).toBe('External editor failed: Ink instance not found - cannot pause rendering')
        expect(rig.ledger.input).toBe('keep me')
      })
    },
    SLOW,
  )
})

// =====================================================================================
// Pickers opened from the prompt
// =====================================================================================

describe('pickers', () => {
  test(
    'Meta+P opens the model picker; choosing sets the session model and announces it',
    async () => {
      await withPrompt({ helpOpen: true }, async rig => {
        await rig.press(KEY.metaP)
        expect(rig.screen()).toContain('Select model')
        expect(rig.ledger.helpOpen).toBe(false)
        await rig.press(KEY.down, KEY.enter)
        await rig.until(() => !rig.screen().includes('Select model'), 'the picker to close')
        expect(rig.state().mainLoopModel).toBe('sonnet')
        expect(rig.state().mainLoopModelForSession).toBeNull()
        expect(currentNotice(rig).key).toBe('model-switched')
        expect(rig.screen()).toContain('Model set to sonnet (claude-sonnet-5-5)')
      })
    },
    SLOW,
  )

  test(
    'Escape closes the model picker without a change',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press(KEY.metaP)
        await rig.press(KEY.escape)
        expect(rig.screen()).not.toContain('Select model')
        expect(rig.state().mainLoopModel).toBeNull()
      })
    },
    SLOW,
  )

  test(
    'Meta+T opens the thinking toggle; choosing writes it and announces it',
    async () => {
      await withPrompt({ helpOpen: true }, async rig => {
        await rig.press(KEY.metaT)
        expect(rig.screen()).toContain('Toggle thinking mode')
        expect(rig.ledger.helpOpen).toBe(false)
        await rig.press(KEY.down, KEY.enter)
        expect(rig.state().thinkingEnabled).toBe(false)
        expect(rig.screen()).toContain('Thinking off')
        await rig.press(KEY.metaT, KEY.up, KEY.enter)
        expect(rig.state().thinkingEnabled).toBe(true)
        expect(rig.screen()).toContain('Thinking on')
        await rig.press(KEY.metaT, KEY.escape)
        expect(rig.screen()).not.toContain('Toggle thinking mode')
      })
    },
    SLOW,
  )
})

// =====================================================================================
// Permission mode and effort
// =====================================================================================

describe('Shift+Tab cycles the permission mode', () => {
  test(
    'default → accept edits → plan → default, telling both the host and app state',
    async () => {
      const before = Date.now()
      await withPrompt({ helpOpen: true }, async rig => {
        await rig.press(KEY.shiftTab)
        expect(rig.state().toolPermissionContext.mode).toBe('acceptEdits')
        expect(rig.ledger.helpOpen).toBe(false)
        await rig.press(KEY.shiftTab)
        expect(rig.state().toolPermissionContext.mode).toBe('plan')
        expect(getGlobalConfig().lastPlanModeUse ?? 0).toBeGreaterThanOrEqual(before)
        await rig.press(KEY.shiftTab)
        expect(rig.state().toolPermissionContext.mode).toBe('default')
        expect(rig.ledger.permissionContexts.map(c => c.mode)).toEqual(['acceptEdits', 'plan', 'default'])
      })
    },
    SLOW,
  )
})

describe('Shift+Right and Shift+Left step the effort', () => {
  test(
    'each step lands in app state and is pinned for the project',
    async () => {
      await withPrompt({}, async rig => {
        await rig.press('\x1b[1;2C')
        expect(rig.state().effortValue).toBe('high')
        expect(getCurrentProjectConfig().activeEffortForProject).toBe('high')
        await rig.press('\x1b[1;2D', '\x1b[1;2D')
        expect(rig.state().effortValue).toBe('low')
        expect(getCurrentProjectConfig().activeEffortForProject).toBe('low')
      })
    },
    SLOW,
  )

  test(
    'with CLAUDIN_EFFORT_LEVEL set to another level, the step warns that the variable wins',
    async () => {
      process.env.CLAUDIN_EFFORT_LEVEL = 'low'
      await withPrompt({}, async rig => {
        await rig.press('\x1b[1;2C')
        await rig.until(() => currentNotice(rig).key === 'effort-env-override', 'the override warning')
        expect(rig.screen()).toContain('CLAUDIN_EFFORT_LEVEL=low overrides effort this session')
      })
    },
    SLOW,
  )
})

// =====================================================================================
// The prompt suggestion
// =====================================================================================

describe('the prompt suggestion', () => {
  const offered = (text: string, shownAt = 0): Partial<AppState> =>
    ({
      promptSuggestion: { text, promptId: 'user_intent', shownAt, acceptedAt: 0, generationRequestId: null },
    }) as Partial<AppState>

  test(
    'shows as ghost text on an empty prompt and is marked shown',
    async () => {
      await withPrompt({ appState: offered('run the tests') }, async rig => {
        expect(promptRow(rig)).toBe('❯ run the tests')
        expect(rig.state().promptSuggestion.shownAt).toBeGreaterThan(0)
      })
    },
    SLOW,
  )

  test(
    'Enter on an empty prompt submits the suggestion and clears it',
    async () => {
      await withPrompt({ appState: offered('run the tests') }, async rig => {
        await rig.press(KEY.enter)
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['run the tests'])
        expect(rig.state().promptSuggestion.text).toBeNull()
      })
    },
    SLOW,
  )

  test(
    'Enter on a typed prefix of the suggestion submits the whole suggestion',
    async () => {
      await withPrompt({ appState: offered('Commit this') }, async rig => {
        await rig.type('comm')
        await rig.press(KEY.enter)
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['Commit this'])
      })
    },
    SLOW,
  )

  test(
    'text that does not match is submitted as typed, and the suggestion is retired',
    async () => {
      await withPrompt({ appState: offered('commit this') }, async rig => {
        await rig.type('push it')
        await rig.press(KEY.enter)
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['push it'])
        expect(rig.state().promptSuggestion.text).toBeNull()
      })
    },
    SLOW,
  )

  test(
    'a suggestion that arrives while text is already typed is dropped unseen',
    async () => {
      await withPrompt({ input: 'already typing', appState: offered('push it') }, async rig => {
        await rig.until(() => rig.state().promptSuggestion.text === null, 'the suggestion to be dropped')
        expect(rig.state().promptSuggestion.shownAt).toBe(0)
      })
    },
    SLOW,
  )

  test(
    'with an image attached, Enter on an empty prompt does not take the suggestion',
    async () => {
      const image = { id: 1, type: 'image' as const, content: 'AAAA', mediaType: 'image/png' }
      await withPrompt({ input: '[Image #1]', pasted: { 1: image }, appState: offered('[image #1] explain') }, async rig => {
        await rig.press(KEY.enter)
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['[Image #1]'])
      })
    },
    SLOW,
  )
})

// =====================================================================================
// Slash commands
// =====================================================================================

describe('slash commands', () => {
  const review = {
    type: 'prompt',
    name: 'review',
    description: 'Review the current change',
    isEnabled: () => true,
    isHidden: false,
    progressMessage: 'reviewing',
    contentLength: 0,
    source: 'builtin',
    userFacingName: () => 'review',
    getPromptForCommand: async () => [],
  } as unknown as Command

  test(
    'while the command list is open, Enter completes the command rather than submitting the text',
    async () => {
      await withPrompt({ commands: [review] }, async rig => {
        await rig.type('/rev')
        expect(rig.screen()).toContain('/review')
        await rig.press(KEY.enter)
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['/review'])
      })
    },
    SLOW,
  )
})

// =====================================================================================
// The footer pills
// =====================================================================================

describe('the tasks pill', () => {
  const work = (): Partial<AppState> =>
    ({
      tasks: {
        a1: panelAgent('a1', 'completed', 4_000),
        a2: panelAgent('a2', 'running', 2_000),
        k1: databaseContainer('k1'),
      },
    }) as Partial<AppState>

  test(
    'Down selects the pill; Down again opens the collapsed panel; Down walks the rows; Up walks back',
    async () => {
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down)
        expect([rig.state().footerSelection, rig.state().footerTasksCollapsed]).toEqual(['tasks', true])
        await rig.press(KEY.down)
        expect(rig.state().footerTasksCollapsed).toBe(false)
        const walk: number[] = []
        for (let i = 0; i < 5; i++) {
          await rig.press(KEY.down)
          walk.push(rig.state().coordinatorTaskIndex)
        }
        // summary 0, agents 1-2, the containers header 3, the container 4.
        expect(walk.slice(0, 4)).toEqual([1, 2, 3, 4])
        expect(rig.ledger.bashesDialog).toBe(true)
        expect(rig.state().footerSelection).toBeNull()
      })
    },
    SLOW,
  )

  test(
    'Up from the summary row leaves the footer',
    async () => {
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down, KEY.down, KEY.down)
        expect(rig.state().coordinatorTaskIndex).toBe(1)
        await rig.press(KEY.up)
        expect(rig.state().coordinatorTaskIndex).toBe(0)
        // A container is a background task with a pill of its own above the summary.
        await rig.press(KEY.up)
        expect(rig.state().coordinatorTaskIndex).toBe(-1)
        expect(rig.state().footerSelection).toBe('tasks')
        await rig.press(KEY.up)
        expect(rig.state().footerSelection).toBeNull()
      })
    },
    SLOW,
  )

  test(
    'Enter on the summary row folds the panel open and shut; Escape clears the selection',
    async () => {
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down, KEY.enter)
        expect(rig.state().footerTasksCollapsed).toBe(false)
        await rig.press(KEY.enter)
        expect(rig.state().footerTasksCollapsed).toBe(true)
        expect(rig.ledger.submissions).toEqual([])
        await rig.press(KEY.escape)
        expect(rig.state().footerSelection).toBeNull()
      })
    },
    SLOW,
  )

  test(
    'Enter on an agent row views that agent; x on a finished one dismisses it',
    async () => {
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down, KEY.down, KEY.down)
        await rig.press(KEY.enter)
        expect(rig.state().viewingAgentTaskId).toBe('a1')
        expect(rig.state().viewSelectionMode).toBe('viewing-agent')
      })
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down, KEY.down, KEY.down)
        await rig.press('x')
        expect((rig.state().tasks.a1 as { evictAfter?: number }).evictAfter).toBe(0)
        expect(rig.ledger.input).toBe('')
      })
    },
    SLOW,
  )

  test(
    'x on the agent being viewed types into the prompt instead',
    async () => {
      const state = { ...work(), viewingAgentTaskId: 'a1', viewSelectionMode: 'viewing-agent' } as Partial<AppState>
      await withPrompt({ appState: state }, async rig => {
        await rig.press(KEY.down)
        rig.store.setState(prev => ({ ...prev, coordinatorTaskIndex: 1 }))
        await rig.settle()
        await rig.press('x')
        expect(rig.ledger.input).toBe('x')
      })
    },
    SLOW,
  )

  test(
    'Enter on a group header folds that group; x on a header is swallowed',
    async () => {
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down, KEY.down)
        for (let i = 0; i < 3; i++) await rig.press(KEY.down)
        expect(rig.state().coordinatorTaskIndex).toBe(3)
        await rig.press(KEY.enter)
        expect(rig.state().collapsedTaskGroups).toEqual(['containers'])
        await rig.press(KEY.enter)
        expect(rig.state().collapsedTaskGroups).toEqual([])
        await rig.press('x')
        expect(rig.ledger.input).toBe('')
      })
    },
    SLOW,
  )

  test(
    'x on a container row asks for confirmation instead of stopping it',
    async () => {
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down, KEY.down)
        for (let i = 0; i < 4; i++) await rig.press(KEY.down)
        expect(rig.state().coordinatorTaskIndex).toBe(4)
        await rig.press('x')
        expect(rig.state().pendingContainerStop).toEqual({ taskId: 'k1', name: 'db-1', startedByUs: false })
        expect(rig.screen()).toContain('db-1')
        expect(promptRow(rig)).toBe('')
      })
    },
    SLOW,
  )

  test(
    'Enter on a task row opens the background tasks dialog',
    async () => {
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down, KEY.down)
        for (let i = 0; i < 4; i++) await rig.press(KEY.down)
        rig.store.setState(prev => ({ ...prev, footerSelection: 'tasks' }))
        await rig.settle()
        await rig.press(KEY.enter)
        expect(rig.ledger.bashesDialog).toBe(true)
      })
    },
    SLOW,
  )

  test(
    'a dialog that throws while rendering is closed, and the prompt comes back with a notice',
    async () => {
      // The rig mounts no MCP connection manager, so the disconnect
      // confirmation throws on its first render, as any dialog bug would.
      const state = {
        tasks: { p1: connectedServer('p1') },
        pendingMcpDisconnect: { taskId: 'p1', serverName: 'docs', toolCount: 3 },
      } as Partial<AppState>
      await withPrompt({ appState: state }, async rig => {
        await rig.until(() => rig.state().pendingMcpDisconnect === null, 'the dialog to close')
        await rig.until(() => currentNotice(rig).key === 'dialog-crashed', 'the crash notice')
        expect(rig.screen()).toContain('Disconnect MCP server closed after an internal error — see the debug log')
        expect(promptRow(rig)).toBe('❯')
      })
    },
    SLOW,
  )

  test(
    'x on the collapsed summary falls through and types',
    async () => {
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down)
        await rig.press('x')
        expect(rig.ledger.input).toBe('x')
        expect(rig.state().footerSelection).toBeNull()
      })
    },
    SLOW,
  )

  test(
    'Enter while a teammate is being picked does nothing',
    async () => {
      await withPrompt({ appState: { ...work(), viewSelectionMode: 'selecting-agent' } as Partial<AppState> }, async rig => {
        await rig.press(KEY.down, KEY.enter)
        expect(rig.state().footerTasksCollapsed).toBe(true)
        expect(rig.ledger.submissions).toEqual([])
      })
    },
    SLOW,
  )

  test(
    'a selection whose pill disappears is cleared',
    async () => {
      await withPrompt({ appState: work() }, async rig => {
        await rig.press(KEY.down)
        expect(rig.state().footerSelection).toBe('tasks')
        rig.store.setState(prev => ({ ...prev, tasks: {} }))
        await rig.until(() => rig.state().footerSelection === null, 'the stale selection to clear')
      })
    },
    SLOW,
  )
})

describe('teammates in the footer', () => {
  test(
    'Left and Right cycle the team members; Enter views the chosen one, or the leader',
    async () => {
      const tasks = { t1: teammate('t1', 'ada'), t2: teammate('t2', 'bo') } as Tasks
      // With text in the prompt, Left belongs to the footer (see the defect below).
      await withPrompt({ input: 'hi', appState: { tasks } as Partial<AppState> }, async rig => {
        await rig.press(KEY.down)
        expect(rig.state().footerSelection).toBe('tasks')
        await rig.press(KEY.right)
        await rig.press(KEY.enter)
        expect(rig.state().viewingAgentTaskId).toBe('t1')
        await rig.press(KEY.left, KEY.left)
        await rig.press(KEY.enter)
        expect(rig.state().viewingAgentTaskId).toBe('t2')
        await rig.press(KEY.right)
        await rig.press(KEY.enter)
        expect(rig.state().viewingAgentTaskId).toBeUndefined()
        expect(rig.ledger.submissions).toEqual([])
      })
    },
    SLOW,
  )

  test(
    'defect: on an empty prompt, Left with a pill selected opens the session list instead',
    async () => {
      const tasks = { t1: teammate('t1', 'ada'), t2: teammate('t2', 'bo') } as Tasks
      await withPrompt({ appState: { tasks } as Partial<AppState> }, async rig => {
        await rig.press(KEY.down, KEY.right)
        await rig.press(KEY.left)
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['/resume'])
        await rig.press(KEY.enter)
        // The member index never moved back: Enter still views the first teammate.
        expect(rig.state().viewingAgentTaskId).toBe('t1')
      })
    },
    SLOW,
  )

  test(
    'while a teammate is viewed, input goes to it rather than to the leader',
    async () => {
      const state = { tasks: { t1: teammate('t1', 'ada') }, viewingAgentTaskId: 't1', viewSelectionMode: 'viewing-agent' }
      await withPrompt({ appState: state as Partial<AppState>, withAgentSubmit: true }, async rig => {
        await rig.type('status?')
        await rig.press(KEY.enter)
        expect(rig.ledger.agentSubmissions).toEqual([{ text: 'status?', taskId: 't1' }])
        expect(rig.ledger.submissions).toEqual([])
      })
    },
    SLOW,
  )

  test(
    'with teams on, Shift+Tab while viewing a teammate changes only the teammate mode',
    async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      const state = { tasks: { t1: teammate('t1', 'ada') }, viewingAgentTaskId: 't1', viewSelectionMode: 'viewing-agent' }
      await withPrompt({ appState: state as Partial<AppState>, helpOpen: true }, async rig => {
        await rig.press(KEY.shiftTab)
        expect((rig.state().tasks.t1 as { permissionMode: string }).permissionMode).toBe('acceptEdits')
        expect(rig.state().toolPermissionContext.mode).toBe('default')
        expect(rig.ledger.permissionContexts).toEqual([])
        expect(rig.ledger.helpOpen).toBe(false)
      })
    },
    SLOW,
  )
})

describe('teams (agent teams on)', () => {
  const crew = (): Partial<AppState> =>
    ({
      teamContext: {
        teamName: 'crew',
        teamFilePath: join(sandbox().configDir, 'teams', 'crew', 'config.json'),
        leadAgentId: 'team-lead@crew',
        teammates: {
          lead: { name: 'team-lead', agentType: 'lead', tmuxSessionName: '', tmuxPaneId: '', cwd: '/', spawnedAt: 1 },
          bo: { name: 'bo', color: 'green', agentType: 'worker', tmuxSessionName: '', tmuxPaneId: '', cwd: '/', spawnedAt: 1 },
        },
      },
    }) as Partial<AppState>

  test(
    '@name message goes straight to that member mailbox',
    async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      await withPrompt({ appState: crew() }, async rig => {
        await rig.type('@bo please rebase')
        await rig.press(KEY.enter)
        await rig.until(() => currentNotice(rig).key === 'direct-message-sent', 'the delivery notice')
        expect(rig.screen()).toContain('Sent to @bo')
        expect(rig.ledger.submissions).toEqual([])
        expect(rig.ledger.input).toBe('')
        const inbox = join(sandbox().configDir, 'teams', 'crew', 'inboxes', 'bo.json')
        expect(readFileSync(inbox, 'utf8')).toContain('please rebase')
      })
    },
    SLOW,
  )

  test(
    '@name for someone not on the team is sent as an ordinary prompt',
    async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      await withPrompt({ appState: crew() }, async rig => {
        await rig.type('@utils explain this')
        await rig.press(KEY.enter)
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['@utils explain this'])
        expect(existsSync(join(sandbox().configDir, 'teams', 'crew', 'inboxes', 'utils.json'))).toBe(false)
      })
    },
    SLOW,
  )

  test(
    'in pane mode the team is a footer pill whose Enter opens the teams dialog',
    async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
      const wasInteractive = getIsInteractive()
      const modeBefore = getTeammateModeFromSnapshot()
      setIsInteractive(true)
      clearCliTeammateModeOverride('tmux')
      try {
        await withPrompt({ appState: crew() }, async rig => {
          await rig.press(KEY.down)
          expect(rig.state().footerSelection).toBe('teams')
          await rig.press(KEY.enter)
          expect(rig.state().footerSelection).toBeNull()
          expect(promptRow(rig)).toBe('')
        })
      } finally {
        clearCliTeammateModeOverride(modeBefore)
        setIsInteractive(wasInteractive)
      }
    },
    SLOW,
  )
})

describe('the companion pill', () => {
  test(
    'with a companion hatched, its pill is reachable and Enter runs /buddy',
    async () => {
      saveGlobalConfig(c => ({ ...c, companion: { name: 'Pip', personality: 'curious', hatchedAt: 1 }, companionMuted: false }))
      await withPrompt({}, async rig => {
        await rig.press(KEY.down)
        expect(rig.state().footerSelection).toBe('companion')
        await rig.press(KEY.enter)
        await rig.until(() => rig.ledger.submissions.length > 0, 'the /buddy submission')
        expect(rig.ledger.submissions.map(s => s.text)).toEqual(['/buddy'])
        expect(rig.state().footerSelection).toBeNull()
      })
    },
    SLOW,
  )

  test(
    'a muted companion has no pill',
    async () => {
      saveGlobalConfig(c => ({ ...c, companion: { name: 'Pip', personality: 'curious', hatchedAt: 1 }, companionMuted: true }))
      await withPrompt({}, async rig => {
        await rig.press(KEY.down)
        expect(rig.state().footerSelection).toBeNull()
      })
    },
    SLOW,
  )
})

// =====================================================================================
// The frame around the prompt
// =====================================================================================

describe('the frame', () => {
  test(
    'a session name set with /rename frames the prompt in a banner',
    async () => {
      await withPrompt({ appState: { standaloneAgentContext: { name: 'scout', color: 'green' } } as Partial<AppState> }, async rig => {
        const banner = rows(rig).find(row => row.includes(' scout '))
        expect(banner).toBeDefined()
        expect(banner?.endsWith('scout ──')).toBe(true)
      })
    },
    SLOW,
  )

  test(
    'a banner with no text is a plain rule',
    async () => {
      await withPrompt({ appState: { standaloneAgentContext: { name: '', color: 'green' } } as Partial<AppState> }, async rig => {
        const rules = rows(rig).filter(row => /^─+$/.test(row))
        expect(rules.length).toBeGreaterThanOrEqual(2)
      })
    },
    SLOW,
  )

  test(
    'fullscreen mode moves notifications into the prompt frame',
    async () => {
      process.env.CLAUDIN_NO_FLICKER = '1'
      await withPrompt({}, async rig => {
        await rig.press(KEY.ctrlC)
        expect(rig.screen()).toContain('Press Ctrl-C again to exit')
      })
    },
    SLOW,
  )
})
