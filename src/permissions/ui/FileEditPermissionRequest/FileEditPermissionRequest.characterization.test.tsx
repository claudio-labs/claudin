/**
 * Characterization of the dialog that asks before the Edit tool changes a
 * file. Written before the clean-base rewrite of permissions/fileDialogs; the
 * spec is docs/tech/rewrite/permissions/fileDialogs.md.
 *
 * Reached through `PermissionRequest` with the real FileEditTool on real
 * files. When an IDE is connected the proposed edit goes to it as a diff tab;
 * the IDE is a stand-in MCP server, the only thing faked here.
 */
import { describe, expect, test } from 'bun:test'
import { symlinkSync } from 'fs'
import { join } from 'path'
import { isolatedWorld, KEYS, SLOW, type World } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import {
  allowedWith,
  askFile,
  choices,
  deniedWith,
  ideSays,
  put,
  reply,
  SHIFT_TAB,
  standInIde,
  startIn,
} from 'src/permissions/ui/__testutils__/fileDialogsRig.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import type { Tool } from 'src/tools/Tool.js'

const world = isolatedWorld()
const { enter, esc, tab, down } = KEYS
const edit = FileEditTool as unknown as Tool
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }

function sourceFile(w: World, name = 'calc.ts', text = 'const a = 1\nconst b = 2\n'): string {
  startIn(w.project)
  return put(join(w.project, name), text)
}

const lines = (frame: string) => frame.split('\n').map(line => line.trimEnd())

describe('FileEditPermissionRequest: what it shows', () => {
  test(
    'title, path from the shell directory, the diff, the question and three options',
    async () => {
      const w = world()
      const file = sourceFile(w)
      const { screen } = await askFile({ tool: edit, input: { file_path: file, old_string: 'const a = 1', new_string: 'const a = 42' } })
      await screen.until(frame => frame.includes('+const a = 42'), 'the diff')
      const shown = lines(screen.text()).map(line => line.trim()).filter(line => line !== '' && !/^[─╌]+$/.test(line))
      expect(shown).toEqual([
        'Edit file',
        'calc.ts',
        '1 -const a = 1',
        '1 +const a = 42',
        '2  const b = 2',
        'Do you want to make this edit to calc.ts?',
        '❯ 1. Yes',
        '2. Yes, allow all edits during this session (shift+tab)',
        '3. No',
        'Esc to cancel · Tab to amend',
      ])
    },
    SLOW,
  )

  test(
    'the subtitle is relative to where the shell is now; the worker badge joins the title',
    async () => {
      const w = world()
      const file = sourceFile(w)
      startIn(join(w.project, 'deep'))
      const { screen } = await askFile({
        tool: edit,
        input: { file_path: file, old_string: 'const b = 2', new_string: 'const b = 3' },
        workerBadge: { name: 'builder', color: 'cyan' },
      })
      const top = lines(screen.text()).map(line => line.trim()).filter(Boolean)
      expect(top.slice(1, 3)).toEqual(['Edit file · @builder', '../calc.ts'])
    },
    SLOW,
  )
})

describe('FileEditPermissionRequest: what each answer reports', () => {
  type Row = { name: string; keys: string[]; calls: (input: unknown) => unknown[] }
  const rows: Row[] = [
    { name: 'Yes: allowed once, nothing remembered', keys: ['1'], calls: i => allowedWith(i, [], undefined) },
    { name: 'Yes with a note', keys: [tab, ...'and run the tests', enter], calls: i => allowedWith(i, [], 'and run the tests') },
    { name: 'the session option: accept edits for the session', keys: ['2'], calls: i => allowedWith(i, [ACCEPT_EDITS], undefined) },
    { name: 'shift+tab: the session option from anywhere in the list', keys: [down, down, SHIFT_TAB], calls: i => allowedWith(i, [ACCEPT_EDITS], undefined) },
    { name: 'No', keys: ['3'], calls: () => deniedWith(undefined) },
    { name: 'No with a note', keys: [down, down, tab, ...'use let', enter], calls: () => deniedWith('use let') },
    { name: 'Esc', keys: [esc], calls: () => deniedWith(undefined) },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const w = world()
        const input = { file_path: sourceFile(w), old_string: 'const a = 1', new_string: 'const a = 2' }
        const asked = await askFile({ tool: edit, input })
        expect(await reply(asked, row.keys)).toEqual(row.calls(input))
      },
      SLOW,
    )
  }

  test(
    'the allow carries the input as the tool reads it, not as it was sent',
    async () => {
      const w = world()
      const file = sourceFile(w)
      const asked = await askFile({ tool: edit, input: { file_path: file, old_string: 'const a = 1', new_string: 'x', replace_all: 'true' } })
      expect(await reply(asked, ['1'])).toEqual(allowedWith({ file_path: file, old_string: 'const a = 1', new_string: 'x', replace_all: true }, [], undefined))
    },
    SLOW,
  )

  test(
    'outside the project the session option also adds the folder',
    async () => {
      const w = world()
      startIn(w.project)
      const file = put(join(w.home, 'lib', 'util.ts'), 'u\n')
      const input = { file_path: file, old_string: 'u', new_string: 'v' }
      const asked = await askFile({ tool: edit, input })
      expect(choices(asked.screen.text())[1]).toBe('2. Yes, allow all edits in lib/ during this session (shift+tab)')
      expect(await reply(asked, ['2'])).toEqual(
        allowedWith(input, [ACCEPT_EDITS, { type: 'addDirectories', directories: [join(w.home, 'lib')], destination: 'session' }], undefined),
      )
    },
    SLOW,
  )
})

