/**
 * Characterization of the dialog that asks before a path-taking tool (Read,
 * Glob, Grep) touches the filesystem. Written before the clean-base rewrite
 * of permissions/fileDialogs; the spec is
 * docs/tech/rewrite/permissions/fileDialogs.md.
 *
 * The three routed tools are read-only. The dialog also handles a tool that
 * is not, and falls back to the tool-wide dialog when the tool gives no path;
 * no routed tool reaches either today, so those are mounted directly with a
 * real tool given a different answer to the one question that matters.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { FilesystemPermissionRequest } from 'src/permissions/ui/FilesystemPermissionRequest/FilesystemPermissionRequest.js'
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
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js'
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js'
import type { Tool } from 'src/tools/Tool.js'

const world = isolatedWorld()
const { enter, esc, tab, down } = KEYS
const asTool = (tool: unknown) => tool as Tool

const visible = (frame: string) =>
  frame
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^─+$/.test(line))

const readRule = (dir: string) => ({ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: `/${dir}/**` }], behavior: 'allow', destination: 'session' })

describe('FilesystemPermissionRequest: what it shows', () => {
  type Row = { name: string; tool: Tool; input: (w: World) => Record<string, unknown>; expected: (w: World) => string[] }
  const rows: Row[] = [
    {
      name: 'Read inside the project',
      tool: asTool(FileReadTool),
      input: w => ({ file_path: put(join(w.project, 'a.ts'), 'a') }),
      expected: () => ['Read file', 'Read(a.ts)', 'Do you want to proceed?', '❯ 1. Yes', '2. Yes, during this session', '3. No', 'Esc to cancel · Tab to amend'],
    },
    {
      name: 'Read outside names the folder',
      tool: asTool(FileReadTool),
      input: w => ({ file_path: join(w.home, 'docs', 'x.md') }),
      expected: w => ['Read file', `Read(${join(w.home, 'docs', 'x.md')})`, 'Do you want to proceed?', '❯ 1. Yes', '2. Yes, allow reading from docs/ during this session', '3. No', 'Esc to cancel · Tab to amend'],
    },
    {
      name: 'Grep with no path: the shell directory',
      tool: asTool(GrepTool),
      input: () => ({ pattern: 'TODO' }),
      expected: () => ['Read file', 'Search(pattern: "TODO")', 'Do you want to proceed?', '❯ 1. Yes', '2. Yes, during this session', '3. No', 'Esc to cancel · Tab to amend'],
    },
    {
      name: 'Glob on a folder that exists outside: that folder is named',
      tool: asTool(GlobTool),
      input: w => {
        mkdirSync(join(w.home, 'assets'))
        return { pattern: '*.png', path: join(w.home, 'assets') }
      },
      expected: w => ['Read file', `Search(pattern: "*.png", path: "${join(w.home, 'assets')}")`, 'Do you want to proceed?', '❯ 1. Yes', '2. Yes, allow reading from assets/ during this session', '3. No', 'Esc to cancel · Tab to amend'],
    },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const w = world()
        startIn(w.project)
        const { screen } = await askFile({ tool: row.tool, input: row.input(w) })
        expect(visible(screen.text())).toEqual(row.expected(w))
      },
      SLOW,
    )
  }

  test(
    'a tool that writes: "Edit file" and the edit options',
    async () => {
      const w = world()
      startIn(w.project)
      const writer = asTool({ ...FileReadTool, isReadOnly: () => false })
      const file = join(w.home, 'gen', 'out.txt')
      const { screen } = await askFile({ tool: writer, input: { file_path: file }, direct: FilesystemPermissionRequest })
      expect(visible(screen.text())).toEqual([
        'Edit file',
        `Read(${file})`,
        'Do you want to proceed?',
        '❯ 1. Yes',
        '2. Yes, allow all edits in gen/ during this session (shift+tab)',
        '3. No',
        'Esc to cancel · Tab to amend',
      ])
    },
    SLOW,
  )

  const pathless: Array<[string, Tool]> = [
    ['a tool whose path lookup throws', asTool({ ...FileReadTool, getPath: () => { throw new Error('no path') } })],
    ['a tool with no path lookup', asTool({ ...FileReadTool, getPath: undefined })],
  ]
  for (const [name, tool] of pathless) {
    test(
      `${name}: the tool-wide dialog instead`,
      async () => {
        const w = world()
        startIn(w.project)
        const asked = await askFile({ tool, input: { file_path: join(w.project, 'a.ts') }, direct: FilesystemPermissionRequest })
        expect(visible(asked.screen.text())[0]).toBe('Tool use')
        expect(choices(asked.screen.text())[1]).toBe(`2. Yes, and don't ask again for Read commands in ${w.project}`)
      },
      SLOW,
    )
  }
})

describe('FilesystemPermissionRequest: what each answer reports', () => {
  type Row = { name: string; keys: string[]; calls: (input: unknown, w: World) => unknown[] }
  const rows: Row[] = [
    { name: 'Yes', keys: ['1'], calls: i => allowedWith(i, [], undefined) },
    { name: 'Yes with a note', keys: [tab, ...'only the head', enter], calls: i => allowedWith(i, [], 'only the head') },
    { name: 'the session option: a Read rule on the folder', keys: ['2'], calls: (i, w) => allowedWith(i, [readRule(join(w.home, 'docs'))], undefined) },
    { name: 'shift+tab: the same', keys: [SHIFT_TAB], calls: (i, w) => allowedWith(i, [readRule(join(w.home, 'docs'))], undefined) },
    { name: 'No', keys: ['3'], calls: () => deniedWith(undefined) },
    { name: 'No with a note', keys: [down, down, tab, ...'not that one', enter], calls: () => deniedWith('not that one') },
    { name: 'Esc', keys: [esc], calls: () => deniedWith(undefined) },
  ]
  for (const row of rows) {
    test(
      `a read outside, ${row.name}`,
      async () => {
        const w = world()
        startIn(w.project)
        const input = { file_path: join(w.home, 'docs', 'x.md') }
        const asked = await askFile({ tool: asTool(FileReadTool), input })
        expect(await reply(asked, row.keys)).toEqual(row.calls(input, w))
      },
      SLOW,
    )
  }

  test(
    'a search inside: the session option turns on accept-edits (spec, security finding)',
    async () => {
      const w = world()
      startIn(w.project)
      const asked = await askFile({ tool: asTool(GrepTool), input: { pattern: 'TODO' } })
      expect(await reply(asked, ['2'])).toEqual(allowedWith({ pattern: 'TODO' }, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], undefined))
    },
    SLOW,
  )

  test(
    'the input is reported as it was sent',
    async () => {
      const w = world()
      startIn(w.project)
      const input = { file_path: join(w.home, 'docs', 'x.md'), offset: '3', extra: true }
      const asked = await askFile({ tool: asTool(FileReadTool), input })
      expect(await reply(asked, ['1'])).toEqual(allowedWith(input, [], undefined))
    },
    SLOW,
  )

  test(
    'a tool that writes: the session option grants edits there',
    async () => {
      const w = world()
      startIn(w.project)
      const writer = asTool({ ...FileReadTool, isReadOnly: () => false })
      const input = { file_path: join(w.home, 'gen', 'out.txt') }
      const asked = await askFile({ tool: writer, input, direct: FilesystemPermissionRequest })
      expect(await reply(asked, ['2'])).toEqual(
        allowedWith(input, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, { type: 'addDirectories', directories: [join(w.home, 'gen')], destination: 'session' }], undefined),
      )
    },
    SLOW,
  )

  test(
    'a connected IDE is not used',
    async () => {
      const w = world()
      startIn(w.project)
      const ide = await standInIde()
      const input = { file_path: put(join(w.project, 'a.ts'), 'a') }
      const asked = await askFile({ tool: asTool(FileReadTool), input, servers: [ide.server] })
      expect(visible(asked.screen.text())[0]).toBe('Read file')
      expect(await reply(asked, ['1'])).toEqual(allowedWith(input, [], undefined))
      expect(ide.seen).toEqual([])
    },
    SLOW,
  )
})
