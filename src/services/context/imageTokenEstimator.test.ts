import { describe, expect, test } from 'bun:test'

import {
  estimateImageTokens,
  IMAGE_TOKEN_FALLBACK,
  parseImageDimensions,
} from 'src/services/context/imageTokenEstimator.js'

// ------------------------------------------------------------------
// Synthetic image header builders. Each returns a base64 string with
// only the bytes parseImageDimensions needs (real pixel data omitted).
// ------------------------------------------------------------------

function pngHeader(width: number, height: number): string {
  const buf = Buffer.alloc(24)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // IHDR length (13) + 'IHDR'
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf.toString('base64')
}

function jpegHeader(width: number, height: number): string {
  // SOI + APP0 (16 bytes JFIF) + SOF0 (17 bytes incl marker)
  const parts: number[] = []
  parts.push(0xff, 0xd8) // SOI
  parts.push(0xff, 0xe0, 0x00, 0x10) // APP0 length 16
  parts.push(0x4a, 0x46, 0x49, 0x46, 0x00) // "JFIF\0"
  parts.push(0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00) // version + density
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08) // SOF0 marker, length 17, precision 8
  parts.push((height >> 8) & 0xff, height & 0xff)
  parts.push((width >> 8) & 0xff, width & 0xff)
  parts.push(0x03) // 3 components
  parts.push(0x01, 0x22, 0x00) // Y
  parts.push(0x02, 0x11, 0x01) // Cb
  parts.push(0x03, 0x11, 0x01) // Cr
  return Buffer.from(parts).toString('base64')
}

function webpVp8lHeader(width: number, height: number): string {
  // RIFF....WEBP VP8L <size:4> <0x2f> <4 packed bytes>.
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(22, 4) // chunk size (placeholder)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8L', 12, 'ascii')
  buf.writeUInt32LE(10, 16) // VP8L payload size
  buf.writeUInt8(0x2f, 20) // VP8L signature
  // Pack width-1 into 14 bits, height-1 into 14 bits, alpha+version in last 4 bits.
  const w = width - 1
  const h = height - 1
  buf.writeUInt8(w & 0xff, 21)
  buf.writeUInt8(((w >> 8) & 0x3f) | ((h & 0x03) << 6), 22)
  buf.writeUInt8((h >> 2) & 0xff, 23)
  buf.writeUInt8((h >> 10) & 0x0f, 24)
  return buf.toString('base64')
}

function gifHeader(width: number, height: number): string {
  const buf = Buffer.alloc(13)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf.toString('base64')
}

// ------------------------------------------------------------------
// parseImageDimensions
// ------------------------------------------------------------------

describe('parseImageDimensions', () => {
  test('reads PNG width/height from IHDR', () => {
    expect(parseImageDimensions(pngHeader(1024, 768), 'image/png')).toEqual({
      width: 1024,
      height: 768,
    })
  })

  test('reads JPEG dimensions from SOF0', () => {
    expect(parseImageDimensions(jpegHeader(640, 480), 'image/jpeg')).toEqual({
      width: 640,
      height: 480,
    })
  })

  test('reads WebP VP8L dimensions', () => {
    expect(parseImageDimensions(webpVp8lHeader(100, 100), 'image/webp')).toEqual({
      width: 100,
      height: 100,
    })
  })

  test('reads GIF dimensions (little-endian)', () => {
    expect(parseImageDimensions(gifHeader(50, 40), 'image/gif')).toEqual({
      width: 50,
      height: 40,
    })
  })

  test('returns null for truncated header', () => {
    const truncated = pngHeader(100, 100).slice(0, 8)
    expect(parseImageDimensions(truncated, 'image/png')).toBeNull()
  })

  test('returns null for unsupported media type', () => {
    expect(parseImageDimensions(pngHeader(10, 10), 'image/heic')).toBeNull()
  })

  test('returns null for empty data', () => {
    expect(parseImageDimensions('', 'image/png')).toBeNull()
  })
})

// ------------------------------------------------------------------
// estimateImageTokens — provider formulas
// ------------------------------------------------------------------

