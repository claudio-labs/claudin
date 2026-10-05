/**
 * Characterization of the dialog an MCP server opens to send the user to a
 * web page (`ElicitationDialog` with `mode: 'url'`). Written before the
 * clean-base rewrite of mcp/elicitationDialog; the spec is
 * docs/tech/rewrite/mcp/elicitationDialog.md.
 *
 * The browser is a real executable named by $BROWSER, a shell script that
 * writes down each URL it is given, so a test can see whether and what the
 * dialog opened. After Accept the dialog waits for the server's completion
 * notice; that second phase reports through `onWaitingDismiss`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as React from 'react'
import { Text } from 'src/terminal/ink.js'
import { isolatedWorld, KEYS, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { buttonRow, guide, openLink, rows } from 'src/mcp/ui/__testutils__/elicitationRig.js'

isolatedWorld()
withTruecolor()

const { enter, esc } = KEYS
const left = '\x1B[D'
const right = '\x1B[C'

// --- the stand-in browser ------------------------------------------------------

const browserHome = mkdtempSync(join(tmpdir(), 'elicit-browser-'))
const visits = join(browserHome, 'visits.log')
const savedBrowser = process.env.BROWSER
beforeAll(() => {
  const script = join(browserHome, 'browser.sh')
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${visits}'\nexit 0\n`)
  chmodSync(script, 0o755)
  process.env.BROWSER = script
})
beforeEach(() => {
  rmSync(visits, { force: true })
})
afterAll(() => {
  if (savedBrowser === undefined) delete process.env.BROWSER
  else process.env.BROWSER = savedBrowser
  rmSync(browserHome, { recursive: true, force: true })
})

const opened = () => (existsSync(visits) ? readFileSync(visits, 'utf8').split('\n').filter(Boolean) : [])

/** Waits for the browser to have been launched `count` times. */
async function launches(count: number): Promise<string[]> {
  const deadline = Date.now() + 5_000
  while (opened().length < count && Date.now() < deadline) await Bun.sleep(20)
  return opened()
}

const URL_ = 'https://auth.example.com/consent?flow=7'

/**
 * The guide names the two arrow keys between these words. The glyph itself is
 * not pinned: today it is drawn as the six characters of an escape (spec, findings).
 */
const SWITCH_GUIDE = /^Esc to cancel · \S+ to switch$/

// --- the first phase: asking -------------------------------------------------------

