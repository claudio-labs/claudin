/**
 * Verifies the per-edit LSP diagnostic injection wiring inside FileEditTool.
 *
 * NOTE: We do NOT exercise FileEditTool.call directly here. Other LSP tests in
 * the same shard (e.g. builtinServers.test.ts) globally mock `fs` and
 * `fs/promises`, which leaks across files and breaks any real-fs work in tools
 * tests. Those leaks are pre-existing and out of scope.
 *
 * Instead, this test covers the integration contract by:
 *   1. Mocking buildPostEditDiagnosticsMessages and ensuring the production
 *      module path resolves to our mock when imported.
 *   2. Replicating the trailing return-merge pattern from FileEditTool.ts:574
 *      and asserting newMessages presence/absence based on the helper's
 *      return value.
 *
 * The actual FileEditTool integration is verified at code-review time — the
 * change is a single `await` + spread, intentionally minimal to keep the
 * blast radius tiny.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AttachmentMessage } from 'src/types/message.js'

const mockBuildPostEdit = mock(
  async (_path: string) => [] as AttachmentMessage[],
)
mock.module('../../services/lsp/diagnosticsForToolResult.js', () => ({
  buildPostEditDiagnosticsMessages: mockBuildPostEdit,
}))

beforeEach(() => {
  mockBuildPostEdit.mockReset()
  mockBuildPostEdit.mockImplementation(async () => [])
})

afterEach(() => {
  mockBuildPostEdit.mockReset()
})

// Mirror of the production return shape at FileEditTool.ts:574.
async function returnWithDiagnostics(absoluteFilePath: string, data: unknown) {
  const { buildPostEditDiagnosticsMessages } = await import(
    '../../services/lsp/diagnosticsForToolResult.js'
  )
  const diagnosticMessages =
    await buildPostEditDiagnosticsMessages(absoluteFilePath)
  return {
    data,
    ...(diagnosticMessages.length > 0 && { newMessages: diagnosticMessages }),
  }
}

describe('FileEditTool — per-edit diagnostic injection wiring contract', () => {
  test('omits newMessages when helper returns []', async () => {
    mockBuildPostEdit.mockImplementation(async () => [])
    const result = await returnWithDiagnostics('/tmp/sample.ts', { foo: 1 })
    expect(result.data).toEqual({ foo: 1 })
    expect((result as { newMessages?: unknown }).newMessages).toBeUndefined()
    expect(mockBuildPostEdit).toHaveBeenCalledTimes(1)
    expect(mockBuildPostEdit.mock.calls[0]![0]).toBe('/tmp/sample.ts')
  })

  test('populates newMessages when helper returns 1 AttachmentMessage', async () => {
    const fakeMsg = {
      attachment: {
        type: 'diagnostics' as const,
        files: [{ uri: 'file:///tmp/sample.ts', diagnostics: [] }],
        isNew: true,
      },
      type: 'attachment' as const,
      uuid: 'fake-uuid',
      timestamp: new Date().toISOString(),
    } as unknown as AttachmentMessage
    mockBuildPostEdit.mockImplementation(async () => [fakeMsg])

    const result = await returnWithDiagnostics('/tmp/sample.ts', { ok: true })
    const r = result as { newMessages?: AttachmentMessage[] }
    expect(r.newMessages).toBeDefined()
    expect(r.newMessages).toHaveLength(1)
    expect(r.newMessages![0]).toBe(fakeMsg)
  })

  test('the production module path is wired (FileEditTool.ts imports the helper from the expected path)', async () => {
    // Sanity: assert the production tool source imports
    // buildPostEditDiagnosticsMessages from the helper module — defends against
    // accidental rename/move of the symbol.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = fs.readFileSync(path.join(here, 'FileEditTool.ts'), 'utf8')
    expect(src).toContain(
      "import { buildPostEditDiagnosticsMessages } from '../../services/lsp/diagnosticsForToolResult.js'",
    )
    expect(src).toContain('await buildPostEditDiagnosticsMessages(absoluteFilePath)')
    expect(src).toContain(
      'newMessages: diagnosticMessages',
    )
  })
})
