/**
 * Characterization of the dialog frame the edit, write, notebook and
 * filesystem requests share: which options it offers for a path, what the
 * session-wide option grants, how notes are written, and the symlink warning.
 * Written before the clean-base rewrite of permissions/fileDialogs; the spec
 * is docs/tech/rewrite/permissions/fileDialogs.md.
 *
 * The frame is reached through `PermissionRequest` with the real file tools,
 * on real files in a temp project. The per-tool screens and the IDE path are
 * pinned in the suites beside each request component.
 */
import { describe, expect, test } from 'bun:test'
import { symlinkSync } from 'fs'
import { join } from 'path'
import {
  getFilePermissionOptions,
  isInClaudeFolder,
  isInGlobalClaudeFolder,
} from 'src/permissions/ui/FilePermissionDialog/permissionOptions.js'
import { createSingleEditDiffConfig } from 'src/permissions/ui/FilePermissionDialog/ideDiffConfig.js'
import { isolatedWorld, KEYS, SLOW, type World } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { managedRulesOnly } from 'src/permissions/ui/__testutils__/toolDialogRig.js'
import {
  allowedWith,
  askFile,
  choices,
  deniedWith,
  hintLine,
  put,
  reply,
  SHIFT_TAB,
  startIn,
} from 'src/permissions/ui/__testutils__/fileDialogsRig.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { getEmptyToolPermissionContext, type Tool, type ToolPermissionContext } from 'src/tools/Tool.js'

const world = isolatedWorld()
const { enter, esc, tab, down, up } = KEYS
const write = FileWriteTool as unknown as Tool
const read = FileReadTool as unknown as Tool
const edit = FileEditTool as unknown as Tool

const setMode = (mode: string) => ({ type: 'setMode', mode, destination: 'session' })
const addDirs = (...directories: string[]) => ({ type: 'addDirectories', directories, destination: 'session' })
const editRule = (ruleContent: string) => ({
  type: 'addRules',
  rules: [{ toolName: 'Edit', ruleContent }],
  behavior: 'allow',
  destination: 'session',
})

function writeIn(w: World, path: string, content = 'body') {
  startIn(w.project)
  return { file_path: path, content }
}

describe('FilePermissionDialog: the options offered for a path', () => {
  const SESSION_HERE = '2. Yes, allow all edits during this session (shift+tab)'
  const OWN_SETTINGS = '2. Yes, and allow Claude to edit its own settings for this session'
  type Row = {
    name: string
    tool?: Tool
    path: (w: World) => string
    second: string
    permissions?: (w: World) => Partial<ToolPermissionContext>
    managed?: boolean
  }
  const rows: Row[] = [
    { name: 'a write inside the project', path: w => join(w.project, 'src', 'a.ts'), second: SESSION_HERE },
    { name: 'a write outside names the folder', path: w => join(w.home, 'out', 'a.ts'), second: '2. Yes, allow all edits in out/ during this session (shift+tab)' },
    { name: 'a write at the filesystem root names no folder', path: () => '/file-dialogs-never-there.txt', second: '2. Yes, allow all edits in this directory/ during this session (shift+tab)' },
    {
      name: 'a write in an added working directory counts as inside',
      path: w => join(w.home, 'extra', 'a.ts'),
      permissions: w => ({ additionalWorkingDirectories: new Map([[join(w.home, 'extra'), { path: join(w.home, 'extra'), source: 'session' }]]) as never }),
      second: SESSION_HERE,
    },
    { name: "a write in the project's .claudin", path: w => join(w.project, '.claudin', 'settings.json'), second: OWN_SETTINGS },
    { name: 'a write in the config home', path: w => join(w.config, 'agents', 'x.md'), second: OWN_SETTINGS },
    { name: 'the .claudin match ignores case', path: w => join(w.project, '.CLAUDIN', 'x.json'), second: OWN_SETTINGS },
    { name: 'a look-alike folder is not .claudin', path: w => join(w.project, '.claudin-old', 'x.json'), second: SESSION_HERE },
    { name: 'a nested .claudin is not the project one', path: w => join(w.project, 'pkg', '.claudin', 'x.json'), second: SESSION_HERE },
    { name: 'a read in .claudin gets the plain read option', tool: read, path: w => join(w.project, '.claudin', 'x.md'), second: '2. Yes, during this session' },
    { name: 'a read outside names the folder', tool: read, path: w => join(w.home, 'notes', 'x.md'), second: '2. Yes, allow reading from notes/ during this session' },
    { name: 'managed rules only: the session option stays', path: w => join(w.project, 'a.ts'), second: SESSION_HERE, managed: true },
    { name: 'managed rules only: the own-settings option stays', path: w => join(w.project, '.claudin', 'x.json'), second: OWN_SETTINGS, managed: true },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const w = world()
        startIn(w.project)
        if (row.managed) managedRulesOnly(w.home)
        const tool = row.tool ?? write
        const input = tool === read ? { file_path: row.path(w) } : { file_path: row.path(w), content: 'body' }
        const { screen } = await askFile({ tool, input, permissions: row.permissions?.(w) })
        expect(choices(screen.text())).toEqual(['❯ 1. Yes', row.second, '3. No'])
        expect(hintLine(screen.text())).toBe('Esc to cancel · Tab to amend')
      },
      SLOW,
    )
  }
})

