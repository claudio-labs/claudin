/**
 * Characterization of the workflow picker the GitHub-app installer shows:
 * the two workflow options, the at-least-one rule, and what Enter, Space and
 * Esc do.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { WorkflowMultiselectDialog } from 'src/agent/ui/WorkflowMultiselectDialog.js'
import { KEYS, withInk, type Mounted } from 'src/agent/ui/__testutils__/inkMount.js'

const TIMEOUT = 30_000
const MENTION = '@Claude Code - Tag @claude in issues and PR comments'
const REVIEW = 'Claude Code Review - Automated code review on new PRs'
const NEED_ONE = 'You must select at least one workflow to continue'

const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR
let configDir = ''
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'workflow-picker-char-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
})
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

async function withPicker(defaults: string[], body: (ui: Mounted, submitted: string[][]) => Promise<void>): Promise<void> {
  const submitted: string[][] = []
  await withInk(
    <WorkflowMultiselectDialog defaultSelections={defaults as never} onSubmit={chosen => submitted.push([...chosen])} />,
    async ui => {
      await ui.waitFor(REVIEW)
      await body(ui, submitted)
    },
    140,
  )
}

describe('WorkflowMultiselectDialog', () => {
  test(
    'shows the title, both workflows, the examples link and the key hints',
    async () => {
      await withPicker(['claude'], async ui => {
        const frame = ui.screen()
        for (const text of ['Select GitHub workflows to install', MENTION, REVIEW, 'More workflow examples', 'Space to toggle', 'Enter to confirm']) {
          expect(frame, text).toContain(text)
        }
        expect(frame.indexOf(MENTION)).toBeLessThan(frame.indexOf(REVIEW))
        expect(frame).not.toContain(NEED_ONE)
      })
    },
    TIMEOUT,
  )

  test(
    'Enter submits the default selection as is',
    async () => {
      const cases: string[][] = [['claude'], ['claude', 'claude-review'], ['claude-review']]
      for (const defaults of cases) {
        await withPicker(defaults, async (ui, submitted) => {
          await ui.press(KEYS.enter)
          expect(submitted, defaults.join()).toEqual([defaults])
        })
      }
    },
    TIMEOUT,
  )

  test(
    'Space toggles the focused workflow before submitting',
    async () => {
      await withPicker(['claude'], async (ui, submitted) => {
        await ui.press(KEYS.down)
        await ui.press(KEYS.space)
        await ui.press(KEYS.enter)
        expect(submitted).toEqual([['claude', 'claude-review']])
      })
    },
    TIMEOUT,
  )

  test(
    'submitting nothing shows the error instead, and changing the selection clears it',
    async () => {
      await withPicker([], async (ui, submitted) => {
        await ui.press(KEYS.enter)
        await ui.waitFor(NEED_ONE)
        expect(submitted).toEqual([])
        await ui.press(KEYS.space)
        await ui.waitFor(frame => !frame.includes(NEED_ONE))
        await ui.press(KEYS.enter)
        expect(submitted).toEqual([['claude']])
      })
    },
    TIMEOUT,
  )

  test(
    'Esc does not close the picker: it shows the same error',
    async () => {
      await withPicker(['claude'], async (ui, submitted) => {
        await ui.press(KEYS.esc, 400)
        await ui.waitFor(NEED_ONE)
        expect(submitted).toEqual([])
      })
    },
    TIMEOUT,
  )
})
