import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getToolRowIcons } from 'src/agent/ui/messages/toolRowIcons.js'
import { EXTENSION_ICONS, GENERIC_FILE_ICON, ICON_COLORS } from 'src/terminal/fileIcons.js'

// hasNerdFontGlyphs resolves CLAUDIN_NERD_FONT before anything else, so the
// env pins both arms regardless of the terminal running the suite.
let saved: string | undefined
beforeEach(() => {
  saved = process.env.CLAUDIN_NERD_FONT
  process.env.CLAUDIN_NERD_FONT = '1'
})
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDIN_NERD_FONT
  else process.env.CLAUDIN_NERD_FONT = saved
})

const tool = (name: string, isMcp?: boolean) => ({ name, isMcp })

describe('getToolRowIcons — without a Nerd Font', () => {
  test('returns no icon at all, so the row renders as before', () => {
    process.env.CLAUDIN_NERD_FONT = '0'
    expect(getToolRowIcons(tool('Bash'), { command: 'ls' })).toEqual({})
    expect(getToolRowIcons(tool('Edit'), { file_path: '/r/a.ts' })).toEqual({})
    expect(getToolRowIcons(tool('mcp__x__y', true), {})).toEqual({})
  })
})

describe('getToolRowIcons — tool icon', () => {
  test.each([
    ['Bash', '\u{f018d}'],
    ['PowerShell', '\u{f018d}'],
    ['Read', '\u{f09ee}'],
    ['Edit', '\u{f0dc9}'],
    ['Patch', '\u{f0dc9}'],
    ['NotebookEdit', '\u{f0dc9}'],
    ['Write', '\u{f0eed}'],
    ['Grep', '\u{f0349}'],
    ['Glob', '\u{f0c7d}'],
    ['WebFetch', '\u{f059f}'],
    ['WebSearch', '\u{f059f}'],
    ['Agent', '\u{f06a9}'],
    ['Task', '\u{f06a9}'],
    ['SendMessage', '\u{f06a9}'],
    ['ListAgents', '\u{f06a9}'],
    ['Git', '\u{f062c}'],
    ['TaskCreate', '\u{f0756}'],
    ['TaskUpdate', '\u{f0756}'],
    ['TaskGet', '\u{f0756}'],
    ['TaskList', '\u{f0756}'],
    ['TaskStop', '\u{f0756}'],
    ['TaskOutput', '\u{f0756}'],
    ['TodoWrite', '\u{f0756}'],
    ['Build', '\u{f1323}'],
    ['RunTests', '\u{f0096}'],
    ['Typecheck', '\u{f0694}'],
    ['Container', '\u{f0868}'],
    ['EnterPlanMode', '\u{f0982}'],
    ['ExitPlanMode', '\u{f0982}'],
    ['Skill', '\u{f140b}'],
    ['Monitor', '\u{f051f}'],
    ['WaitFor', '\u{f051f}'],
    ['Workflow', '\u{f1049}'],
    ['ListWorkflows', '\u{f1049}'],
    ['WorkflowStatus', '\u{f1049}'],
    ['AskUserQuestion', '\u{f1739}'],
  ])('%s', (name, icon) => {
    expect(getToolRowIcons(tool(name), {}).toolIcon).toBe(icon)
  })

  test('every MCP tool shares the puzzle, whatever its name', () => {
    expect(getToolRowIcons(tool('mcp__context7__resolve', true), {}).toolIcon).toBe('\u{f0431}')
    // isMcp wins over a name that happens to match a built-in.
    expect(getToolRowIcons(tool('Bash', true), {}).toolIcon).toBe('\u{f0431}')
  })

  test('an unmapped tool gets the generic icon, never none', () => {
    expect(getToolRowIcons(tool('LSP'), {}).toolIcon).toBe('\u{f1064}')
    expect(getToolRowIcons(tool('CronCreate'), {}).toolIcon).toBe('\u{f1064}')
  })
})

describe('getToolRowIcons — file icon', () => {
  test('a single-file tool gets its file type icon and color', () => {
    const ts = EXTENSION_ICONS['.ts']!
    for (const name of ['Read', 'Edit', 'Write']) {
      expect(getToolRowIcons(tool(name), { file_path: '/repo/src/a.ts' }).fileIcon).toEqual({
        glyph: ts,
        color: ICON_COLORS[ts],
      })
    }
  })

  test('NotebookEdit reads notebook_path, not file_path', () => {
    expect(getToolRowIcons(tool('NotebookEdit'), { notebook_path: '/r/n.ipynb' }).fileIcon).toEqual({
      glyph: GENERIC_FILE_ICON,
      color: undefined,
    })
    expect(getToolRowIcons(tool('NotebookEdit'), { file_path: '/r/a.ts' }).fileIcon).toBeUndefined()
  })

  test('no file icon without one named file', () => {
    // A batch Read names several files, and its summary says so.
    expect(getToolRowIcons(tool('Read'), { file_paths: ['/r/a.ts', '/r/b.ts'] }).fileIcon).toBeUndefined()
    expect(getToolRowIcons(tool('Read'), { file_path: '' }).fileIcon).toBeUndefined()
    expect(getToolRowIcons(tool('Read'), { file_path: 42 }).fileIcon).toBeUndefined()
    expect(getToolRowIcons(tool('Read'), undefined).fileIcon).toBeUndefined()
    expect(getToolRowIcons(tool('Read'), null).fileIcon).toBeUndefined()
  })

  test('a tool that is not a single-file tool never gets one, even with a file_path', () => {
    expect(getToolRowIcons(tool('Patch'), { file_path: '/r/a.ts' }).fileIcon).toBeUndefined()
    expect(getToolRowIcons(tool('Grep'), { file_path: '/r/a.ts' }).fileIcon).toBeUndefined()
  })
})
