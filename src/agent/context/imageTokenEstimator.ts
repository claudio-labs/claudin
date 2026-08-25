import type { Anthropic } from '@anthropic-ai/sdk'
import {
  type APIProvider,
  getAPIProvider,
  isGithubNativeAnthropicMode,
} from 'src/providers/model/providers.js'

// Conservative default kept identical to the previous hard-coded value so
// every fallback path (URL source, unknown provider, unparsable header,
// document blocks) lands on the legacy 2000 estimate. See
// services/tokenEstimation.ts:546-554 for the original justification.
export const IMAGE_TOKEN_FALLBACK = 2000

// Anthropic vision: tokens = (w*h)/750, capped at the 2000x2000 resize ceiling.
// https://docs.anthropic.com/en/docs/build-with-claude/vision#calculate-image-costs
const ANTHROPIC_PIXELS_PER_TOKEN = 750
const ANTHROPIC_MAX_TOKENS = 5333

// Gemini vision: <=384px on the long edge counts as a single 258-token tile,
// otherwise the image is split into 768x768 tiles each costing 258 tokens.
// https://ai.google.dev/gemini-api/docs/vision#technical-details-image
const GEMINI_TILE_PX = 768
const GEMINI_SMALL_THRESHOLD = 384
const GEMINI_TOKENS_PER_TILE = 258

// OpenAI gpt-4o family in high-detail mode: 85 base + 170 per 512x512 tile
// after scaling to fit 2048x2048 with the short side <=768. We always assume
// high detail because the Anthropic ImageBlockParam shape does not carry the
// detail flag and high is the worst case for compaction triggers.
// https://platform.openai.com/docs/guides/vision
const OPENAI_BASE_TOKENS = 85
const OPENAI_TOKENS_PER_TILE = 170
const OPENAI_TILE_PX = 512
const OPENAI_MAX_LONG_EDGE = 2048
const OPENAI_TARGET_SHORT_EDGE = 768

// Mistral / Minimax do not publish a precise vision token formula. 1100 is the
// empirical midpoint between Anthropic's per-pixel rate and OpenAI's tile
// rate for the typical 1024x768 screenshot, picked to bias auto-compact
// closer to reality than the legacy 2000 without underestimating.
const MISTRAL_FAMILY_TOKENS = 1100

export type ParsedImageDimensions = {
  width: number
  height: number
}

/**
 * Decode just enough of a base64 image to read its width and height from the
 * file header. Returns null when the media type is unsupported or the header
 * is malformed/truncated. Only PNG, JPEG, WebP and GIF are recognized — the
 * four formats Anthropic's Base64ImageSource accepts.
 */
export function parseImageDimensions(
  base64Data: string,
  mediaType: string,
): ParsedImageDimensions | null {
  if (!base64Data) {
    return null
  }
  // 96 base64 chars decode to ~72 bytes — enough for PNG IHDR, GIF logical
  // screen descriptor and the WebP RIFF header. JPEG needs to walk segments
  // so we decode a larger prefix for that branch only.
  const headerB64 = base64Data.slice(0, 128)
  let header: Buffer
  try {
    header = Buffer.from(headerB64, 'base64')
  } catch {
    return null
  }
  if (header.length < 10) {
    return null
  }

  switch (mediaType) {
    case 'image/png':
      return parsePng(header)
    case 'image/jpeg':
      return parseJpeg(base64Data)
    case 'image/webp':
      return parseWebp(header)
    case 'image/gif':
      return parseGif(header)
    default:
      return null
  }
}

function parsePng(header: Buffer): ParsedImageDimensions | null {
  // PNG signature (8 bytes) + IHDR length (4) + 'IHDR' (4) = 16, then width/height as big-endian uint32.
  if (
    header.length < 24 ||
    header[0] !== 0x89 ||
    header[1] !== 0x50 ||
    header[2] !== 0x4e ||
    header[3] !== 0x47
  ) {
    return null
  }
  const width = header.readUInt32BE(16)
  const height = header.readUInt32BE(20)
  if (!width || !height) {
    return null
  }
  return { width, height }
}

function parseJpeg(base64Data: string): ParsedImageDimensions | null {
  // JPEG SOFn markers can sit far past the first 64 bytes (after EXIF, etc.).
  // Decode up to 16 KB of header — base64 length 21844 ≈ 16383 bytes — which
  // covers virtually every real-world JPEG header without forcing the full
  // payload through Buffer.from.
  const sliceLen = Math.min(base64Data.length, 21844)
  let buf: Buffer
  try {
    buf = Buffer.from(base64Data.slice(0, sliceLen), 'base64')
  } catch {
    return null
  }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null
  }
  let offset = 2
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      return null
    }
    // Skip fill bytes (0xFF padding between markers).
    while (offset < buf.length && buf[offset] === 0xff) {
      offset += 1
    }
    const marker = buf[offset]
    offset += 1
    // SOF0..SOF15 except SOF4 (DHT), SOF8 (JPG), SOFC (DAC) hold frame info.
    const isSOF =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    const segmentLength = buf.readUInt16BE(offset)
    if (isSOF) {
      const height = buf.readUInt16BE(offset + 3)
      const width = buf.readUInt16BE(offset + 5)
      if (!width || !height) {
        return null
      }
      return { width, height }
    }
    offset += segmentLength
  }
  return null
}

