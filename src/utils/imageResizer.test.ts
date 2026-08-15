import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ImageProcessorUnavailableError } from 'src/tools/FileReadTool/imageProcessor.js'

// Build a minimal PNG whose IHDR declares the given pixel dimensions. Only the
// bytes maybeResizeAndDownsampleImageBuffer's fallback inspects need to be
// valid: the 8-byte signature and the width/height at offsets 16/20.
function fakePng(width: number, height: number, padTo = 64): Buffer {
  const buf = Buffer.alloc(Math.max(padTo, 24))
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  buf.writeUInt32BE(13, 8) // IHDR length
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function mockProcessorUnavailable(): void {
  mock.module('src/tools/FileReadTool/imageProcessor.js', () => ({
    ImageProcessorUnavailableError,
    async getImageProcessor() {
      throw new ImageProcessorUnavailableError()
    },
    async getImageCreator() {
      throw new ImageProcessorUnavailableError()
    },
  }))
}

// A processor that is present but fails mid-resize (e.g. libvips rejects the
// input). This is NOT an ImageProcessorUnavailableError, so the fallback must
// NOT relax the dimension guard.
function mockProcessorThrowsGeneric(): void {
  mock.module('src/tools/FileReadTool/imageProcessor.js', () => ({
    ImageProcessorUnavailableError,
    async getImageProcessor() {
      throw new Error('vips: unsupported image format')
    },
    async getImageCreator() {
      throw new Error('vips: unsupported image format')
    },
  }))
}

describe('maybeResizeAndDownsampleImageBuffer — no image processor available', () => {
  afterEach(() => {
    mock.restore()
  })

  test('passes an oversized-dimension PNG through raw when under the 5MB base64 limit', async () => {
    mockProcessorUnavailable()
    const { maybeResizeAndDownsampleImageBuffer } = await import(
      'src/utils/imageResizer.js'
    )
    // Dimensions exceed the 1568px cap — the old code threw ImageResizeError
    // here (silent paste failure in the compiled binary). Now it must return
    // the raw buffer since the API downscales server-side.
    const png = fakePng(3000, 2000)
    const result = await maybeResizeAndDownsampleImageBuffer(
      png,
      png.length,
      'png',
    )
    expect(result.buffer).toBe(png)
    expect(result.mediaType).toBe('png')
  })

  test('throws a clear error when the image exceeds the 5MB base64 limit', async () => {
    mockProcessorUnavailable()
    const { maybeResizeAndDownsampleImageBuffer, ImageResizeError } =
      await import('src/utils/imageResizer.js')
    const png = fakePng(3000, 2000)
    // 4MB raw → ~5.33MB base64, over the hard API limit.
    const oversized = 4 * 1024 * 1024
    await expect(
      maybeResizeAndDownsampleImageBuffer(png, oversized, 'png'),
    ).rejects.toBeInstanceOf(ImageResizeError)
  })

  test('a generic (non-processor) resize error still respects the dimension guard', async () => {
    // Guards the swallow boundary: only ImageProcessorUnavailableError widens
    // the passthrough. A libvips/decode failure on an oversized-dimension PNG
    // (well under 5MB base64) must still reject, not leak the raw buffer.
    mockProcessorThrowsGeneric()
    const { maybeResizeAndDownsampleImageBuffer, ImageResizeError } =
      await import('src/utils/imageResizer.js')
    const png = fakePng(3000, 2000) // over the 1568px cap, only 64 bytes
    await expect(
      maybeResizeAndDownsampleImageBuffer(png, png.length, 'png'),
    ).rejects.toBeInstanceOf(ImageResizeError)
  })
})
