/**
 * Characterization of the "add a directory to the workspace" dialog, written
 * before the clean-base rewrite of permissions/ruleEditors. The spec is
 * docs/tech/rewrite/permissions/ruleEditors.md.
 *
 * The dialog has two faces. Given a path (from `/add-dir <path>`), it asks
 * whether to add it for the session or remember it. Given none (from
 * /permissions, or a bare `/add-dir`), it asks for a path, completes it from
 * the directories on disk, and refuses a path that is missing, is a file, or
 * is already reachable. The directories are real ones under a fresh temp home.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import { isolatedWorld, KEYS, mount, type Screen, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { AddWorkspaceDirectory } from 'src/permissions/ui/rules/AddWorkspaceDirectory.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'

const world = isolatedWorld()
const { enter, esc, tab, down, up } = KEYS
const CTRL_N = '\x0E'
const CTRL_P = '\x10'

type Report = { to: 'add'; path: string; remember: unknown } | { to: 'cancel' }
type Opened = { screen: Screen; reports: Report[] }

const contextWith = (...directories: string[]): ToolPermissionContext => ({
  ...getEmptyToolPermissionContext(),
  additionalWorkingDirectories: new Map(directories.map(path => [path, { path, source: 'session' as const }])),
})

async function open(directoryPath?: string, permissionContext = getEmptyToolPermissionContext()): Promise<Opened> {
  const reports: Report[] = []
  const screen = await mount(
    <AddWorkspaceDirectory
      directoryPath={directoryPath}
      permissionContext={permissionContext}
      onAddDirectory={(path, remember) => reports.push({ to: 'add', path, remember })}
      onCancel={() => reports.push({ to: 'cancel' })}
    />,
    { ready: frame => frame.includes('Esc to cancel') },
  )
  return { screen, reports }
}

/** A directory tree under the temp home; returns the absolute path of the first entry. */
function dirs(...relative: string[]): string[] {
  return relative.map(path => {
    const at = join(world().home, path)
    mkdirSync(at, { recursive: true })
    return at
  })
}

/** The frame's lines, trimmed, with the box edges and blank lines dropped. */
const rows = (frame: string) =>
  frame
    .split('\n')
    .map(line => line.replace(/[│╭╮╰╯─]/g, '').trim())
    .filter(line => line !== '')

/** Types a path and gives the dialog time to finish anything it started. */
async function typeAndSubmit(opened: Opened, text: string): Promise<void> {
  await opened.screen.press(text, enter)
  await Bun.sleep(250)
}

const DESCRIPTION = ['Claudin will be able to read files in this directory and make edits when', 'auto-accept edits is on.']

describe('AddWorkspaceDirectory with a path given', () => {
  test(
    'shows the path, what adding it allows, and three answers',
    async () => {
      const { screen } = await open('/srv/shared data')
      expect(rows(screen.text())).toEqual([
        'Add directory to workspace',
        '/srv/shared data',
        ...DESCRIPTION,
        '❯ 1. Yes, for this session',
        '2. Yes, and remember this directory',
        '3. No',
        'Enter to confirm · Esc to cancel',
      ])
    },
    SLOW,
  )

  const answers: Array<[string, string[], Report[]]> = [
    ['the first answer adds it for the session only', [enter], [{ to: 'add', path: '/srv/shared data', remember: false }]],
    ['the second answer adds it and asks to remember it', [down, enter], [{ to: 'add', path: '/srv/shared data', remember: true }]],
    ['the third answer cancels', [down, down, enter], [{ to: 'cancel' }]],
    ['Esc cancels', [esc], [{ to: 'cancel' }]],
    ['Esc after moving to an add answer still only cancels', [down, esc], [{ to: 'cancel' }]],
    ['moving the pointer reports nothing', [down, down, up], []],
  ]
  for (const [name, keys, expected] of answers) {
    test(
      name,
      async () => {
        const opened = await open('/srv/shared data')
        await opened.screen.press(...keys)
        expect(opened.reports).toEqual(expected)
      },
      SLOW,
    )
  }

  test(
    'the given path is passed on as given, without being checked or resolved',
    async () => {
      const opened = await open('relative/../not-there/')
      await opened.screen.press(down, enter)
      expect(opened.reports).toEqual([{ to: 'add', path: 'relative/../not-there/', remember: true }])
    },
    SLOW,
  )
})