describe('FilePermissionDialog: what the session-wide option grants', () => {
  type Row = { name: string; tool?: Tool; path: (w: World) => string; mode?: ToolPermissionContext['mode']; grants: (w: World) => unknown[] }
  const rows: Row[] = [
    { name: 'inside, default mode: accept edits for the session', path: w => join(w.project, 'a.ts'), grants: () => [setMode('acceptEdits')] },
    { name: 'inside, plan mode: accept edits for the session', path: w => join(w.project, 'a.ts'), mode: 'plan', grants: () => [setMode('acceptEdits')] },
    { name: 'inside, already accepting edits: nothing', path: w => join(w.project, 'a.ts'), mode: 'acceptEdits', grants: () => [] },
    { name: 'inside, bypass mode: nothing', path: w => join(w.project, 'a.ts'), mode: 'bypassPermissions', grants: () => [] },
    { name: 'outside: accept edits and the folder, both for the session', path: w => join(w.home, 'out', 'a.ts'), grants: w => [setMode('acceptEdits'), addDirs(join(w.home, 'out'))] },
    { name: 'outside, already accepting edits: the folder alone', path: w => join(w.home, 'out', 'a.ts'), mode: 'acceptEdits', grants: w => [addDirs(join(w.home, 'out'))] },
    { name: "the project's .claudin: Edit on /.claudin/** for the session", path: w => join(w.project, '.claudin', 'settings.json'), grants: () => [editRule('/.claudin/**')] },
    { name: 'a case variant of .claudin: the same rule, naming the lower-case folder', path: w => join(w.project, '.Claudin', 'x.json'), grants: () => [editRule('/.claudin/**')] },
    { name: 'the config home: Edit on ~/.claudin/**, whatever folder the config home is', path: w => join(w.config, 'settings.json'), grants: () => [editRule('~/.claudin/**')] },
    { name: 'a read outside: a session Read rule on the folder', tool: read, path: w => join(w.home, 'notes', 'x.md'), grants: w => [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: `/${join(w.home, 'notes')}/**` }], behavior: 'allow', destination: 'session' }] },
    { name: 'a read inside: accept edits for the session (spec, security finding)', tool: read, path: w => join(w.project, 'a.ts'), grants: () => [setMode('acceptEdits')] },
  ]
  for (const row of rows) {
    for (const [how, keys] of [['2', ['2']], ['shift+tab', [SHIFT_TAB]]] as const) {
      test(
        `${row.name} (${how})`,
        async () => {
          const w = world()
          startIn(w.project)
          const tool = row.tool ?? write
          const input = tool === read ? { file_path: row.path(w) } : { file_path: row.path(w), content: 'body' }
          const asked = await askFile({ tool, input, permissions: { mode: row.mode ?? 'default' } })
          expect(await reply(asked, [...keys])).toEqual(allowedWith(input, row.grants(w), undefined))
          // The grant is reported, never applied here: the session's mode is untouched.
          expect(asked.screen.state().toolPermissionContext.mode).toBe(row.mode ?? 'default')
        },
        SLOW,
      )
    }
  }
})

