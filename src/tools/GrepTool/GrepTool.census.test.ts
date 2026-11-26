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
      GrepTool.validateInput!({
        pattern: 'enabled',
        path: `${pieces('src/tools/BuildTool', 'src/tools/GitTool')} ${missing}`,
      } as never, contextWith()),
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
    // The fixture root is a working directory the way an /add-dir makes one.
    const working = () =>
      contextWith({
        ...emptyPermissionContext,
        additionalWorkingDirectories: new Map([[root, { path: root, source: 'session' }]]),
      })
    const input = census()
    const inside = await runWithCwdOverride(root, () => GrepTool.checkPermissions(input as never, working()))
    expect(inside.behavior).toBe('allow')
    // The allow echoes the call's own input, every path in it.
    if (inside.behavior === 'allow') expect(inside.updatedInput).toEqual(input)
    const mixed = await runWithCwdOverride(root, () =>
      GrepTool.checkPermissions({ ...input, path: `${input.path} ${outside}` } as never, working()),
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

// The two parameters the model sent most often that Grep did not have, in
// 2026-10..11: `-o` six times (the route list, a format string), `exclude`
// four (Glob's own name for it).
describe('-o and exclude', () => {
  test('the schema takes both', () => {
    const parsed = GrepTool.inputSchema.safeParse({ pattern: 'x', '-o': true, exclude: ['*.test.ts'] })
    expect(parsed.success).toBe(true)
  })

  test('-o prints only the matched part of each line', async () => {
    const data = await grep({ pattern: 'askTo\\w+', path: join(root, 'src/vcs'), output_mode: 'content', '-o': true })
    expect(data.content).toBe('src/vcs/diff/ui/DiffDialog.tsx:2:askToRevertHunk')
  })

  test('-o is ignored outside content mode', async () => {
    const data = await grep({ pattern: 'askTo\\w+', path: join(root, 'src/vcs'), '-o': true })
    expect(data.filenames.map(f => basename(f))).toEqual(['DiffDialog.tsx'])
  })

  // 2026-11-26 review: '' became `--glob !`, which ripgrep reads as "skip
  // every file", and the search came back empty with no error.
  test('an empty exclude entry leaves nothing out', async () => {
    for (const exclude of [[''], ['!'], ['  ']]) {
      const found = await grep({ pattern: 'retry', path: root, exclude })
      expect({ exclude, files: found.filenames.length }).toEqual({ exclude, files: 2 })
    }
  })

  test('exclude leaves the globs out, as a list or as one string', async () => {
    const listed = await grep({ pattern: 'retry', path: root, exclude: ['src/tools/RunTestsTool/**'] })
    expect(listed.filenames.map(f => basename(f))).toEqual(['GitTool.ts'])
    // An entry written as a negation means the same thing.
    const negated = await grep({ pattern: 'retry', path: root, exclude: ['!src/tools/RunTestsTool/**'] })
    expect(negated.filenames.map(f => basename(f))).toEqual(['GitTool.ts'])
    // One string is split by the schema, as `glob` is, before call() sees it.
    const spelled = await grep(GrepTool.inputSchema.parse({ pattern: 'retry', path: root, exclude: 'src/tools/GitTool/**' }))
    expect(spelled.filenames.map(f => basename(f))).toEqual(['RunTestsTool.ts'])
    // Two globs in that string leave both files out, not one glob with a space in it.
    const both = await grep(
      GrepTool.inputSchema.parse({ pattern: 'retry', path: root, exclude: 'src/tools/GitTool/** src/tools/RunTestsTool/**' }),
    )
    expect(both.filenames).toEqual([])
  })

  test('an exclude naming a dotenv file never asks for one', async () => {
    const decision = await runWithCwdOverride(root, () =>
      GrepTool.checkPermissions(
        { pattern: 'x', path: root, exclude: ['.env', '*.env', '!*.test.*'] } as never,
        contextWith({
          ...emptyPermissionContext,
          additionalWorkingDirectories: new Map([[root, { path: root, source: 'session' }]]),
        }),
      ),
    )
    expect(decision.behavior).toBe('allow')
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