function parseWebp(header: Buffer): ParsedImageDimensions | null {
  // RIFF....WEBP then chunk header. VP8 / VP8L / VP8X each store dimensions
  // differently. https://developers.google.com/speed/webp/docs/riff_container
  if (
    header.length < 30 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null
  }
  const chunk = header.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') {
    if (header.length < 30) return null
    const width = header.readUInt16LE(26) & 0x3fff
    const height = header.readUInt16LE(28) & 0x3fff
    return width && height ? { width, height } : null
  }
  if (chunk === 'VP8L') {
    if (header.length < 25) return null
    const b0 = header[21]
    const b1 = header[22]
    const b2 = header[23]
    const b3 = header[24]
    const width = 1 + (((b1 & 0x3f) << 8) | b0)
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    return width && height ? { width, height } : null
  }
  if (chunk === 'VP8X') {
    if (header.length < 30) return null
    const width = 1 + (header[24] | (header[25] << 8) | (header[26] << 16))
    const height = 1 + (header[27] | (header[28] << 8) | (header[29] << 16))
    return width && height ? { width, height } : null
  }
  return null
}

function parseGif(header: Buffer): ParsedImageDimensions | null {
  // 'GIF87a' or 'GIF89a' then little-endian uint16 width/height.
  if (header.length < 10 || header.toString('ascii', 0, 3) !== 'GIF') {
    return null
  }
  const width = header.readUInt16LE(6)
  const height = header.readUInt16LE(8)
  if (!width || !height) {
    return null
  }
  return { width, height }
}

/**
 * Map the active profile to the provider family used for vision pricing.
 * GitHub Copilot and ChatGPT-OAuth ("codex") behave like Anthropic when the
 * resolved model is Claude — those transports forward the native Anthropic
 * vision blocks unchanged. Otherwise they fall through to the OpenAI tile
 * formula.
 */
function visionFamily(provider: APIProvider): VisionFamily {
  switch (provider) {
    case 'firstParty':
    case 'bedrock':
    case 'vertex':
    case 'foundry':
      return 'anthropic'
    case 'gemini':
      return 'gemini'
    case 'openai':
    case 'nvidia-nim':
      return 'openai'
    case 'mistral':
    case 'minimax':
      return 'mistral'
    case 'github':
    case 'codex':
      return isGithubNativeAnthropicMode() ? 'anthropic' : 'openai'
    default:
      return 'unknown'
  }
}

type VisionFamily = 'anthropic' | 'gemini' | 'openai' | 'mistral' | 'unknown'

function anthropicTokens(d: ParsedImageDimensions): number {
  return Math.min(
    Math.ceil((d.width * d.height) / ANTHROPIC_PIXELS_PER_TOKEN),
    ANTHROPIC_MAX_TOKENS,
  )
}

function geminiTokens(d: ParsedImageDimensions): number {
  if (Math.max(d.width, d.height) <= GEMINI_SMALL_THRESHOLD) {
    return GEMINI_TOKENS_PER_TILE
  }
  const tilesW = Math.ceil(d.width / GEMINI_TILE_PX)
  const tilesH = Math.ceil(d.height / GEMINI_TILE_PX)
  return tilesW * tilesH * GEMINI_TOKENS_PER_TILE
}

function openaiTokens(d: ParsedImageDimensions): number {
  // Mirror the OpenAI pre-processing pipeline: shrink to fit 2048 on the long
  // edge, then to 768 on the short edge, then count 512x512 tiles.
  let { width, height } = d
  const longEdge = Math.max(width, height)
  if (longEdge > OPENAI_MAX_LONG_EDGE) {
    const scale = OPENAI_MAX_LONG_EDGE / longEdge
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }
  const shortEdge = Math.min(width, height)
  if (shortEdge > OPENAI_TARGET_SHORT_EDGE) {
    const scale = OPENAI_TARGET_SHORT_EDGE / shortEdge
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }
  const tilesW = Math.ceil(width / OPENAI_TILE_PX)
  const tilesH = Math.ceil(height / OPENAI_TILE_PX)
  return OPENAI_BASE_TOKENS + OPENAI_TOKENS_PER_TILE * tilesW * tilesH
}

/**
 * Estimate the token cost a provider charges for a single image block.
 * Returns the legacy 2000-token fallback when the source carries no bytes we
 * can inspect (a URL, or a Files API `file_id`), the header is unparsable, or
 * the provider has no documented vision pricing — preserving prior
 * auto-compact behavior on those paths.
 */
export function estimateImageTokens(
  source: Anthropic.ImageBlockParam['source'],
  provider: APIProvider = getAPIProvider(),
): number {
  if (source.type !== 'base64') {
    return IMAGE_TOKEN_FALLBACK
  }
  const dims = parseImageDimensions(source.data, source.media_type)
  if (!dims) {
    return IMAGE_TOKEN_FALLBACK
  }
  switch (visionFamily(provider)) {
    case 'anthropic':
      return anthropicTokens(dims)
    case 'gemini':
      return geminiTokens(dims)
    case 'openai':
      return openaiTokens(dims)
    case 'mistral':
      return MISTRAL_FAMILY_TOKENS
    default:
      return IMAGE_TOKEN_FALLBACK
  }
}
