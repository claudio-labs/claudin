// A tool's error reaches the model whole, wired through the real tool loop:
// under its tool's line as it was thrown, past it paged like any result —
// never cut in the middle, where a failing run keeps what failed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import { formatError } from 'src/agent/tools/toolErrors.js'
import { runToolUse } from 'src/agent/tools/toolExecution.js'
import { pageErrorText } from 'src/agent/tools/toolResultStorage.js'
import { ShellError } from 'src/shared/errors.js'
import { buildTool, getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { createFileStateCacheWithSizeLimit } from 'src/shared/fs/fileStateCache.js'

// A paged error is saved: keep it out of the real config dir.
const prevConfigDir = process.env.CLAUDIN_CONFIG_DIR
const testConfigDir = join(tmpdir(), `claudin-error-paging-${process.pid}-${Date.now()}`)
beforeAll(() => {
  process.env.CLAUDIN_CONFIG_DIR = testConfigDir
  mkdirSync(testConfigDir, { recursive: true })
})
afterAll(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = prevConfigDir
  rmSync(testConfigDir, { recursive: true, force: true })
})

/** A failing run's output: `n` lines, the failure named only in the middle and at the end. */
function failingOutput(n: number): string {
  const lines = Array.from({ length: n }, (_, i) => `test ${i + 1} ${'.'.repeat(30)} ok`)
  lines[Math.floor(n / 2)] = 'FAIL src/money.test.ts > rounds half up: expected 634, received 641'
  lines.push('SUMMARY: 1 failed, ' + (n - 1) + ' passed')
  return lines.join('\n')
}

/** The page's line count and the saved file, from a paged error. */
function readPage(text: string): { shown: number; page: string; file: string } {
  const shown = Number(/^Lines 1-(\d+) are below; Read the file with offset=\d+ and limit=\d+ for the next page\.$/m.exec(text)![1])
  const path = /Full output saved to: (\S+)\n/.exec(text)![1]!
  const page = text.slice(text.indexOf('\n\n') + 2, text.indexOf('\n</persisted-output>'))
  return { shown, page, file: readFileSync(path, 'utf8') }
}

describe('formatError', () => {
  test('keeps every char of a long error — the old 5k + 5k cut is gone', () => {
    const output = failingOutput(1_000)
    expect(output.length).toBeGreaterThan(30_000)
    const text = formatError(new ShellError('', output, 1, false))
    expect(text).toBe(`Exit code 1\n${output}`)
    expect(text).not.toContain('characters truncated')
  })
})

describe('pageErrorText', () => {
  test('whole while it fits the line, untouched with no line at all', async () => {
    const text = `Exit code 1\n${failingOutput(300)}`
    expect(text.length).toBeGreaterThan(10_000)
    expect(await pageErrorText(text, 30_000)).toBe(text)
    expect(await pageErrorText(text, Infinity)).toBe(text)
  })

  test('past the line it is paged: page + the saved file from the pointer = the error', async () => {
    const text = `Exit code 1\n${failingOutput(2_000)}`
    const paged = await pageErrorText(text, 30_000)
    expect(paged.length).toBeLessThanOrEqual(30_000)
    const { shown, page, file } = readPage(paged)
    expect(file).toBe(text)
    const lines = file.split('\n')
    expect([...page.split('\n'), ...lines.slice(shown)]).toEqual(lines)
  })

  test('a failure repeated word for word names the same file and reads the same', async () => {
    const text = `Exit code 1\n${failingOutput(2_000)}`
    expect(await pageErrorText(text, 30_000)).toBe(await pageErrorText(text, 30_000))
  })
})

describe('an error in the tool loop', () => {
  function failingTool(output: string, maxResultSizeChars: number) {
    return buildTool({
      name: 'FailProbe',
      maxResultSizeChars,
      async description() {
        return 'probe'
      },
      async prompt() {
        return 'probe'
      },
      get inputSchema() {
        return z.strictObject({})
      },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async checkPermissions(input: Record<string, never>) {
        return { behavior: 'allow' as const, updatedInput: input }
      },
      async call() {
        throw new ShellError('', output, 1, false)
      },
      mapToolResultToToolResultBlockParam(data: string, toolUseID: string) {
        return { type: 'tool_result' as const, tool_use_id: toolUseID, content: data }
      },
      renderToolUseMessage: () => null,
    })
  }

  /** The tool_result the loop hands the model for a run that fails with `output`. */
  async function errorResult(output: string, maxResultSizeChars: number): Promise<{ text: string; isError: boolean }> {
    const tool = failingTool(output, maxResultSizeChars)
    const toolUse = { type: 'tool_use' as const, id: `toolu_fail_${output.length}`, name: 'FailProbe', input: {} }
    const assistant = { type: 'assistant', uuid: 'a-fail', message: { id: 'msg_fail', role: 'assistant', content: [toolUse] } }
    const toolPermissionContext = getEmptyToolPermissionContext()
    const context = {
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(10),
      messages: [],
      options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true, mainLoopModel: 'claude-opus-5-5' },
      getAppState: () => ({ toolPermissionContext, sessionHooks: new Map() }),
      setAppState: () => {},
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
    } as unknown as ToolUseContext
    const allow = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
    for await (const update of runToolUse(toolUse as never, assistant as never, allow, context)) {
      const content = (update as { message?: { message?: { content?: unknown } } }).message?.message?.content
      if (!Array.isArray(content)) continue
      const block = content.find((b: { type?: string }) => b.type === 'tool_result') as { content: string; is_error?: boolean } | undefined
      if (block) return { text: String(block.content), isError: block.is_error === true }
    }
    throw new Error('no tool_result')
  }

  test('a 15k failure under a 30k line reaches the model whole, middle and end', async () => {
    const output = failingOutput(400)
    expect(output.length).toBeGreaterThan(10_000)
    const { text, isError } = await errorResult(output, 30_000)
    expect(isError).toBe(true)
    expect(text).toContain('FAIL src/money.test.ts > rounds half up')
    expect(text).toContain(output)
  })

  test('a failure past its line is paged, and the saved file holds the middle and the end', async () => {
    const output = failingOutput(3_000)
    const { text, isError } = await errorResult(output, 10_000)
    expect(isError).toBe(true)
    expect(text).toStartWith('<persisted-output>')
    expect(text).not.toContain('characters truncated')
    const { file } = readPage(text)
    expect(file).toBe(`Exit code 1\n${output}`)
    expect(file).toContain('SUMMARY: 1 failed')
  })
})