function base64Image(data: string): {
  type: 'base64'
  media_type: 'image/png'
  data: string
} {
  return { type: 'base64', media_type: 'image/png', data }
}

describe('estimateImageTokens — Anthropic family', () => {
  const png1024x768 = base64Image(pngHeader(1024, 768))
  // ceil(1024*768/750) = 1049
  const expected1024 = Math.ceil((1024 * 768) / 750)

  test('firstParty uses (w*h)/750', () => {
    expect(estimateImageTokens(png1024x768, 'firstParty')).toBe(expected1024)
  })

  test('bedrock matches Anthropic formula', () => {
    expect(estimateImageTokens(png1024x768, 'bedrock')).toBe(expected1024)
  })

  test('vertex matches Anthropic formula', () => {
    expect(estimateImageTokens(png1024x768, 'vertex')).toBe(expected1024)
  })

  test('foundry matches Anthropic formula', () => {
    expect(estimateImageTokens(png1024x768, 'foundry')).toBe(expected1024)
  })

  test('caps at 5333 for huge images', () => {
    const huge = base64Image(pngHeader(2400, 2400))
    expect(estimateImageTokens(huge, 'firstParty')).toBe(5333)
  })
})

describe('estimateImageTokens — Gemini', () => {
  test('small images cost a single 258-token tile', () => {
    const small = base64Image(pngHeader(100, 100))
    expect(estimateImageTokens(small, 'gemini')).toBe(258)
  })

  test('384x384 boundary still counts as a single tile', () => {
    const boundary = base64Image(pngHeader(384, 384))
    expect(estimateImageTokens(boundary, 'gemini')).toBe(258)
  })

  test('larger images bill 258 per 768x768 tile', () => {
    // ceil(1600/768) * ceil(900/768) * 258 = 3 * 2 * 258 = 1548
    const large = base64Image(pngHeader(1600, 900))
    expect(estimateImageTokens(large, 'gemini')).toBe(1548)
  })
})

describe('estimateImageTokens — OpenAI tile formula', () => {
  test('1024x1024 → 85 + 170*4 = 765', () => {
    const square = base64Image(pngHeader(1024, 1024))
    expect(estimateImageTokens(square, 'openai')).toBe(765)
  })

  test('256x256 → 85 + 170*1 = 255', () => {
    const small = base64Image(pngHeader(256, 256))
    expect(estimateImageTokens(small, 'openai')).toBe(255)
  })

  test('nvidia-nim follows the OpenAI formula', () => {
    const square = base64Image(pngHeader(1024, 1024))
    expect(estimateImageTokens(square, 'nvidia-nim')).toBe(765)
  })
})

describe('estimateImageTokens — Mistral / Minimax', () => {
  test('mistral returns the empirical midpoint', () => {
    const img = base64Image(pngHeader(1024, 768))
    expect(estimateImageTokens(img, 'mistral')).toBe(1100)
  })

  test('minimax matches mistral', () => {
    const img = base64Image(pngHeader(1024, 768))
    expect(estimateImageTokens(img, 'minimax')).toBe(1100)
  })
})

// ------------------------------------------------------------------
// Fallback paths — must preserve legacy 2000-token behavior.
// ------------------------------------------------------------------

describe('estimateImageTokens — fallbacks', () => {
  test('URL source returns the legacy fallback', () => {
    const url = { type: 'url' as const, url: 'https://example.com/x.png' }
    expect(estimateImageTokens(url, 'firstParty')).toBe(IMAGE_TOKEN_FALLBACK)
  })

  test('unparsable base64 returns the legacy fallback', () => {
    const garbage = base64Image('not-real-png-data')
    expect(estimateImageTokens(garbage, 'firstParty')).toBe(IMAGE_TOKEN_FALLBACK)
  })

  test('empty data returns the legacy fallback', () => {
    expect(estimateImageTokens(base64Image(''), 'gemini')).toBe(
      IMAGE_TOKEN_FALLBACK,
    )
  })
})