describe('FilePermissionDialog: notes, keys and cancel', () => {
  type Row = { name: string; keys: string[]; calls: (input: unknown) => unknown[] }
  const rows: Row[] = [
    { name: 'Enter on Yes allows once with no note and nothing remembered', keys: [enter], calls: i => allowedWith(i, [], undefined) },
    { name: 'a Yes note goes with the allow, trimmed', keys: [tab, ...' go on ', enter], calls: i => allowedWith(i, [], 'go on') },
    { name: 'a blank Yes note is no note', keys: [tab, ' ', ' ', enter], calls: i => allowedWith(i, [], undefined) },
    { name: 'Tab twice closes the Yes note again', keys: [tab, tab, enter], calls: i => allowedWith(i, [], undefined) },
    { name: 'a No note goes with the deny, trimmed', keys: [down, down, tab, ...' not this ', enter], calls: () => deniedWith('not this') },
    { name: 'Up from Yes wraps to No', keys: [up, enter], calls: () => deniedWith(undefined) },
    { name: '3 denies with no note', keys: ['3'], calls: () => deniedWith(undefined) },
    { name: 'Esc denies and drops a written No note', keys: [down, down, tab, ...'why', esc], calls: () => deniedWith(undefined) },
    { name: 'Esc denies and drops a written Yes note', keys: [tab, ...'fine', esc], calls: () => deniedWith(undefined) },
    { name: 'a Yes note is not carried to No', keys: [tab, ...'note', down, down, enter], calls: () => deniedWith(undefined) },
    { name: 'the session option ignores a written Yes note', keys: [tab, ...'note', down, enter], calls: i => allowedWith(i, [setMode('acceptEdits')], undefined) },
    { name: 'y, n and a digit past the list do nothing', keys: ['y', 'n', '4'], calls: () => [] },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const w = world()
        const input = writeIn(w, join(w.project, 'notes.txt'))
        const asked = await askFile({ tool: write, input })
        expect(await reply(asked, row.keys)).toEqual(row.calls(input))
        expect(asked.screen.state().attribution.escapeCount).toBe(0)
      },
      SLOW,
    )
  }

  test(
    'Tab opens the note in place of the label, and the hint loses "Tab to amend"',
    async () => {
      const w = world()
      const asked = await askFile({ tool: write, input: writeIn(w, join(w.project, 'n.txt')) })
      await asked.screen.press(tab)
      expect(choices(asked.screen.text())[0]).toBe('❯ 1. Yes, and tell Claude what to do next')
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel')
      await asked.screen.press(...'keep it short')
      expect(choices(asked.screen.text())[0]).toBe('❯ 1. Yes, keep it short')
      await asked.screen.press(down, down, tab)
      expect(choices(asked.screen.text())).toEqual([
        '1. Yes, keep it short',
        '2. Yes, allow all edits during this session (shift+tab)',
        '❯ 3. No, and tell Claude what to do differently',
      ])
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel')
    },
    SLOW,
  )

  test(
    'moving off an empty note closes it; the session option shows no "Tab to amend"',
    async () => {
      const w = world()
      const asked = await askFile({ tool: write, input: writeIn(w, join(w.project, 'n.txt')) })
      await asked.screen.press(tab, down)
      expect(choices(asked.screen.text())[0]).toBe('1. Yes')
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel')
      await asked.screen.press(down, tab, up)
      expect(choices(asked.screen.text())[2]).toBe('3. No')
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel')
      await asked.screen.press(up)
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel · Tab to amend')
      await asked.screen.press(tab)
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel')
      expect(choices(asked.screen.text())[0]).toBe('❯ 1. Yes, and tell Claude what to do next')
      await asked.screen.press(tab)
      expect(choices(asked.screen.text())[0]).toBe('❯ 1. Yes')
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel · Tab to amend')
    },
    SLOW,
  )

  test(
    'the dialog counts one permission prompt and no escape',
    async () => {
      const w = world()
      const asked = await askFile({ tool: write, input: writeIn(w, join(w.project, 'n.txt')) })
      await asked.screen.until(() => asked.screen.state().attribution.permissionPromptCount === 1, 'the prompt count')
      await reply(asked, [esc])
      expect(asked.screen.state().attribution.escapeCount).toBe(0)
    },
    SLOW,
  )
})

