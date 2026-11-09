import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
// GlobTool re-exports GrepTool's renderer; loading it first is what keeps the
// import cycle in the order the tool registry loads them.
import 'src/tools/GlobTool/GlobTool.js'
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js'

// Grep refusals from the 2026-11-04..09 census, replayed on a fixture with the
// same shape: several paths sent in one `path` string, and a pattern that
// holds `\n` sent without `multiline`.

let root: string
let outside: string
// The permission path reaches MACRO.VERSION (bundledSkillsRoot.ts), which only
// the build defines.
const globals = globalThis as unknown as { MACRO?: { VERSION: string } }
const priorMacro = globals.MACRO

beforeAll(() => {
  globals.MACRO = { ...priorMacro, VERSION: priorMacro?.VERSION ?? 'test' }
  root = mkdtempSync(join(tmpdir(), 'grep-census-'))
  outside = mkdtempSync(join(tmpdir(), 'grep-census-outside-'))
  for (const [file, body] of [
    ['src/tools/BuildTool/BuildTool.ts', 'const maxAttempts = 3\n'],
    ['src/tools/RunTestsTool/RunTestsTool.ts', 'retry the failed suite\n'],
    ['src/tools/BashTool/BashTool.ts', 'one attempt only\n'],
    ['src/tools/GitTool/GitTool.ts', 'no retry here either\n'],
    ['src/vcs/diff/ui/DiffDialog.tsx', "setRevertPrompt(null)\nconst askToRevertHunk = 1\nconst other = 'diff:revertHunk'\n"],
    ['src/tools/FileWriteTool/prompt.ts', 'Prefer the Edit tool\nIf this is an existing file\n'],
    ['literal.txt', 'a\\n stays two characters\n'],
    ['my dir/spaced.ts', 'const maxAttempts = 1\n'],
  ] as const) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), body)
  }
  writeFileSync(join(outside, 'far.ts'), 'retry from afar\n')
})

