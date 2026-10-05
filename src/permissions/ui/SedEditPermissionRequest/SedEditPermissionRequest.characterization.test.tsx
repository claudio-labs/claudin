/**
 * Characterization of the dialog a `sed -i` command gets instead of the Bash
 * one, written before the clean-base rewrite of permissions/shellDialogs. The
 * spec is docs/tech/rewrite/permissions/shellDialogs.md.
 *
 * Reached the way the REPL reaches it: a Bash request whose command is an
 * in-place sed edit. The dialog reads the real file, shows the edit as a diff,
 * and an allow hands the tool the new content to write in place of running
 * sed. The file frame it draws in belongs to permissions/fileDialogs; what is
 * pinned here is what each answer reports for a sed edit.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getCwdState, setCwdState } from 'src/platform/bootstrap/state.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import type { Tool } from 'src/tools/Tool.js'
import { flat, isolatedWorld, KEYS, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { answer, ask, type Call, shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'

const world = isolatedWorld()
const { enter, esc, tab, down } = KEYS
const SHIFT_TAB = '\x1B[Z'
const typed = (text: string) => [...text]

let cwdBefore = ''
beforeEach(() => {
  cwdBefore = getCwdState()
  setCwdState(world().project)
})
afterEach(() => setCwdState(cwdBefore))

/** Writes `body` at `rel` under the project and returns its absolute path. */
function fileIn(base: string, rel: string, body: string): string {
  const path = join(base, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  return path
}

const askSed = (command: string, extra: Record<string, unknown> = {}) =>
  ask({ tool: BashTool as unknown as Tool, input: { command, ...extra }, permissionResult: { behavior: 'ask', message: 'edit needs approval' } })

const optionLines = (frame: string) => shown(frame).filter(line => /^(❯ )?\d\./.test(line))
/** The input an allow hands on: the request's own, plus the edit to make. */
const withEdit = (input: Record<string, unknown>, filePath: string, newContent: string) => ({ ...input, _simulatedSedEdit: { filePath, newContent } })
const acceptEdits = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }

describe('SedEditPermissionRequest: what it shows', () => {
  test(
    'the file frame: title, path from the working directory, the diff, the question naming the file, options and hint',
    async () => {
      const path = fileIn(world().project, 'src/greet.txt', 'hello foo\nbar foo\n')
      const asked = await askSed(`sed -i 's/foo/baz/' ${path}`)
      const lines = shown(await asked.screen.until(frame => frame.includes('+hello baz'), 'the diff'))
      expect(lines[1]).toBe('Edit file')
      expect(lines[2]).toBe('src/greet.txt')
      expect(lines.filter(line => /^\d+ [-+ ]/.test(line))).toEqual(['1 -hello foo', '1 +hello baz', '2  bar foo'])
      expect(lines.slice(-5)).toEqual([
        'Do you want to make this edit to greet.txt?',
        '❯ 1. Yes',
        '2. Yes, allow all edits during this session (shift+tab)',
        '3. No',
        'Esc to cancel · Tab to amend',
      ])
    },
    SLOW,
  )

  const notes: Array<[string, string, (p: string) => string, string]> = [
    ['a pattern that matches nothing', 'hello\n', p => `sed -i 's/zzz/y/' ${p}`, 'Pattern did not match any content'],
    ['a file that does not exist', '', p => `sed -i 's/a/b/' ${p}.gone`, 'File does not exist'],
  ]
  for (const [name, body, command, note] of notes) {
    test(
      `${name}: no diff, a note instead`,
      async () => {
        const path = fileIn(world().project, 'note.txt', body)
        const asked = await askSed(command(path))
        expect(shown(asked.screen.text())).toContain(note)
        expect(asked.screen.text()).toContain('Do you want to make this edit to')
      },
      SLOW,
    )
  }

  test(
    'a sed that does not edit in place is an ordinary Bash command',
    async () => {
      const path = fileIn(world().project, 'a.txt', 'foo\n')
      const asked = await askSed(`sed -n 's/foo/bar/p' ${path}`)
      expect(shown(asked.screen.text())[1]).toBe('Bash command')
    },
    SLOW,
  )

  test(
    'outside the working directory the session option names the folder',
    async () => {
      const path = fileIn(world().home, 'elsewhere/o.txt', 'foo\n')
      const asked = await askSed(`sed -i 's/foo/baz/' ${path}`)
      expect(shown(asked.screen.text())[2]).toBe('../elsewhere/o.txt')
      expect(optionLines(asked.screen.text())[1]).toBe('2. Yes, allow all edits in elsewhere/ during this session (shift+tab)')
    },
    SLOW,
  )

  test(
    'inside the project .claudin folder the session option is about its own settings',
    async () => {
      const path = fileIn(world().project, '.claudin/rules/x.md', 'foo\n')
      const asked = await askSed(`sed -i 's/foo/baz/' ${path}`)
      expect(optionLines(asked.screen.text())[1]).toBe('2. Yes, and allow Claude to edit its own settings for this session')
    },
    SLOW,
  )
})

