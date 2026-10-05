/**
 * Characterization of the dialog that asks before the Write tool creates or
 * replaces a file, and of the diff it shows. Written before the clean-base
 * rewrite of permissions/fileDialogs; the spec is
 * docs/tech/rewrite/permissions/fileDialogs.md.
 *
 * Reached through `PermissionRequest` with the real FileWriteTool on real
 * files. The IDE, when one is connected, is a stand-in MCP server.
 */
import { describe, expect, test } from 'bun:test'
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
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import type { Tool } from 'src/tools/Tool.js'

const world = isolatedWorld()
const { enter, esc, tab, down } = KEYS
const write = FileWriteTool as unknown as Tool
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }

/** The frame without blank lines, rules and right padding. */
const visible = (frame: string) =>
  frame
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^[─╌]+$/.test(line))

const numbered = (count: number, change?: { at: number; text: string }) =>
  Array.from({ length: count }, (_, i) => (change && change.at === i + 1 ? change.text : `line ${i + 1}`)).join('\n') + '\n'

describe('FileWritePermissionRequest: what it shows', () => {
  type Row = { name: string; existing?: string; content: string; until: string; expected: string[] }
  const rows: Row[] = [
    {
      name: 'a new file: Create, the content numbered',
      content: 'hello\nworld',
      until: 'world',
      expected: ['Create file', 'out.txt', '1 hello', '2 world', 'Do you want to create out.txt?'],
    },
    {
      name: 'a new empty file: a placeholder line',
      content: '',
      until: '(No content)',
      expected: ['Create file', 'out.txt', '1 (No content)', 'Do you want to create out.txt?'],
    },
    {
      name: 'an existing file: Overwrite, the diff against what is there',
      existing: 'one\ntwo\n',
      content: 'one\nthree\n',
      until: '+three',
      expected: ['Overwrite file', 'out.txt', '1  one', '2 -two', '2 +three', 'Do you want to overwrite out.txt?'],
    },
    {
      name: 'changes far apart: one hunk each, with a dim "..." between',
      existing: numbered(20),
      content: numbered(20, { at: 1, text: 'first' }).replace('line 20', 'last'),
      until: '+last',
      expected: [
        'Overwrite file',
        'out.txt',
        '1 -line 1',
        '1 +first',
        '2  line 2',
        '3  line 3',
        '4  line 4',
        '...',
        '17  line 17',
        '18  line 18',
        '19  line 19',
        '20 -line 20',
        '20 +last',
        'Do you want to overwrite out.txt?',
      ],
    },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const w = world()
        startIn(w.project)
        const path = join(w.project, 'out.txt')
        if (row.existing !== undefined) put(path, row.existing)
        const { screen } = await askFile({ tool: write, input: { file_path: path, content: row.content } })
        await screen.until(frame => frame.includes(row.until), 'the content')
        expect(visible(screen.text()).slice(0, row.expected.length)).toEqual(row.expected)
        expect(choices(screen.text())).toEqual(['❯ 1. Yes', '2. Yes, allow all edits during this session (shift+tab)', '3. No'])
      },
      SLOW,
    )
  }
})