describe('asking to open the URL', () => {
  test(
    'the frame: title, message, the URL whole, Accept chosen, and a guide for switching',
    async () => {
      const { screen } = await openLink({ url: URL_, server: 'bank', message: 'Approve access in your browser' })
      expect(rows(screen.text()).slice(0, -1)).toEqual([
        '─'.repeat(100),
        'MCP server “bank” wants to open a URL',
        'Approve access in your browser',
        URL_,
        '❯ Accept    Decline',
      ])
      expect(guide(screen.text())).toMatch(SWITCH_GUIDE)
    },
    SLOW,
  )

  test(
    'the host name is the bold part of the URL, the rest is not',
    async () => {
      const { screen } = await openLink({ url: URL_ })
      const styled = screen.styled()
      expect(styleBefore(styled, 'auth.example.com')).toContain('\u001B[1m')
      expect(styleBefore(styled, 'https://')).not.toContain('\u001B[1m')
    },
    SLOW,
  )

  test(
    'text that is not a URL is shown as it is',
    async () => {
      const { screen } = await openLink({ url: 'see the docs' })
      expect(rows(screen.text())).toContain('see the docs')
    },
    SLOW,
  )

  test(
    'the URL dialog registers its own overlay while it is up',
    async () => {
      const { screen } = await openLink({ url: URL_ })
      expect([...screen.state().activeOverlays]).toEqual(['elicitation-url'])
      await screen.replace(<Text>after</Text>)
      expect([...screen.state().activeOverlays]).toEqual([])
    },
    SLOW,
  )

  test(
    'Left and Right swap Accept and Decline',
    async () => {
      const { screen } = await openLink({ url: URL_ })
      const seen = [buttonRow(screen.text())]
      for (const key of [right, right, left]) {
        await screen.press(key)
        seen.push(buttonRow(screen.text()))
      }
      expect(seen).toEqual(['❯ Accept    Decline', 'Accept  ❯ Decline', '❯ Accept    Decline', 'Accept  ❯ Decline'])
    },
    SLOW,
  )

  type Refusal = { what: string; keys: string[]; action: string }
  const refusals: Refusal[] = [
    { what: 'Enter on Decline', keys: [right, enter], action: 'decline' },
    { what: 'Esc', keys: [esc], action: 'cancel' },
    { what: 'n', keys: ['n'], action: 'cancel' },
  ]
  for (const c of refusals) {
    test(
      `${c.what} answers ${c.action} and opens nothing`,
      async () => {
        const link = await openLink({ url: URL_ })
        await link.screen.press(...c.keys)
        await Bun.sleep(200)
        expect(link.log).toEqual([{ via: 'onResponse', action: c.action }])
        expect(opened()).toEqual([])
      },
      SLOW,
    )
  }

  test(
    'Enter on Accept opens the URL, answers accept with no content, and starts waiting',
    async () => {
      const link = await openLink({ url: URL_, server: 'bank', message: 'Approve access' })
      await link.screen.press(enter)
      expect(await launches(1)).toEqual([URL_])
      expect(link.log).toEqual([{ via: 'onResponse', action: 'accept' }])
      expect(rows(link.screen.text()).slice(0, -1)).toEqual([
        '─'.repeat(100),
        'MCP server “bank” — waiting for completion',
        'Approve access',
        URL_,
        'Waiting for the server to confirm completion…',
        '❯ Reopen URL    Continue without waiting',
      ])
      expect(guide(link.screen.text())).toMatch(SWITCH_GUIDE)
    },
    SLOW,
  )

  test(
    'a URL the browser may not open (not http or https) is never launched, yet Accept still answers accept',
    async () => {
      const link = await openLink({ url: 'file:///etc/passwd' })
      await link.screen.press(enter)
      await Bun.sleep(300)
      expect(opened()).toEqual([])
      expect(link.log).toEqual([{ via: 'onResponse', action: 'accept' }])
      expect(rows(link.screen.text())).toContain('Waiting for the server to confirm completion…')
    },
    SLOW,
  )

  test(
    'the server cancelling while it asks answers cancel',
    async () => {
      const link = await openLink({ url: URL_ })
      link.abort()
      await Bun.sleep(50)
      expect(link.log).toEqual([{ via: 'onResponse', action: 'cancel' }])
    },
    SLOW,
  )

  test(
    'a request already cancelled when the dialog opens answers cancel at once',
    async () => {
      const link = await openLink({ url: URL_ }, { preAborted: true })
      expect(link.log).toEqual([{ via: 'onResponse', action: 'cancel' }])
    },
    SLOW,
  )

  test(
    'a completion notice before Accept changes nothing until Accept, then ends the wait at once',
    async () => {
      const link = await openLink({ url: URL_ })
      await link.complete()
      expect(link.log).toEqual([])
      await link.screen.press(enter)
      expect(link.log).toEqual([
        { via: 'onResponse', action: 'accept' },
        { via: 'onWaitingDismiss', action: 'dismiss' },
      ])
    },
    SLOW,
  )
})

// --- the second phase: waiting ---------------------------------------------------------