describe('FilePermissionDialog: symlinks', () => {
  const warningOf = (frame: string) =>
    frame
      .replace(/\s+/g, ' ')
      .match(/(This will modify .* via a symlink|Symlink target: \S+)/)?.[1]

  test(
    'a link out of the working directory: the warning names the target',
    async () => {
      const w = world()
      const target = put(join(w.home, 'elsewhere', 'real.ts'), 'x\n')
      symlinkSync(target, join(w.project, 'link.ts'))
      const { screen } = await askFile({ tool: write, input: writeIn(w, join(w.project, 'link.ts'), 'y\n') })
      expect(warningOf(screen.text())).toBe(`This will modify ${target} (outside working directory) via a symlink`)
      // The session option is the link's own folder, the project.
      expect(choices(screen.text())[1]).toBe('2. Yes, allow all edits in project/ during this session (shift+tab)')
    },
    SLOW,
  )

  test(
    'a link inside: the target alone',
    async () => {
      const w = world()
      const target = put(join(w.project, 'src', 'in.ts'), 'q\n')
      symlinkSync(target, join(w.project, 'alias.ts'))
      startIn(w.project)
      const { screen } = await askFile({ tool: edit, input: { file_path: join(w.project, 'alias.ts'), old_string: 'q', new_string: 'r' } })
      expect(warningOf(screen.text())).toBe(`Symlink target: ${target}`)
    },
    SLOW,
  )

  test(
    '"outside" is measured from the shell\'s directory, not the project',
    async () => {
      const w = world()
      const target = put(join(w.project, 'src', 'in.ts'), 'q\n')
      symlinkSync(target, join(w.project, 'alias.ts'))
      startIn(join(w.project, 'deep'))
      const { screen } = await askFile({ tool: edit, input: { file_path: join(w.project, 'alias.ts'), old_string: 'q', new_string: 'r' } })
      expect(warningOf(screen.text())).toBe(`This will modify ${target} (outside working directory) via a symlink`)
    },
    SLOW,
  )

  test(
    'a read through a link shows no warning',
    async () => {
      const w = world()
      const target = put(join(w.home, 'elsewhere', 'real.ts'), 'x\n')
      symlinkSync(target, join(w.project, 'link.ts'))
      startIn(w.project)
      const { screen } = await askFile({ tool: read, input: { file_path: join(w.project, 'link.ts') } })
      expect(warningOf(screen.text())).toBeUndefined()
    },
    SLOW,
  )

  test(
    'a plain file shows no warning',
    async () => {
      const w = world()
      const { screen } = await askFile({ tool: write, input: writeIn(w, put(join(w.project, 'plain.ts'), 'p\n')) })
      expect(warningOf(screen.text())).toBeUndefined()
    },
    SLOW,
  )
})

