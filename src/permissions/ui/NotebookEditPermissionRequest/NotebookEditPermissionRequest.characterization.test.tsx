/**
 * Characterization of the dialog that asks before the NotebookEdit tool
 * replaces, inserts or deletes a cell, and of the cell diff it shows. Written
 * before the clean-base rewrite of permissions/fileDialogs; the spec is
 * docs/tech/rewrite/permissions/fileDialogs.md.
 *
 * Reached through `PermissionRequest` with the real NotebookEditTool, on
 * real .ipynb files in a temp project.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { isolatedWorld, KEYS, SLOW, type World } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import {
  allowedWith,
  askFile,
  choices,
  deniedWith,
  put,
  reply,
  SHIFT_TAB,
  standInIde,
  startIn,
} from 'src/permissions/ui/__testutils__/fileDialogsRig.js'
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js'
import type { Tool } from 'src/tools/Tool.js'

const world = isolatedWorld()
const { enter, esc, tab, down } = KEYS
const notebookTool = NotebookEditTool as unknown as Tool
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }

const CELLS = [
  { id: 'setup', cell_type: 'code', source: ['import os\n', 'x = 1'] },
  { id: 'notes', cell_type: 'markdown', source: '# Title' },
  { id: 'long', cell_type: 'code', source: Array.from({ length: 16 }, (_, i) => `v${i + 1} = ${i + 1}`).join('\n') },
]

function notebook(w: World, name = 'lab.ipynb'): string {
  startIn(w.project)
  return put(join(w.project, name), JSON.stringify({ cells: CELLS, metadata: {}, nbformat: 4, nbformat_minor: 5 }))
}

/** What is inside the notebook box, then the question. */
function boxed(frame: string): string[] {
  return frame
    .split('\n')
    .map(line => line.trim().replace(/^│\s?/, '').replace(/\s*│$/, '').trim())
    .filter(line => line !== '' && !/^[╭╰─]/.test(line))
}

describe('NotebookEditPermissionRequest: what it shows', () => {
  type Row = { name: string; input: (nb: string, w: World) => Record<string, unknown>; verbose?: boolean; until: string; expected: (nb: string) => string[] }
  const rows: Row[] = [
    {
      name: 'replace, cell found by id: the cell diff',
      input: nb => ({ notebook_path: nb, cell_id: 'setup', new_source: 'import os\nx = 2' }),
      until: '+x = 2',
      expected: () => ['Edit notebook', 'lab.ipynb', 'Replace cell contents for cell setup', '1  import os', '2 -x = 1', '\\ No newline at end of file', '2 +x = 2', '\\ No newline at end of file', 'Do you want to make this edit to lab.ipynb?'],
    },
    {
      name: 'replace, cell found by its cell-N index, the type named',
      input: nb => ({ notebook_path: nb, cell_id: 'cell-1', new_source: '# Better', cell_type: 'markdown' }),
      until: '+# Better',
      expected: () => ['Edit notebook', 'lab.ipynb', 'Replace cell contents for cell cell-1 (markdown)', '1 -# Title', '\\ No newline at end of file', '1 +# Better', '\\ No newline at end of file', 'Do you want to make this edit to lab.ipynb?'],
    },
    {
      name: 'replace, an index past the last cell: everything is new',
      input: nb => ({ notebook_path: nb, cell_id: 'cell-9', new_source: 'y = 0' }),
      until: '+y = 0',
      expected: () => ['Edit notebook', 'lab.ipynb', 'Replace cell contents for cell cell-9', '1 +y = 0', '\\ No newline at end of file', 'Do you want to make this edit to lab.ipynb?'],
    },
    {
      name: 'replace, an unknown id: everything is new; verbose shows the full path',
      input: nb => ({ notebook_path: nb, cell_id: 'ghost', new_source: 'y = 0' }),
      verbose: true,
      until: '+y = 0',
      expected: nb => ['Edit notebook', nb, 'Replace cell contents for cell ghost', '1 +y = 0', '\\ No newline at end of file', 'Do you want to make this edit to lab.ipynb?'],
    },
    {
      name: 'replace, changes far apart in one cell: a "..." between hunks',
      input: nb => ({ notebook_path: nb, cell_id: 'long', new_source: (CELLS[2]!.source as string).replace('v1 = 1', 'v1 = 0').replace('v16 = 16', 'v16 = 0') }),
      until: '+v16 = 0',
      expected: () => [
        'Edit notebook', 'lab.ipynb', 'Replace cell contents for cell long',
        '1 -v1 = 1', '1 +v1 = 0', '2  v2 = 2', '3  v3 = 3', '4  v4 = 4', '...',
        '13  v13 = 13', '14  v14 = 14', '15  v15 = 15', '16 -v16 = 16', '\\ No newline at end of file', '16 +v16 = 0', '\\ No newline at end of file',
        'Do you want to make this edit to lab.ipynb?',
      ],
    },
    {
      name: 'insert: the new source, no diff',
      input: nb => ({ notebook_path: nb, cell_id: 'setup', new_source: 'print(x)', edit_mode: 'insert', cell_type: 'code' }),
      until: 'print(x)',
      expected: () => ['Edit notebook', 'lab.ipynb', 'Insert new cell for cell setup (code)', '1 print(x)', 'Do you want to insert this cell into lab.ipynb?'],
    },
    {
      name: 'delete: the source being removed',
      input: nb => ({ notebook_path: nb, cell_id: 'notes', new_source: '', edit_mode: 'delete' }),
      until: '# Title',
      expected: () => ['Edit notebook', 'lab.ipynb', 'Delete cell for cell notes', '1 # Title', 'Do you want to delete this cell from lab.ipynb?'],
    },
    {
      name: 'a notebook that is not there: the new source, no diff',
      input: (_, w) => ({ notebook_path: join(w.project, 'absent.ipynb'), cell_id: 'setup', new_source: 'z = 1' }),
      until: 'z = 1',
      expected: () => ['Edit notebook', 'absent.ipynb', 'Replace cell contents for cell setup', '1 z = 1', 'Do you want to make this edit to absent.ipynb?'],
    },
    {
      name: 'a notebook that is not JSON: the new source, no diff',
      input: (_, w) => ({ notebook_path: put(join(w.project, 'broken.ipynb'), '{ not json'), cell_id: 'setup', new_source: 'z = 1' }),
      until: 'z = 1',
      expected: () => ['Edit notebook', 'broken.ipynb', 'Replace cell contents for cell setup', '1 z = 1', 'Do you want to make this edit to broken.ipynb?'],
    },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const w = world()
        const nb = notebook(w)
        const { screen } = await askFile({ tool: notebookTool, input: row.input(nb, w), verbose: row.verbose, columns: 140 })
        await screen.until(frame => frame.includes(row.until), 'the cell')
        const expected = row.expected(nb)
        expect(boxed(screen.text()).slice(0, expected.length)).toEqual(expected)
        expect(choices(screen.text())).toEqual(['❯ 1. Yes', '2. Yes, allow all edits during this session (shift+tab)', '3. No'])
      },
      SLOW,
    )
  }
})

