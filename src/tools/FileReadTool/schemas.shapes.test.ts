import { describe, expect, test } from 'bun:test'
// The process-wide instance, for the shapes no flag changes. This file loads
// no cache-busted instance (readMultiFlag.ts): with one in the same file,
// bun's coverage reports that instance and these lines read as never run.
import { inputSchema, outputSchema } from 'src/tools/FileReadTool/schemas.js'

describe('Read input schema — offset and limit', () => {
  test('a numeric string is a number, and the bounds hold', () => {
    const schema = inputSchema()
    expect(schema.parse({ file_path: '/a.ts', offset: '0', limit: '5' })).toEqual({
      file_path: '/a.ts',
      offset: 0,
      limit: 5,
    })
    expect(schema.safeParse({ file_path: '/a.ts', offset: -1 }).success).toBe(false)
    expect(schema.safeParse({ file_path: '/a.ts', limit: -1 }).success).toBe(false)
    expect(schema.safeParse({ file_path: '/a.ts', limit: 1.5 }).success).toBe(false)
  })
})

// What the result renderer parses a stored result with
// (UserToolSuccessMessage.tsx): a key the schema leaves out reaches it as
// undefined, and a type it does not list is not drawn at all.
describe('Read output schema', () => {
  const output = () => outputSchema()

  const results = {
    text: {
      type: 'text',
      file: { filePath: '/a.ts', content: 'x', numLines: 1, startLine: 1, totalLines: 1 },
    },
    image: {
      type: 'image',
      file: {
        base64: 'AA==',
        type: 'image/png',
        originalSize: 2,
        dimensions: { originalWidth: 4, originalHeight: 4, displayWidth: 2, displayHeight: 2 },
      },
    },
    notebook: { type: 'notebook', file: { filePath: '/a.ipynb', cells: [{ cell_type: 'code' }] } },
    pdf: { type: 'pdf', file: { filePath: '/a.pdf', base64: 'AA==', originalSize: 2 } },
    parts: {
      type: 'parts',
      file: { filePath: '/a.pdf', originalSize: 2, count: 3, outputDir: '/tmp/parts' },
    },
    file_unchanged: { type: 'file_unchanged', file: { filePath: '/a.ts' } },
    outline: {
      type: 'outline',
      file: {
        filePath: '/a.ts',
        content: '1-3 function a()',
        totalLines: 3,
        symbolCount: 1,
        autoPivot: true,
        preview: false,
      },
    },
    clip_pin_fallback: {
      type: 'clip_pin_fallback',
      file: { filePath: '/a.ts', message: 'stub', servedOutline: false },
    },
    batch: {
      type: 'batch',
      files: [{ filePath: '/a.ts', lines: 3 }],
      notShown: ['/b.ts'],
      content: '==> /a.ts <==',
    },
  } as const

  for (const [type, result] of Object.entries(results)) {
    test(`a ${type} result parses whole`, () => {
      expect(output().parse(result)).toEqual(result)
    })
  }

  test('an image keeps parsing without its dimensions', () => {
    const { dimensions: _dimensions, ...file } = results.image.file
    expect(output().safeParse({ type: 'image', file }).success).toBe(true)
  })

  test('refuses an unknown type, a media type it does not draw and a missing field', () => {
    const schema = output()
    expect(schema.safeParse({ type: 'video', file: { filePath: '/a.mp4' } }).success).toBe(false)
    expect(
      schema.safeParse({ ...results.image, file: { ...results.image.file, type: 'image/tiff' } })
        .success,
    ).toBe(false)
    const { content: _content, ...noContent } = results.text.file
    expect(schema.safeParse({ type: 'text', file: noContent }).success).toBe(false)
  })
})