describe('FilePermissionDialog: the exported helpers', () => {
  test('which paths are in the project or config-home .claudin folder', () => {
    const w = world()
    const cases: Array<[string, boolean, boolean]> = [
      [join(w.project, '.claudin', 'settings.json'), true, false],
      [join(w.project, '.claudin', 'a', 'b', 'c.md'), true, false],
      [join(w.project, '.claudin'), false, false],
      [join(w.project, '.claudin-old', 'x'), false, false],
      [join(w.project, 'sub', '.claudin', 'x'), false, false],
      [`${w.project}/.claudin/../src/a.ts`, false, false],
      [join(w.project, '.CLAUDIN', 'x'), true, false],
      [join(w.config, 'settings.json'), false, true],
      [w.config, false, false],
      [`${w.config}-other/x`, false, false],
      [join(w.config.toUpperCase(), 'x'), false, true],
    ]
    expect(cases.map(([path]) => [path, isInClaudeFolder(path), isInGlobalClaudeFolder(path)])).toEqual(cases)
  })

  test('the option list: values, kinds and the labels that are plain text', () => {
    const w = world()
    const context = getEmptyToolPermissionContext()
    const brief = (options: ReturnType<typeof getFilePermissionOptions>) =>
      options.map(o => [o.value, o.option, typeof o.label === 'string' ? o.label : 'rich', o.type ?? 'text'])
    expect(brief(getFilePermissionOptions({ filePath: join(w.project, 'a.ts'), toolPermissionContext: context, operationType: 'read' }))).toEqual([
      ['yes', { type: 'accept-once' }, 'Yes', 'text'],
      ['yes-session', { type: 'accept-session' }, 'Yes, during this session', 'text'],
      ['no', { type: 'reject' }, 'No', 'text'],
    ])
    expect(
      brief(getFilePermissionOptions({ filePath: join(w.config, 'x.json'), toolPermissionContext: context, operationType: 'create' })),
    ).toEqual([
      ['yes', { type: 'accept-once' }, 'Yes', 'text'],
      ['yes-claude-folder', { type: 'accept-session', scope: 'global-claude-folder' }, 'Yes, and allow Claude to edit its own settings for this session', 'text'],
      ['no', { type: 'reject' }, 'No', 'text'],
    ])
    // The default operation is a write; an input row needs both the flag and its handler.
    const noted = getFilePermissionOptions({
      filePath: join(w.project, '.claudin', 'x'),
      toolPermissionContext: context,
      yesInputMode: true,
      noInputMode: true,
      onAcceptFeedbackChange: () => {},
      onRejectFeedbackChange: () => {},
    })
    expect(brief(noted)).toEqual([
      ['yes', { type: 'accept-once' }, 'Yes', 'input'],
      ['yes-claude-folder', { type: 'accept-session', scope: 'claude-folder' }, 'Yes, and allow Claude to edit its own settings for this session', 'text'],
      ['no', { type: 'reject' }, 'No', 'input'],
    ])
    expect(noted.map(o => ('placeholder' in o ? o.placeholder : undefined))).toEqual([
      'and tell Claude what to do next',
      undefined,
      'and tell Claude what to do differently',
    ])
    const flagOnly = getFilePermissionOptions({ filePath: join(w.project, 'a'), toolPermissionContext: context, yesInputMode: true, noInputMode: true })
    expect(flagOnly.map(o => o.type ?? 'text')).toEqual(['text', 'text', 'text'])
  })

  test('the single-edit IDE config', () => {
    expect(createSingleEditDiffConfig('/p/a.ts', 'old', 'new', true)).toEqual({
      filePath: '/p/a.ts',
      edits: [{ old_string: 'old', new_string: 'new', replace_all: true }],
      editMode: 'single',
    })
    expect(createSingleEditDiffConfig('/p/b.ts', '', 'x').edits).toEqual([{ old_string: '', new_string: 'x', replace_all: undefined }])
  })
})
