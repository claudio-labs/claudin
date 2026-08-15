import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from 'src/Tool.js'
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js'

let workDir: string
let notebookPath: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'notebookedit-'))
  notebookPath = join(workDir, 'fixture.ipynb')
  writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        {
          id: 'cell-a',
          cell_type: 'code',
          source: ['print("hi")'],
          metadata: {},
        },
      ],
      metadata: { kernelspec: { language: 'python' } },
      nbformat: 4,
      nbformat_minor: 5,
    }),
  )
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function makeCtx(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: true,
      },
    }),
    setAppState: () => {},
    options: {},
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

describe('NotebookEditTool', () => {
  test('shouldDefer is true and userFacingName is human-friendly', () => {
    expect(NotebookEditTool.shouldDefer).toBe(true)
    expect(NotebookEditTool.userFacingName()).toBe('Edit Notebook')
  })

  test('input schema requires notebook_path and new_source', () => {
    expect(NotebookEditTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      NotebookEditTool.inputSchema.safeParse({
        notebook_path: '/a.ipynb',
      }).success,
    ).toBe(false)
    expect(
      NotebookEditTool.inputSchema.safeParse({
        notebook_path: '/a.ipynb',
        new_source: 'print(1)',
      }).success,
    ).toBe(true)
  })

  test('input schema restricts edit_mode and cell_type to known values', () => {
    expect(
      NotebookEditTool.inputSchema.safeParse({
        notebook_path: '/a.ipynb',
        new_source: 's',
        edit_mode: 'rename',
      }).success,
    ).toBe(false)
    expect(
      NotebookEditTool.inputSchema.safeParse({
        notebook_path: '/a.ipynb',
        new_source: 's',
        cell_type: 'raw',
      }).success,
    ).toBe(false)
  })

  test('getPath returns the notebook_path verbatim', () => {
    expect(
      NotebookEditTool.getPath?.({
        notebook_path: '/a.ipynb',
        new_source: 's',
      } as never),
    ).toBe('/a.ipynb')
  })

  test('validateInput rejects non-.ipynb extension', async () => {
    const result = await NotebookEditTool.validateInput?.(
      {
        notebook_path: '/tmp/not-a-notebook.txt',
        new_source: 's',
      } as never,
      makeCtx(),
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(2)
    }
  })

  test('validateInput rejects edit_mode=insert without cell_type', async () => {
    const ctx = makeCtx()
    ctx.readFileState.set(notebookPath, {
      timestamp: Date.now() + 1_000_000,
      content: '',
    } as never)
    const result = await NotebookEditTool.validateInput?.(
      {
        notebook_path: notebookPath,
        new_source: 's',
        edit_mode: 'insert',
      } as never,
      ctx,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(5)
    }
  })

  test('validateInput requires read-before-edit', async () => {
    const result = await NotebookEditTool.validateInput?.(
      {
        notebook_path: notebookPath,
        new_source: 's',
      } as never,
      makeCtx(),
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(9)
    }
  })

  test('validateInput refuses a PARTIAL read, not just a missing one', async () => {
    // This gate used to check `!readTimestamp` alone, while its own comment
    // claimed parity with FileEditTool/FileWriteTool — both of which also
    // reject `isPartialView`. The clip-pin stand-down turned that gap into a
    // live data-loss path: renderClipPinHeadSlice returns '' for .ipynb by
    // design, so the fallback can leave an entry describing ZERO bytes of
    // content, and this gate was letting an edit through on it. The model
    // would be replacing a cell it had never seen.
    const ctx = makeCtx()
    ctx.readFileState.set(notebookPath, {
      timestamp: Date.now() + 1_000_000,
      content: '',
      isPartialView: true,
    } as never)
    const result = await NotebookEditTool.validateInput?.(
      {
        notebook_path: notebookPath,
        new_source: 's',
      } as never,
      ctx,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      // Same errorCode as the absent-entry case: from the model's side these
      // are the same situation — it has not seen the cells.
      expect(result.errorCode).toBe(9)
    }
  })

  test('mapToolResultToToolResultBlockParam renders all edit modes and errors', () => {
    const map = NotebookEditTool.mapToolResultToToolResultBlockParam
    const baseOut = {
      new_source: 's',
      cell_id: 'cell-a',
      cell_type: 'code' as const,
      language: 'python',
      notebook_path: '/a.ipynb',
      original_file: '',
      updated_file: '',
    }

    expect(
      map?.({ ...baseOut, edit_mode: 'replace' }, 'u')?.content,
    ).toContain('Updated cell cell-a')
    expect(
      map?.({ ...baseOut, edit_mode: 'insert' }, 'u')?.content,
    ).toContain('Inserted cell cell-a')
    expect(
      map?.({ ...baseOut, edit_mode: 'delete' }, 'u')?.content,
    ).toContain('Deleted cell cell-a')

    const err = map?.(
      { ...baseOut, edit_mode: 'replace', error: 'boom' },
      'u',
    )
    expect(err?.content).toBe('boom')
    expect(err?.is_error).toBe(true)
  })
})