describe('NotebookEditPermissionRequest: what each answer reports', () => {
  type Row = { name: string; keys: string[]; calls: (input: unknown) => unknown[] }
  const rows: Row[] = [
    { name: 'Yes', keys: ['1'], calls: i => allowedWith(i, [], undefined) },
    { name: 'Yes with a note', keys: [tab, ...'rerun it', enter], calls: i => allowedWith(i, [], 'rerun it') },
    { name: 'the session option', keys: ['2'], calls: i => allowedWith(i, [ACCEPT_EDITS], undefined) },
    { name: 'shift+tab', keys: [SHIFT_TAB], calls: i => allowedWith(i, [ACCEPT_EDITS], undefined) },
    { name: 'No', keys: ['3'], calls: () => deniedWith(undefined) },
    { name: 'No with a note', keys: [down, down, tab, ...'keep the cell', enter], calls: () => deniedWith('keep the cell') },
    { name: 'Esc', keys: [esc], calls: () => deniedWith(undefined) },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const w = world()
        const input = { notebook_path: notebook(w), cell_id: 'setup', new_source: 'x = 3' }
        const asked = await askFile({ tool: notebookTool, input })
        expect(await reply(asked, row.keys)).toEqual(row.calls(input))
      },
      SLOW,
    )
  }

  test(
    'outside the project: the session option names and adds the folder',
    async () => {
      const w = world()
      startIn(w.project)
      const nb = put(join(w.home, 'research', 'a.ipynb'), JSON.stringify({ cells: CELLS, metadata: {}, nbformat: 4, nbformat_minor: 5 }))
      const input = { notebook_path: nb, cell_id: 'setup', new_source: 'x = 3' }
      const asked = await askFile({ tool: notebookTool, input })
      expect(choices(asked.screen.text())[1]).toBe('2. Yes, allow all edits in research/ during this session (shift+tab)')
      expect(await reply(asked, ['2'])).toEqual(
        allowedWith(input, [ACCEPT_EDITS, { type: 'addDirectories', directories: [join(w.home, 'research')], destination: 'session' }], undefined),
      )
    },
    SLOW,
  )

  for (const [name, keys] of [['No', ['3']], ['Esc', [esc]]] as const) {
    test(
      `an input the tool cannot read still opens the dialog, and ${name} denies`,
      async () => {
        const w = world()
        const asked = await askFile({ tool: notebookTool, input: { notebook_path: notebook(w), new_source: 'x', edit_mode: 'rewrite' } })
        expect(boxed(asked.screen.text())[0]).toBe('Edit notebook')
        expect(await reply(asked, [...keys])).toEqual(deniedWith(undefined))
      },
      SLOW,
    )
  }

  test(
    'a connected IDE is not used for notebooks',
    async () => {
      const w = world()
      const ide = await standInIde()
      const input = { notebook_path: notebook(w), cell_id: 'setup', new_source: 'x = 4' }
      const asked = await askFile({ tool: notebookTool, input, servers: [ide.server] })
      await asked.screen.until(frame => frame.includes('+x = 4'), 'the cell diff')
      expect(asked.screen.text()).not.toContain('Opened changes')
      expect(await reply(asked, ['1'])).toEqual(allowedWith(input, [], undefined))
      expect(ide.seen).toEqual([])
    },
    SLOW,
  )
})