describe('SedEditPermissionRequest: what each answer reports', () => {
  type Row = { name: string; keys: string[]; calls: (input: Record<string, unknown>, path: string) => Call[]; argc?: number }
  const NEW = 'hello baz\nbar foo\n'
  const allowedWith = (updates: unknown[], note?: string) => (input: Record<string, unknown>, path: string): Call[] => [
    { to: 'caller.done' },
    { to: 'allow', args: [withEdit(input, path, NEW), updates, note] },
  ]
  const rejectedWith = (note?: string): Call[] => [{ to: 'caller.done' }, { to: 'caller.reject' }, { to: 'reject', args: [note] }]
  const rows: Row[] = [
    { name: 'Enter on Yes: the edit, nothing saved, no note; the caller hears first', keys: [enter], calls: allowedWith([]), argc: 3 },
    { name: '1: the same', keys: ['1'], calls: allowedWith([]) },
    { name: 'Yes with a note: the note, trimmed', keys: [tab, ...typed('  check it  '), enter], calls: allowedWith([], 'check it') },
    { name: '2: the edit, and edits accepted for the rest of the session', keys: ['2'], calls: allowedWith([acceptEdits]) },
    { name: 'shift+tab: the same as 2', keys: [SHIFT_TAB], calls: allowedWith([acceptEdits]) },
    { name: '3: deny, with one empty note argument', keys: ['3'], calls: () => rejectedWith(undefined), argc: 1 },
    { name: 'No with a note: the note, trimmed', keys: [down, down, tab, ...typed(' not that one '), enter], calls: () => rejectedWith('not that one') },
    { name: 'Esc: the same deny as 3', keys: [esc], calls: () => rejectedWith(undefined), argc: 1 },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const path = fileIn(world().project, 'a.txt', 'hello foo\nbar foo\n')
        const input = { command: `sed -i 's/foo/baz/' ${path}`, description: 'rename foo' }
        const asked = await askSed(input.command, { description: input.description })
        const calls = await answer(asked, row.keys)
        expect(calls).toEqual(row.calls(input, path))
        const reported = calls.find(call => call.to === 'allow' || call.to === 'reject') as { args: unknown[] }
        if (row.argc !== undefined) expect(reported.args).toHaveLength(row.argc)
        // Unlike the Bash dialog, no answer here counts as an escape.
        expect(asked.screen.state().attribution.escapeCount).toBe(0)
      },
      SLOW,
    )
  }

  type Content = { name: string; body: string; command: (p: string) => string; target?: (p: string) => string; content: string }
  const contents: Content[] = [
    { name: 'the g flag replaces every match', body: 'a a\na\n', command: p => `sed -i 's/a/b/g' ${p}`, content: 'b b\nb\n' },
    { name: 'Windows line endings come back as \\n', body: 'foo\r\nfoo\r\n', command: p => `sed -i 's/foo/baz/g' ${p}`, content: 'baz\nbaz\n' },
    { name: 'no match: the content unchanged', body: 'hello\n', command: p => `sed -i 's/zzz/y/' ${p}`, content: 'hello\n' },
    { name: 'a missing file: empty content', body: '', command: p => `sed -i 's/a/b/' ${p}.gone`, target: p => `${p}.gone`, content: '' },
  ]
  for (const row of contents) {
    test(
      `Yes hands on the new content: ${row.name}`,
      async () => {
        const path = fileIn(world().project, 'c.txt', row.body)
        const command = row.command(path)
        const asked = await askSed(command)
        const calls = await answer(asked, ['1'])
        expect(calls[1]).toEqual({ to: 'allow', args: [withEdit({ command }, row.target?.(path) ?? path, row.content), [], undefined] })
      },
      SLOW,
    )
  }

  test(
    '2 outside the working directory: the session mode and the folder, both for this session only',
    async () => {
      const path = fileIn(world().home, 'elsewhere/o.txt', 'foo\n')
      const command = `sed -i 's/foo/baz/' ${path}`
      const asked = await askSed(command)
      expect((await answer(asked, ['2']))[1]).toEqual({
        to: 'allow',
        args: [withEdit({ command }, path, 'baz\n'), [acceptEdits, { type: 'addDirectories', directories: [join(world().home, 'elsewhere')], destination: 'session' }], undefined],
      })
    },
    SLOW,
  )

  test(
    '2 inside .claudin: an Edit rule for the project .claudin folder, for this session only',
    async () => {
      const path = fileIn(world().project, '.claudin/rules/x.md', 'foo\n')
      const command = `sed -i 's/foo/baz/' ${path}`
      const asked = await askSed(command)
      expect((await answer(asked, ['2']))[1]).toEqual({
        to: 'allow',
        args: [withEdit({ command }, path, 'baz\n'), [{ type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: '/.claudin/**' }], behavior: 'allow', destination: 'session' }], undefined],
      })
      expect(flat(asked.screen.text())).toContain('x.md')
    },
    SLOW,
  )
})
