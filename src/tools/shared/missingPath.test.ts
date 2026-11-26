// A missing path is the most common tool error of 2026-10..11: Grep 37 and
// Read 7 times, nearly all in sub-agents guessing where a file lives (an old
// layout, a sibling directory), and none got a "Did you mean". These cases are
// the census's own misses, replayed on a fixture tree with the same shape.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from 'src/shared/fs/fileStateCache.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
// GlobTool re-exports GrepTool's renderer; loading it first keeps the import
// cycle in the order the tool registry loads them.
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js'
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js'
import { missingPathHint } from 'src/tools/shared/missingPath.js'

let root = ''
let elsewhere = ''
const globals = globalThis as unknown as { MACRO?: { VERSION: string } }
const priorMacro = globals.MACRO
const priorSimple = process.env.CLAUDIN_SIMPLE

beforeAll(() => {
  globals.MACRO = { ...priorMacro, VERSION: priorMacro?.VERSION ?? 'test' }
  process.env.CLAUDIN_SIMPLE = '1'
  root = mkdtempSync(join(tmpdir(), 'missing-path-'))
  elsewhere = mkdtempSync(join(tmpdir(), 'missing-path-elsewhere-'))
  for (const file of [
    'src/shared/proc/Shell.ts',
    'src/platform/bootstrap/state.ts',
    'src/tools/FileReadTool/batchRead.ts',
    'src/tools/FileReadTool/batchRead.test.ts',
    'src/skills/bundled/batch.ts',
    'a/index.ts',
    'b/index.ts',
    'c/index.ts',
    'd/index.ts',
    'x/util.ts',
    'y/util.ts',
    'secrets/prod.env.json',
  ]) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), 'export {}\n')
  }
})