describe('waiting for completion', () => {
  const waiting = async (waitingState?: { actionLabel: string; showCancel?: boolean }) => {
    const link = await openLink({ url: URL_, waitingState })
    await link.screen.press(enter)
    await launches(1)
    link.log.length = 0
    return link
  }

  test(
    'the action button carries the label the event gives; showCancel adds a Cancel button',
    async () => {
      const plain = await waiting({ actionLabel: 'Skip confirmation' })
      expect(buttonRow(plain.screen.text())).toBe('❯ Reopen URL    Skip confirmation')
      await plain.screen.close()
      const withCancel = await waiting({ actionLabel: 'Retry now', showCancel: true })
      expect(buttonRow(withCancel.screen.text())).toBe('❯ Reopen URL    Retry now   Cancel')
    },
    SLOW,
  )

  test(
    'Right and Left cycle the buttons and wrap at both ends',
    async () => {
      const link = await waiting({ actionLabel: 'Go on', showCancel: true })
      const seen: string[] = []
      for (const key of [right, right, right, left, left]) {
        await link.screen.press(key)
        seen.push(buttonRow(link.screen.text()))
      }
      expect(seen).toEqual([
        'Reopen URL  ❯ Go on   Cancel',
        'Reopen URL    Go on ❯ Cancel',
        '❯ Reopen URL    Go on   Cancel',
        'Reopen URL    Go on ❯ Cancel',
        'Reopen URL  ❯ Go on   Cancel',
      ])
    },
    SLOW,
  )

  test(
    'without Cancel, the two buttons wrap into each other',
    async () => {
      const link = await waiting()
      await link.screen.press(left)
      expect(buttonRow(link.screen.text())).toBe('Reopen URL  ❯ Continue without waiting')
      await link.screen.press(right)
      expect(buttonRow(link.screen.text())).toBe('❯ Reopen URL    Continue without waiting')
    },
    SLOW,
  )

  test(
    'Enter on Reopen URL opens it again and reports nothing',
    async () => {
      const link = await waiting()
      await link.screen.press(enter)
      expect(await launches(2)).toEqual([URL_, URL_])
      expect(link.log).toEqual([])
    },
    SLOW,
  )

  type Ending = { what: string; state?: { actionLabel: string; showCancel?: boolean }; keys: string[]; action: string }
  const endings: Ending[] = [
    { what: 'the action button, without Cancel', keys: [right, enter], action: 'dismiss' },
    { what: 'the action button, with Cancel', state: { actionLabel: 'Retry', showCancel: true }, keys: [right, enter], action: 'retry' },
    { what: 'the Cancel button', state: { actionLabel: 'Retry', showCancel: true }, keys: [left, enter], action: 'cancel' },
    { what: 'Esc', keys: [esc], action: 'cancel' },
  ]
  for (const c of endings) {
    test(
      `${c.what} ends the wait with ${c.action}, and nothing more goes to onResponse`,
      async () => {
        const link = await waiting(c.state)
        await link.screen.press(...c.keys)
        expect(link.log).toEqual([{ via: 'onWaitingDismiss', action: c.action }])
      },
      SLOW,
    )
  }

  type Notice = { state?: { actionLabel: string; showCancel?: boolean }; action: string }
  const notices: Notice[] = [
    { action: 'dismiss' },
    { state: { actionLabel: 'Retry', showCancel: true }, action: 'retry' },
  ]
  for (const c of notices) {
    test(
      `the completion notice ends the wait by itself with ${c.action}`,
      async () => {
        const link = await waiting(c.state)
        await link.complete()
        expect(link.log).toEqual([{ via: 'onWaitingDismiss', action: c.action }])
      },
      SLOW,
    )
  }

  test(
    'the server cancelling while it waits ends the wait with cancel, not onResponse',
    async () => {
      const link = await waiting()
      link.abort()
      await Bun.sleep(50)
      expect(link.log).toEqual([{ via: 'onWaitingDismiss', action: 'cancel' }])
    },
    SLOW,
  )

  test(
    'with no onWaitingDismiss given, the waiting keys report nothing and do not fail',
    async () => {
      const link = await openLink({ url: URL_ }, { withoutWaitingDismiss: true })
      await link.screen.press(enter, right, enter, esc)
      expect(link.log).toEqual([{ via: 'onResponse', action: 'accept' }])
      expect(guide(link.screen.text())).toMatch(SWITCH_GUIDE)
    },
    SLOW,
  )
})
