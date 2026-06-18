import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// Capture real modules before mocking so afterAll can restore them — otherwise
// the partial fsOperations mock (only `stat`, and reset to return undefined by
// afterEach) leaks into every later test file that calls getFsImplementation().
const realPdf = { ...(await import('./pdf.js')) }
const realFsOperations = { ...(await import('./fsOperations.js')) }

const pdfPageCountFake = mock(async (_: string) => null as number | null)
const fsStatFake = mock(async (_: string) =>
  ({ size: 0, mtimeMs: 0 } as { size: number; mtimeMs: number }),
)

mock.module('src/utils/pdf.js', () => ({
  getPDFPageCount: pdfPageCountFake,
  isAvailable: () => false,
}))

mock.module('src/utils/fsOperations.js', () => ({
  getFsImplementation: () => ({
    stat: fsStatFake,
  }),
}))

import { tryGetPDFReference } from './attachments.js'

// Scope: covers tryGetPDFReference, the lightweight reference path used by
// generateFileAttachment for large PDFs on @-mention. The richer
// generateFileAttachment branches (deny rule, already_read dedup,
// FileReadTool happy path) require deep fs/permission mocks that risk
// destabilizing the test runner — they're covered indirectly by
// FileReadTool's own test suite and the @-mention integration tests.

describe('tryGetPDFReference', () => {
  beforeEach(() => {
    pdfPageCountFake.mockReset()
    fsStatFake.mockReset()
    pdfPageCountFake.mockImplementation(async () => null)
    fsStatFake.mockImplementation(async () => ({ size: 0, mtimeMs: 0 }))
  })

  afterEach(() => {
    pdfPageCountFake.mockReset()
    fsStatFake.mockReset()
  })

  test('non-PDF extension returns null without touching fs', async () => {
    const out = await tryGetPDFReference('/tmp/foo.txt')
    expect(out).toBeNull()
    expect(fsStatFake).not.toHaveBeenCalled()
    expect(pdfPageCountFake).not.toHaveBeenCalled()
  })

  test('PDF with pageCount <= threshold (10) returns null', async () => {
    pdfPageCountFake.mockImplementation(async () => 10)
    fsStatFake.mockImplementation(async () => ({ size: 1024, mtimeMs: 0 }))
    expect(await tryGetPDFReference('/tmp/small.pdf')).toBeNull()
  })

  test('PDF with pageCount > threshold returns a pdf_reference attachment', async () => {
    pdfPageCountFake.mockImplementation(async () => 50)
    fsStatFake.mockImplementation(async () => ({ size: 5 * 1024 * 1024, mtimeMs: 0 }))
    const out = await tryGetPDFReference('/tmp/big.pdf')
    expect(out).toEqual({
      type: 'pdf_reference',
      filename: '/tmp/big.pdf',
      pageCount: 50,
      fileSize: 5 * 1024 * 1024,
      displayPath: expect.any(String),
    })
  })

  test('PDF without pdfinfo: falls back to ~100KB/page heuristic; returns reference when computed pages > 10', async () => {
    pdfPageCountFake.mockImplementation(async () => null)
    // 2 MB → ceil(2_097_152 / 102_400) = 21 pages > 10 → reference
    fsStatFake.mockImplementation(async () => ({ size: 2 * 1024 * 1024, mtimeMs: 0 }))
    const out = await tryGetPDFReference('/tmp/no-pdfinfo.pdf')
    expect(out?.type).toBe('pdf_reference')
    expect(out?.pageCount).toBe(21)
  })

  test('PDF without pdfinfo and small enough: heuristic yields ≤ 10 pages → null', async () => {
    pdfPageCountFake.mockImplementation(async () => null)
    // 500 KB → ceil(512_000 / 102_400) = 5 pages → null
    fsStatFake.mockImplementation(async () => ({ size: 500 * 1024, mtimeMs: 0 }))
    expect(await tryGetPDFReference('/tmp/tiny.pdf')).toBeNull()
  })

  test('stat throws (file missing): swallowed, returns null', async () => {
    fsStatFake.mockImplementation(async () => {
      throw new Error('ENOENT')
    })
    expect(await tryGetPDFReference('/tmp/missing.pdf')).toBeNull()
  })

  test('upper-case extension is normalized (.PDF treated as PDF)', async () => {
    pdfPageCountFake.mockImplementation(async () => 100)
    fsStatFake.mockImplementation(async () => ({ size: 1024, mtimeMs: 0 }))
    const out = await tryGetPDFReference('/tmp/REPORT.PDF')
    expect(out?.type).toBe('pdf_reference')
  })
})

afterAll(() => {
  mock.module('./pdf.js', () => realPdf)
  mock.module('src/utils/pdf.js', () => realPdf)
  mock.module('./fsOperations.js', () => realFsOperations)
  mock.module('src/utils/fsOperations.js', () => realFsOperations)
})
