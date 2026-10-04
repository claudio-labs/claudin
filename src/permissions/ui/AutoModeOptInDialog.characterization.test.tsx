/**
 * Characterization of AutoModeOptInDialog, the consent shown before auto mode
 * is first used: at startup when the session starts in auto (where declining
 * ends the process), and from the prompt when shift+tab reaches auto (where
 * declining goes back). Also pins the facts of AUTO_MODE_DESCRIPTION, which
 * the REPL repeats as a system message. Written before the clean-base rewrite
 * of permissions/modeDialogs; the spec is docs/tech/rewrite/permissions/modeDialogs.md.
 *
 * The dialog has no build-flag branch of its own: its callers only mount it
 * when TRANSCRIPT_CLASSIFIER is on, so the plain runner sees all of it.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { AUTO_MODE_DESCRIPTION, AutoModeOptInDialog } from 'src/permissions/ui/AutoModeOptInDialog.js'
import { flat, isolatedWorld, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

const world = isolatedWorld()
const userSettings = () => join(world().config, 'settings.json')
const readUser = () => JSON.parse(readFileSync(userSettings(), 'utf8')) as Record<string, unknown>

type Heard = { accepted: number; declined: number }

async function open(options: { declineExits?: boolean; existing?: Record<string, unknown> } = {}) {
  if (options.existing) writeFileSync(userSettings(), JSON.stringify(options.existing))
  resetSettingsCache()
  const heard: Heard = { accepted: 0, declined: 0 }
  const screen = await mount(
    <AutoModeOptInDialog
      onAccept={() => (heard.accepted += 1)}
      onDecline={() => (heard.declined += 1)}
      declineExits={options.declineExits}
    />,
    { columns: 110 },
  )
  return { screen, heard }
}

describe('AUTO_MODE_DESCRIPTION', () => {
  // The REPL shows this same text as a warning when auto mode turns on, so
  // every fact is pinned here on the export as well as on the dialog.
  const facts = [
    'Auto mode',
    'permission prompts automatically',
    'checks each tool call for risky actions and prompt injection before executing',
    'identifies as safe are executed',
    'identifies as risky are blocked',
    'may try a different approach',
    'long-running tasks',
    'slightly more expensive',
    'can make mistakes that allow harmful commands to run',
    'only use in isolated environments',
    'Shift+Tab to change mode',
  ]
  test('states what auto mode does, its cost, its risk and how to leave it', () => {
    for (const fact of facts) expect(AUTO_MODE_DESCRIPTION).toContain(fact)
    expect(AUTO_MODE_DESCRIPTION).toContain('Claudin')
    expect(AUTO_MODE_DESCRIPTION).not.toContain('\n')
  })
})

describe('AutoModeOptInDialog: what it shows', () => {
  const layouts: Array<{ declineExits: boolean | undefined; decline: string }> = [
    { declineExits: undefined, decline: 'No, go back' },
    { declineExits: false, decline: 'No, go back' },
    { declineExits: true, decline: 'No, exit' },
  ]
  for (const { declineExits, decline } of layouts) {
    test(
      `declineExits=${declineExits}: the description, the link and three answers, declining labelled "${decline}"`,
      async () => {
        const { screen, heard } = await open({ declineExits })
        const text = flat(screen.text())
        expect(text).toContain('Enable auto mode?')
        expect(text).toContain(flat(AUTO_MODE_DESCRIPTION))
        expect(text).toContain('https://code.claude.com/docs/en/security')
        expect(text).toContain(`❯ 1. Yes, and make it my default mode 2. Yes, enable auto mode 3. ${decline}`)
        expect(heard).toEqual({ accepted: 0, declined: 0 })
      },
      SLOW,
    )
  }
})

describe('AutoModeOptInDialog: the answers', () => {
  type Case = {
    answer: string
    keys: string[]
    existing: Record<string, unknown>
    heard: Heard
    /** The user settings afterwards; null when the file must not exist. */
    after: Record<string, unknown> | 'unchanged'
  }
  const existing = { theme: 'dark', permissions: { allow: ['Read'], defaultMode: 'acceptEdits' } }
  const cases: Case[] = [
    {
      answer: 'Enter on the focused "make it my default"',
      keys: [KEYS.enter],
      existing,
      heard: { accepted: 1, declined: 0 },
      after: { theme: 'dark', skipAutoPermissionPrompt: true, permissions: { allow: ['Read'], defaultMode: 'auto' } },
    },
    {
      answer: '"Yes, enable auto mode" by its number',
      keys: ['2'],
      existing,
      heard: { accepted: 1, declined: 0 },
      after: { theme: 'dark', skipAutoPermissionPrompt: true, permissions: { allow: ['Read'], defaultMode: 'acceptEdits' } },
    },
    {
      answer: '"Yes, enable auto mode" by arrow',
      keys: [KEYS.down, KEYS.enter],
      existing: { theme: 'dark' },
      heard: { accepted: 1, declined: 0 },
      after: { theme: 'dark', skipAutoPermissionPrompt: true },
    },
    { answer: 'declining by its number', keys: ['3'], existing, heard: { accepted: 0, declined: 1 }, after: 'unchanged' },
    {
      answer: 'declining by arrow',
      keys: [KEYS.down, KEYS.down, KEYS.enter],
      existing,
      heard: { accepted: 0, declined: 1 },
      after: 'unchanged',
    },
  ]
  for (const c of cases) {
    test(
      `${c.answer}: ${c.heard.accepted ? 'accepts' : 'declines'}`,
      async () => {
        const { screen, heard } = await open({ existing: c.existing })
        await screen.press(...c.keys)
        expect(heard).toEqual(c.heard)
        expect(readUser()).toEqual(c.after === 'unchanged' ? c.existing : c.after)
        // Consent is the user's own: nothing lands in the checkout.
        expect(existsSync(join(world().project, '.claudin'))).toBe(false)
      },
      SLOW,
    )
  }

  test(
    'accepting with no user settings file creates it',
    async () => {
      const { screen, heard } = await open()
      await screen.press('2')
      expect(heard).toEqual({ accepted: 1, declined: 0 })
      expect(readUser()).toEqual({ skipAutoPermissionPrompt: true })
    },
    SLOW,
  )

  test(
    'Esc declines, and only declines: nothing is written',
    async () => {
      const { screen, heard } = await open({ existing, declineExits: true })
      await screen.press(KEYS.esc)
      // Both the list and the frame listen for Esc; the caller still hears one decline.
      expect(heard).toEqual({ accepted: 0, declined: 1 })
      expect(readUser()).toEqual(existing)
    },
    SLOW,
  )
})