describe('FileEditPermissionRequest: the IDE diff', () => {
  async function inIde(w: World, input: Record<string, unknown>) {
    const ide = await standInIde('Zed')
    const asked = await askFile({ tool: edit, input, servers: [ide.server] })
    const open = await ide.opened()
    return { ide, asked, open }
  }

  test(
    'the IDE gets the whole proposed file; the terminal shows where the diff went',
    async () => {
      const w = world()
      const file = sourceFile(w, 'twice.ts', 'q\nq\n')
      const { asked, open } = await inIde(w, { file_path: file, old_string: 'q', new_string: 'r' })
      expect(open.args).toMatchObject({ old_file_path: file, new_file_path: file, new_file_contents: 'r\nq\n' })
      const shown = lines(asked.screen.text()).map(line => line.trim()).filter(Boolean)
      expect(shown).toContain('Opened changes in Zed ⧉')
      expect(shown).toContain('Do you want to make this edit to twice.ts?')
      expect(shown).not.toContain('Edit file')
    },
    SLOW,
  )

  test(
    'replace-all reaches the IDE',
    async () => {
      const w = world()
      const file = sourceFile(w, 'twice.ts', 'q\nq\n')
      const { open } = await inIde(w, { file_path: file, old_string: 'q', new_string: 'r', replace_all: true })
      expect(open.args.new_file_contents).toBe('r\nr\n')
    },
    SLOW,
  )

  type Answer = { name: string; reply: string[]; calls: (file: string) => unknown[] }
  const answers: Answer[] = [
    {
      name: 'saved with changes: allowed once, as one whole-file edit of what was saved',
      reply: ['FILE_SAVED', 'const a = 7\nconst b = 2\n'],
      calls: file => allowedWith({ file_path: file, old_string: 'const a = 1\nconst b = 2\n', new_string: 'const a = 7\nconst b = 2\n', replace_all: false }, [], undefined),
    },
    {
      name: 'tab closed: allowed once, as the whole-file form of the proposal',
      reply: ['TAB_CLOSED'],
      calls: file => allowedWith({ file_path: file, old_string: 'const a = 1\nconst b = 2\n', new_string: 'const a = 9\nconst b = 2\n', replace_all: false }, [], undefined),
    },
    { name: 'rejected in the IDE: denied, no note', reply: ['DIFF_REJECTED'], calls: () => deniedWith(undefined) },
  ]
  for (const row of answers) {
    test(
      row.name,
      async () => {
        const w = world()
        const file = sourceFile(w)
        const { ide, asked } = await inIde(w, { file_path: file, old_string: 'const a = 1', new_string: 'const a = 9' })
        ide.settle(ideSays(...row.reply))
        await asked.screen.until(() => asked.calls.length > 0, 'the answer')
        await Bun.sleep(100)
        expect(asked.calls).toEqual(row.calls(file))
      },
      SLOW,
    )
  }

  const terminal: Array<[string, string[], (input: unknown) => unknown[]]> = [
    ['Yes in the terminal', ['1'], i => allowedWith(i, [], undefined)],
    ['No in the terminal', ['3'], () => deniedWith(undefined)],
    ['Esc in the terminal', [esc], () => deniedWith(undefined)],
  ]
  for (const [name, keys, calls] of terminal) {
    test(
      `${name}: the request's own input, and the IDE tab is closed`,
      async () => {
        const w = world()
        const input = { file_path: sourceFile(w), old_string: 'const a = 1', new_string: 'const a = 5' }
        const { ide, asked } = await inIde(w, input)
        expect(await reply(asked, keys)).toEqual(calls(input))
        await asked.screen.until(() => ide.seen.some(call => call.name === 'close_tab'), 'the tab to close')
        expect(ide.seen.map(call => call.name)).toEqual(['openDiff', 'close_tab'])
      },
      SLOW,
    )
  }

  test(
    'shift+tab in the terminal: the session option; the tab is closed once the dialog is gone (spec, finding 6)',
    async () => {
      const w = world()
      const input = { file_path: sourceFile(w), old_string: 'const a = 1', new_string: 'const a = 5' }
      const { ide, asked } = await inIde(w, input)
      expect(await reply(asked, [SHIFT_TAB])).toEqual(allowedWith(input, [ACCEPT_EDITS], undefined))
      await asked.screen.close()
      await asked.screen.until(() => ide.seen.some(call => call.name === 'close_tab'), 'the tab to close')
    },
    SLOW,
  )

  test(
    'a link out of the project: the IDE prompt carries the symlink warning',
    async () => {
      const w = world()
      const target = put(join(w.home, 'elsewhere', 'real.ts'), 'x\n')
      symlinkSync(target, join(w.project, 'link.ts'))
      startIn(w.project)
      const { asked } = await inIde(w, { file_path: join(w.project, 'link.ts'), old_string: 'x', new_string: 'y' })
      expect(asked.screen.text().replace(/\s+/g, ' ')).toContain(`This will modify ${target} (outside working directory) via a symlink`)
    },
    SLOW,
  )
})