afterAll(() => {
  if (priorMacro === undefined) delete globals.MACRO
  else globals.MACRO = priorMacro
  if (priorSimple === undefined) delete process.env.CLAUDIN_SIMPLE
  else process.env.CLAUDIN_SIMPLE = priorSimple
  rmSync(root, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

function context(toolPermissionContext: ToolPermissionContext = getEmptyToolPermissionContext()): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

async function grepRefusal(rel: string): Promise<string> {
  const verdict = await runWithCwdOverride(root, () =>
    GrepTool.validateInput!({ pattern: 'x', path: join(root, rel) } as never, context()),
  )
  return verdict.result === false ? verdict.message : '(accepted)'
}

describe('Grep names the likely path', () => {
  test('a file under another directory: the one with the same name', async () => {
    expect(await grepRefusal('src/platform/shell/Shell.ts')).toContain(
      `Did you mean ${join(root, 'src/shared/proc/Shell.ts')}?`,
    )
  })

  test('a directory that moved: the one with the same name', async () => {
    expect(await grepRefusal('src/bootstrap')).toContain(`Did you mean ${join(root, 'src/platform/bootstrap')}?`)
  })

  test('a name cut short: the sibling it starts, before a same name far away', async () => {
    const message = await grepRefusal('src/tools/FileReadTool/batch.ts')
    expect(message).toContain(`Did you mean ${join(root, 'src/tools/FileReadTool/batchRead.ts')}?`)
    expect(message).not.toContain('bundled')
  })

  describe('what must not change', () => {
    test('a name shared by more than three files gets no guess', async () => {
      const message = await grepRefusal('e/index.ts')
      expect(message).toContain('Path does not exist')
      expect(message).not.toContain('Did you mean')
    })

    test('a path outside the working directory gets no guess', async () => {
      const verdict = await runWithCwdOverride(root, () =>
        GrepTool.validateInput!({ pattern: 'x', path: join(elsewhere, 'Shell.ts') } as never, context()),
      )
      expect(verdict.result === false && verdict.message).not.toContain('Did you mean')
    })
  })
})

describe('Read, Glob and Edit name it the same way', () => {
  test('Read', async () => {
    const reading = runWithCwdOverride(root, () =>
      FileReadTool.call(
        { file_path: join(root, 'src/platform/shell/Shell.ts') },
        context(),
        undefined as never,
        undefined as never,
      ),
    )
    await expect(reading).rejects.toThrow(`Did you mean ${join(root, 'src/shared/proc/Shell.ts')}?`)
  })

  test('Glob', async () => {
    const verdict = await runWithCwdOverride(root, () =>
      GlobTool.validateInput!({ pattern: '*.ts', path: join(root, 'src/bootstrap') } as never, context()),
    )
    expect(verdict.result === false && verdict.message).toContain(`Did you mean ${join(root, 'src/platform/bootstrap')}?`)
  })

  test('Edit', async () => {
    const verdict = await runWithCwdOverride(root, () =>
      FileEditTool.validateInput(
        { file_path: join(root, 'src/platform/shell/Shell.ts'), old_string: 'x', new_string: 'y' },
        context(),
      ),
    )
    expect(verdict.result === false && verdict.message).toContain(`Did you mean ${join(root, 'src/shared/proc/Shell.ts')}?`)
  })
})

// 2026-11-26 review: the listing took no permission context, so a missing
// name could be answered with a path the session's Read deny rules hide.
describe('a path the Read deny rules hide is never named', () => {
  const denying = (): ToolPermissionContext => ({
    ...getEmptyToolPermissionContext(),
    alwaysDenyRules: { cliArg: [`Read(/${root}/secrets/**)`] },
  })

  test('Grep, with the rule and without it', async () => {
    const missing = { pattern: 'x', path: join(root, 'config/prod.env.json') } as never
    const open = await runWithCwdOverride(root, () => GrepTool.validateInput!(missing, context()))
    expect(open.result === false && open.message).toContain(`Did you mean ${join(root, 'secrets/prod.env.json')}?`)
    const denied = await runWithCwdOverride(root, () => GrepTool.validateInput!(missing, context(denying())))
    expect(denied.result === false && denied.message).not.toContain('secrets')
  })

  test('a sibling the rules hide is not named either', async () => {
    const missing = join(root, 'secrets/prod.json')
    const open = await runWithCwdOverride(root, () => missingPathHint(missing, getEmptyToolPermissionContext()))
    expect(open).toBe(` Did you mean ${join(root, 'secrets/prod.env.json')}?`)
    expect(await runWithCwdOverride(root, () => missingPathHint(missing, denying()))).toBe('')
  })

  test('Read', async () => {
    const message = await runWithCwdOverride(root, () =>
      FileReadTool.call({ file_path: join(root, 'config/prod.env.json') }, context(denying()), undefined as never, undefined as never),
    ).then(
      () => '(read)',
      (e: Error) => e.message,
    )
    expect(message).toContain('File does not exist')
    expect(message).not.toContain('secrets')
  })
})

describe('missingPathHint, in order', () => {
  const open = getEmptyToolPermissionContext()
  const hint = (rel: string, listFiles?: (root: string) => Promise<string[]>) =>
    runWithCwdOverride(root, () => missingPathHint(join(root, rel), open, listFiles))

  test('a dropped cwd folder comes first', async () => {
    const dropped = join(root, '..', 'src/shared/proc/Shell.ts')
    expect(await runWithCwdOverride(root, () => missingPathHint(dropped, open))).toBe(
      ` Did you mean ${join(root, 'src/shared/proc/Shell.ts')}?`,
    )
  })

  test('then the same name with another extension, as a bare name', async () => {
    expect(await hint('src/shared/proc/Shell.js')).toBe(' Did you mean Shell.ts?')
  })

  test('then the siblings the name starts, leaving tests out', async () => {
    expect(await hint('src/tools/FileReadTool/batch.ts')).toBe(
      ` Did you mean ${join(root, 'src/tools/FileReadTool/batchRead.ts')}?`,
    )
  })

  test('then up to three paths with the same name, shortest first', async () => {
    expect(await hint('z/util.ts')).toBe(` Did you mean ${join(root, 'x/util.ts')} or ${join(root, 'y/util.ts')}?`)
  })

  test('nothing when the listing has nothing', async () => {
    expect(await hint('src/platform/shell/Shell.ts', async () => [])).toBe('')
  })
})
