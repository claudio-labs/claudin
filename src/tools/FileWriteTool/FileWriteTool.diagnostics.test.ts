/**
 * Verifies the per-edit LSP diagnostic injection wiring inside FileWriteTool
 * for both the create and update return paths.
 *
 * See FileEditTool.diagnostics.test.ts for the rationale on testing the
 * wiring contract instead of the full call() — global fs mocks from other
 * LSP tests in the shard prevent real-fs integration tests from running here.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AttachmentMessage } from 'src/types/message.js'

const realDiagnosticsWrite = { ...(await import('../../services/lsp/diagnosticsForToolResult.js')) }

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

afterAll(() => {
  mock.module('../../services/lsp/diagnosticsForToolResult.js', () => realDiagnosticsWrite)
})

// Mirror of the production return shape at FileWriteTool.ts (both create + update branches).
async function returnWithDiagnostics(
  absoluteFilePath: string,
  data: unknown,
): Promise<{ data: unknown; newMessages?: AttachmentMessage[] }> {
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

describe('FileWriteTool — per-edit diagnostic injection wiring contract', () => {
  test('omits newMessages on CREATE path when helper returns []', async () => {
    mockBuildPostEdit.mockImplementation(async () => [])
    const result = await returnWithDiagnostics('/tmp/new.ts', { type: 'create' })
    expect(result.data).toEqual({ type: 'create' })
    expect(result.newMessages).toBeUndefined()
    expect(mockBuildPostEdit).toHaveBeenCalledTimes(1)
  })

  test('populates newMessages on CREATE path when helper returns AttachmentMessages', async () => {
    const fakeMsg = {
      attachment: {
        type: 'diagnostics' as const,
        files: [{ uri: 'file:///tmp/new.ts', diagnostics: [] }],
        isNew: true,
      },
      type: 'attachment' as const,
      uuid: 'fake-uuid',
      timestamp: new Date().toISOString(),
    } as unknown as AttachmentMessage
    mockBuildPostEdit.mockImplementation(async () => [fakeMsg])

    const result = await returnWithDiagnostics('/tmp/new.ts', { type: 'create' })
    expect(result.newMessages).toBeDefined()
    expect(result.newMessages).toHaveLength(1)
    expect(result.newMessages![0]).toBe(fakeMsg)
  })

  test('omits newMessages on UPDATE path when helper returns []', async () => {
    mockBuildPostEdit.mockImplementation(async () => [])
    const result = await returnWithDiagnostics('/tmp/existing.ts', {
      type: 'update',
    })
    expect(result.data).toEqual({ type: 'update' })
    expect(result.newMessages).toBeUndefined()
  })

  test('populates newMessages on UPDATE path when helper returns AttachmentMessages', async () => {
    const fakeMsg = {
      attachment: {
        type: 'diagnostics' as const,
        files: [{ uri: 'file:///tmp/existing.ts', diagnostics: [] }],
        isNew: true,
      },
      type: 'attachment' as const,
      uuid: 'fake-uuid',
      timestamp: new Date().toISOString(),
    } as unknown as AttachmentMessage
    mockBuildPostEdit.mockImplementation(async () => [fakeMsg])

    const result = await returnWithDiagnostics('/tmp/existing.ts', {
      type: 'update',
    })
    expect(result.newMessages).toBeDefined()
    expect(result.newMessages).toHaveLength(1)
    expect(result.newMessages![0]).toBe(fakeMsg)
  })

  test('the production module path wires the helper into both branches', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = fs.readFileSync(path.join(here, 'FileWriteTool.ts'), 'utf8')

    // Helper imported.
    expect(src).toContain('buildPostEditDiagnosticsMessages')
    expect(src).toContain("from '../../services/lsp/diagnosticsForToolResult.js'")
    // Helper invoked once before the create/update branches.
    expect(src).toContain('await buildPostEditDiagnosticsMessages(fullFilePath)')
    expect(src).toContain('armFileForLateDiagnostics(fullFilePath, agentId)')
    // newMessages spread present in both return statements.
    const newMessagesSpreads = (
      src.match(/newMessages: diagnosticMessages/g) || []
    ).length
    expect(newMessagesSpreads).toBeGreaterThanOrEqual(2)
  })
})