describe('AddWorkspaceDirectory asking for a path', () => {
  test(
    'shows what adding allows, the prompt, an empty input and the keys',
    async () => {
      const { screen } = await open()
      expect(rows(screen.text())).toEqual([
        'Add directory to workspace',
        ...DESCRIPTION,
        'Enter the path to the directory:',
        'Directory path…',
        'Tab to complete · Enter to add · Esc to cancel',
      ])
    },
    SLOW,
  )

  test(
    'an existing directory outside the workspace is added by its absolute path, never remembered',
    async () => {
      const [target] = dirs('elsewhere/target')
      const opened = await open()
      await typeAndSubmit(opened, `${target}/`)
      expect(opened.reports).toEqual([{ to: 'add', path: target, remember: false }])
    },
    SLOW,
  )

  test(
    'dot segments are resolved before the directory is added',
    async () => {
      const [, target] = dirs('elsewhere/a', 'elsewhere/b')
      const opened = await open()
      await typeAndSubmit(opened, `${join(world().home, 'elsewhere', 'a')}/../b/./`)
      expect(opened.reports).toEqual([{ to: 'add', path: target, remember: false }])
    },
    SLOW,
  )

  type Refusal = { name: string; typed: () => string; context?: () => ToolPermissionContext; error: () => string }
  const refusals: Refusal[] = [
    { name: 'an empty path', typed: () => '', error: () => 'Please provide a directory path.' },
    {
      name: 'a path that does not exist',
      typed: () => join(world().home, 'missing', 'deeper'),
      error: () => `Path ${join(world().home, 'missing', 'deeper')} was not found.`,
    },
    {
      name: 'a file',
      typed: () => {
        dirs('files')
        writeFileSync(join(world().home, 'files', 'notes.txt'), 'x')
        return join(world().home, 'files', 'notes.txt')
      },
      error: () =>
        `${join(world().home, 'files', 'notes.txt')} is not a directory. Did you mean to add the parent directory ${join(world().home, 'files')}?`,
    },
    {
      name: 'the original working directory itself',
      typed: () => `${world().project}/`,
      error: () => `${world().project}/ is already accessible within the existing working directory ${world().project}.`,
    },
    {
      name: 'a directory inside the original working directory',
      typed: () => `${dirs('project/src/lib')[0]}/`,
      error: () => `${join(world().project, 'src', 'lib')}/ is already accessible within the existing working directory ${world().project}.`,
    },
    {
      name: 'a directory inside one already added',
      typed: () => `${dirs('shared/docs')[0]}/`,
      context: () => contextWith(join(world().home, 'shared')),
      error: () =>
        `${join(world().home, 'shared', 'docs')}/ is already accessible within the existing working directory ${join(world().home, 'shared')}.`,
    },
  ]
  for (const refusal of refusals) {
    test(
      `${refusal.name}: refused with a message under the input, nothing reported`,
      async () => {
        const typed = refusal.typed()
        const opened = await open(undefined, refusal.context?.() ?? getEmptyToolPermissionContext())
        await typeAndSubmit(opened, typed)
        expect(opened.reports).toEqual([])
        const text = rows(opened.screen.text()).join(' ')
        expect(text).toContain(refusal.error())
      },
      SLOW,
    )
  }

  test(
    'Esc cancels, typed text or not',
    async () => {
      for (const typed of ['', '/some/where']) {
        const opened = await open()
        await opened.screen.press(...(typed ? [typed] : []), esc)
        expect(opened.reports).toEqual([{ to: 'cancel' }])
      }
    },
    SLOW,
  )
})