describe('FileWritePermissionRequest: what each answer reports', () => {
  type Row = { name: string; keys: string[]; calls: (input: unknown) => unknown[] }
  const rows: Row[] = [
    { name: 'Yes', keys: ['1'], calls: i => allowedWith(i, [], undefined) },
    { name: 'Yes with a note', keys: [tab, ...'then format it', enter], calls: i => allowedWith(i, [], 'then format it') },
    { name: 'the session option', keys: ['2'], calls: i => allowedWith(i, [ACCEPT_EDITS], undefined) },
    { name: 'shift+tab', keys: [SHIFT_TAB], calls: i => allowedWith(i, [ACCEPT_EDITS], undefined) },
    { name: 'No', keys: [down, down, enter], calls: () => deniedWith(undefined) },
    { name: 'No with a note', keys: [down, down, tab, ...'wrong folder', enter], calls: () => deniedWith('wrong folder') },
    { name: 'Esc', keys: [esc], calls: () => deniedWith(undefined) },
  ]
  for (const existing of [false, true]) {
    for (const row of rows) {
      test(
        `${existing ? 'overwrite' : 'create'}: ${row.name}`,
        async () => {
          const w = world()
          startIn(w.project)
          const path = join(w.project, 'w.txt')
          if (existing) put(path, 'before\n')
          const input = { file_path: path, content: 'after\n' }
          const asked = await askFile({ tool: write, input })
          expect(await reply(asked, row.keys)).toEqual(row.calls(input))
        },
        SLOW,
      )
    }
  }

  test(
    'outside the project: the session option names and adds the folder',
    async () => {
      const w = world()
      startIn(w.project)
      const input = { file_path: join(w.home, 'build', 'out.js'), content: 'x' }
      const asked = await askFile({ tool: write, input })
      expect(choices(asked.screen.text())[1]).toBe('2. Yes, allow all edits in build/ during this session (shift+tab)')
      expect(await reply(asked, ['2'])).toEqual(
        allowedWith(input, [ACCEPT_EDITS, { type: 'addDirectories', directories: [join(w.home, 'build')], destination: 'session' }], undefined),
      )
    },
    SLOW,
  )
})

describe('FileWritePermissionRequest: the IDE diff', () => {
  type Row = { name: string; existing?: string; reply: string[]; content: (asked: string) => string }
  const rows: Row[] = [
    { name: 'a new file saved with changes: the saved text is what is written', reply: ['FILE_SAVED', 'edited in the IDE\n'], content: () => 'edited in the IDE\n' },
    { name: 'an existing file saved with changes', existing: 'old\n', reply: ['FILE_SAVED', 'mine\n'], content: () => 'mine\n' },
    { name: 'tab closed: the proposal as sent', existing: 'old\n', reply: ['TAB_CLOSED'], content: proposed => proposed },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const w = world()
        startIn(w.project)
        const path = join(w.project, 'ide.txt')
        if (row.existing !== undefined) put(path, row.existing)
        const ide = await standInIde('Zed')
        const asked = await askFile({ tool: write, input: { file_path: path, content: 'proposed\n' }, servers: [ide.server] })
        const open = await ide.opened()
        expect(open.args).toMatchObject({ old_file_path: path, new_file_path: path, new_file_contents: 'proposed\n' })
        expect(visible(asked.screen.text())).toContain('Opened changes in Zed ⧉')
        ide.settle(ideSays(...row.reply))
        await asked.screen.until(() => asked.calls.length > 0, 'the answer')
        await Bun.sleep(100)
        expect(asked.calls).toEqual(allowedWith({ file_path: path, content: row.content('proposed\n') }, [], undefined))
      },
      SLOW,
    )
  }

  test(
    'rejected in the IDE: denied',
    async () => {
      const w = world()
      startIn(w.project)
      const ide = await standInIde()
      const asked = await askFile({ tool: write, input: { file_path: join(w.project, 'r.txt'), content: 'r' }, servers: [ide.server] })
      await ide.opened()
      ide.settle(ideSays('DIFF_REJECTED'))
      await asked.screen.until(() => asked.calls.length > 0, 'the answer')
      await Bun.sleep(100)
      expect(asked.calls).toEqual(deniedWith(undefined))
    },
    SLOW,
  )

  test(
    'Yes in the terminal closes the tab and writes the request as sent',
    async () => {
      const w = world()
      startIn(w.project)
      const ide = await standInIde()
      const input = { file_path: join(w.project, 't.txt'), content: 't' }
      const asked = await askFile({ tool: write, input, servers: [ide.server] })
      const open = await ide.opened()
      expect(await reply(asked, ['1'])).toEqual(allowedWith(input, [], undefined))
      await asked.screen.until(() => ide.seen.length === 2, 'the tab to close')
      expect(ide.seen[1]).toEqual({ name: 'close_tab', args: { tab_name: open.args.tab_name } })
    },
    SLOW,
  )
})