afterAll(() => {
  if (priorMacro === undefined) delete globals.MACRO
  else globals.MACRO = priorMacro
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const emptyPermissionContext = {
  mode: 'default' as const,
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: false,
}

function contextWith(toolPermissionContext: object = emptyPermissionContext): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

type GrepData = { filenames: string[]; content?: string; numFiles: number }

async function grep(input: Record<string, unknown>, context = contextWith()): Promise<GrepData> {
  const { data } = await runWithCwdOverride(root, () => GrepTool.call(input as never, context))
  return data as GrepData
}

const pieces = (...rel: string[]) => rel.map(r => join(root, r)).join(' ')

describe('several paths in one `path`', () => {
  // 2b5c3f37 2026-11-08T13:59, in an Explore sub-agent.
  // A function: the fixture root exists only once beforeAll has run.
  const census = () => ({
    pattern: 'retry|retries|maxAttempts|attempt',
    path: pieces('src/tools/BuildTool', 'src/tools/RunTestsTool', 'src/tools/BashTool'),
  })

  test('2b5c3f37 11-08: validateInput takes three paths that each exist', async () => {
    const verdict = await runWithCwdOverride(root, () =>
      GrepTool.validateInput!(census() as never, contextWith()),
    )
    expect(verdict).toEqual({ result: true })
  })

  test('2b5c3f37 11-08: the search covers all three and nothing beside them', async () => {
    const data = await grep(census())
    expect(data.filenames.map(f => basename(f)).sort()).toEqual([
      'BashTool.ts',
      'BuildTool.ts',
      'RunTestsTool.ts',
    ])
  })

  test('content mode relativizes the lines of every path', async () => {
    const data = await grep({ ...census(), output_mode: 'content' })
    expect(data.content!.split('\n').sort()).toEqual([
      'src/tools/BashTool/BashTool.ts:1:one attempt only',
      'src/tools/BuildTool/BuildTool.ts:1:const maxAttempts = 3',
      'src/tools/RunTestsTool/RunTestsTool.ts:1:retry the failed suite',
    ])
  })

  test('30177640 11-09: one missing piece is named as the one that does not exist', async () => {
    const missing = join(root, 'src/tools/NopeTool')
    const verdict = await runWithCwdOverride(root, () =>
      GrepTool.validateInput!(
        { pattern: 'enabled', path: `${pieces('src/tools/BuildTool', 'src/tools/GitTool')} ${missing}` } as never,
        contextWith(),
      ),
    )
    expect(verdict.result).toBe(false)
    if (verdict.result === false) expect(verdict.message).toContain(`Path does not exist: ${missing}.`)
  })

  test('a deny rule on any piece denies the call', async () => {
    const decision = await runWithCwdOverride(root, () =>
      GrepTool.checkPermissions(
        census() as never,
        contextWith({
          ...emptyPermissionContext,
          alwaysDenyRules: { cliArg: [`Read(/${root}/src/tools/BashTool/**)`] },
        }),
      ),
    )
    expect(decision.behavior).toBe('deny')
  })

  test('a piece outside the working directories asks, the others inside allow', async () => {
    const inside = await runWithCwdOverride(root, () =>
      GrepTool.checkPermissions(census() as never, contextWith()),
    )
    expect(inside.behavior).toBe('allow')
    const mixed = await runWithCwdOverride(root, () =>
      GrepTool.checkPermissions({ ...census(), path: `${census().path} ${outside}` } as never, contextWith()),
    )
    expect(mixed.behavior).toBe('ask')
  })

  describe('what must not change', () => {
    test('a directory whose name has a space is one path when it exists whole', async () => {
      const data = await grep({ pattern: 'maxAttempts', path: join(root, 'my dir') })
      expect(data.filenames.map(f => basename(f))).toEqual(['spaced.ts'])
    })

    test('a single missing path keeps its message', async () => {
      const verdict = await runWithCwdOverride(root, () =>
        GrepTool.validateInput!({ pattern: 'x', path: join(root, 'gone') } as never, contextWith()),
      )
      expect(verdict.result).toBe(false)
      if (verdict.result === false) expect(verdict.message).toContain(`Path does not exist: ${join(root, 'gone')}.`)
    })
  })
})

describe('a pattern that holds \\n', () => {
  test('2b5c3f37 11-08 16:47: the alternation with setRevertPrompt\\(null\\)\\n finds its lines', async () => {
    const data = await grep({
      pattern:
        "resolveWorkspaceRoots,|planHunkRevert, revertHunk|const scanBases|setRevertPrompt\\(null\\)\\n|const askToRevertHunk|'diff:revertHunk'|setRever",
      path: join(root, 'src/vcs'),
      output_mode: 'content',
    })
    expect(data.content).toContain('setRevertPrompt(null)')
    expect(data.content).toContain('const askToRevertHunk = 1')
    expect(data.content).toContain("'diff:revertHunk'")
  })

  test('2b5c3f37 11-08 14:07: a phrase pair joined by \\n', async () => {
    const data = await grep({
      pattern: 'Prefer the Edit tool\\nIf this is an existing file',
      path: join(root, 'src/tools'),
      output_mode: 'files_with_matches',
    })
    expect(data.filenames.map(f => basename(f))).toEqual(['prompt.ts'])
  })

  describe('what must not change', () => {
    test('an escaped backslash before n is a literal \\n, searched line by line', async () => {
      const data = await grep({ pattern: 'a\\\\n stays', path: root, output_mode: 'content' })
      expect(data.content).toBe('literal.txt:1:a\\n stays two characters')
    })

    test('multiline: true asked for explicitly behaves as before', async () => {
      const data = await grep({
        pattern: 'null\\)\\nconst ask',
        path: join(root, 'src/vcs'),
        multiline: true,
        output_mode: 'files_with_matches',
      })
      expect(data.filenames.map(f => basename(f))).toEqual(['DiffDialog.tsx'])
    })
  })
})