describe('AddWorkspaceDirectory completing a path', () => {
  /** Types `text` and waits until the completions under the input settle. */
  async function typed(opened: Opened, text: string, settled: (frame: string) => boolean) {
    await opened.screen.press(text)
    await opened.screen.until(settled, 'the completions')
    await Bun.sleep(80)
  }
  const listed = (frame: string) => rows(frame).filter(row => row.endsWith('directory'))
  /** The name a completion row offers, with its trailing slash. */
  const nameOf = (row: string) => /(\S+\/)\s+directory$/.exec(row)?.[1]
  const inputRow = (frame: string) => rows(frame)[rows(frame).indexOf('Enter the path to the directory:') + 1]

  test(
    'a trailing slash lists the subdirectories, hidden ones and files left out, the first one pointed at',
    async () => {
      const [parent] = dirs('tree', 'tree/alpha', 'tree/beta', 'tree/.hidden')
      writeFileSync(join(parent!, 'readme.md'), 'x')
      const opened = await open()
      await typed(opened, `${parent}/`, frame => listed(frame).length === 2)
      const shown = listed(opened.screen.text())
      expect(shown.map(nameOf).sort()).toEqual(['alpha/', 'beta/'])
      expect(shown[0]!.startsWith('❯')).toBe(true)
      expect(opened.reports).toEqual([])
    },
    SLOW,
  )

  test(
    'a partial name lists only the subdirectories it starts, ignoring case',
    async () => {
      const [parent] = dirs('tree', 'tree/Project-one', 'tree/project-two', 'tree/other')
      const opened = await open()
      await typed(opened, `${parent}/proj`, frame => listed(frame).length === 2)
      const names = listed(opened.screen.text()).map(nameOf)
      expect(names.sort()).toEqual(['Project-one/', 'project-two/'])
    },
    SLOW,
  )

  test(
    'Tab puts the pointed completion in the input with a trailing slash, and then lists its own subdirectories',
    async () => {
      const [parent] = dirs('tree', 'tree/only', 'tree/only/inner')
      const opened = await open()
      await typed(opened, `${parent}/`, frame => listed(frame).length === 1)
      await opened.screen.press(tab)
      await opened.screen.until(frame => inputRow(frame) === `${parent}/only/`, 'the completed input')
      await opened.screen.until(frame => listed(frame).some(row => row.includes('inner/')), 'the next completions')
      expect(opened.reports).toEqual([])
    },
    SLOW,
  )

  const moves: Array<[string, string[], number]> = [
    ['down moves to the next completion', [down], 1],
    ['Ctrl+N moves to the next completion', [CTRL_N], 1],
    ['down past the last wraps to the first', [down, down, down], 0],
    ['up from the first wraps to the last', [up], 2],
    ['Ctrl+P moves back', [down, CTRL_P], 0],
    ['up then down comes back to the first', [up, down], 0],
  ]
  for (const [name, keys, landing] of moves) {
    test(
      `${name}; Tab takes the one pointed at`,
      async () => {
        const [parent] = dirs('tree', 'tree/aa', 'tree/bb', 'tree/cc')
        const opened = await open()
        await typed(opened, `${parent}/`, frame => listed(frame).length === 3)
        const order = listed(opened.screen.text()).map(nameOf)
        await opened.screen.press(...keys)
        const pointed = listed(opened.screen.text()).findIndex(row => row.startsWith('❯'))
        expect(pointed).toBe(landing)
        await opened.screen.press(tab)
        await opened.screen.until(frame => inputRow(frame) === `${parent}/${order[landing]}`, 'the completed input')
        expect(opened.reports).toEqual([])
      },
      SLOW,
    )
  }

  test(
    'a completion clears the message of an earlier refusal',
    async () => {
      const [parent] = dirs('tree', 'tree/only')
      const opened = await open()
      await typeAndSubmit(opened, '')
      expect(opened.screen.text()).toContain('Please provide a directory path.')
      await typed(opened, `${parent}/`, frame => listed(frame).length === 1)
      expect(opened.screen.text()).toContain('Please provide a directory path.')
      await opened.screen.press(tab)
      await opened.screen.until(frame => !frame.includes('Please provide a directory path.'), 'the message to go')
    },
    SLOW,
  )

  test(
    'clearing the input clears the completions',
    async () => {
      const [parent] = dirs('tree', 'tree/only')
      const opened = await open()
      await typed(opened, `${parent}/`, frame => listed(frame).length === 1)
      await opened.screen.press(KEYS.ctrlC)
      await opened.screen.until(frame => listed(frame).length === 0 && frame.includes('Directory path…'), 'an empty input')
      expect(opened.reports).toEqual([])
    },
    SLOW,
  )

  test(
    'with no completions, up and down do nothing to the input',
    async () => {
      const opened = await open()
      const missing = join(world().home, 'nothing-here', 'x')
      await opened.screen.press(missing)
      await Bun.sleep(250)
      await opened.screen.press(down, up, tab)
      expect(inputRow(opened.screen.text())).toBe(missing)
      expect(opened.reports).toEqual([])
    },
    SLOW,
  )
})
