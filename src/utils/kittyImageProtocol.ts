// Kitty Graphics Protocol — Unicode Placeholder variant.
//
// The terminal stores image bytes under an integer ID via an APC sequence
// (`transmit`), then we render the image by writing rows of U+10EEEE
// placeholders carrying combining diacritics that encode (row, col,
// id-high-byte). The terminal substitutes each placeholder with the
// corresponding pixel of the stored image.
//
// Reference: https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders

const KITTY_PLACEHOLDER = '\u{10EEEE}'

// Official Kitty diacritic table (297 entries). Index i encodes row/col value i.
// Source: https://sw.kovidgoyal.net/kitty/_downloads/rowcolumn-diacritics.txt
// Full table — supports up to 297 cells per dimension. A 1080p image with a
// small font can exceed 257 cells/dim, so the full table avoids a silent
// fallback to text on large embeds.
// biome-ignore format: long literal table
const KITTY_DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346,
  0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363,
  0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c,
  0x036d, 0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
  0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e,
  0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4,
  0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657,
  0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6, 0x06d7, 0x06d8,
  0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4,
  0x06e7, 0x06e8, 0x06eb, 0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736,
  0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747, 0x0749,
  0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3,
  0x0816, 0x0817, 0x0818, 0x0819, 0x081b, 0x081c, 0x081d, 0x081e, 0x081f,
  0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a,
  0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86,
  0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd, 0x193a, 0x1a17, 0x1a75, 0x1a76,
  0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e,
  0x1b6f, 0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda,
  0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5, 0x1dc6, 0x1dc7,
  0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5,
  0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde,
  0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe,
  0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1,
  0x20e7, 0x20e9, 0x20f0, 0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2,
  0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea, 0x2deb,
  0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4,
  0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa, 0x2dfb, 0x2dfc, 0x2dfd,
  0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
  0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea,
  0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2,
  0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22,
  0xfe23, 0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186,
  0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242,
  0x1d243, 0x1d244,
] as const

/** Maximum cells per dimension supported by the Kitty diacritic table. */
export const MAX_CELLS = KITTY_DIACRITICS.length

let nextId = 1

/**
 * Allocate a new image ID (uint24, wraps after 16M).
 * IDs are session-scoped — collisions across processes are fine because
 * each Kitty instance manages its own image buffer.
 *
 * In-process wrap-around: the counter wraps at 0x1000000 (~16M IDs). After
 * that many images in a single session, a freshly transmitted image could
 * overwrite a still-displayed one with the same ID, garbling the older
 * placeholder run. In practice a CLI session never gets close to 16M
 * images; if that ever becomes reachable, switch to a content-hash ID so
 * identical bytes deterministically alias and unique bytes never collide.
 */
export function nextImageId(): number {
  const id = nextId
  nextId = (nextId % 0xff_ff_ff) + 1
  return id
}

/**
 * Build an APC sequence that uploads PNG bytes to Kitty under `imageId`,
 * without displaying anything (`a=t`, `q=2`). The payload is base64 and
 * chunked into 4096-byte slices (`m=1` on all but the last).
 */
export function transmitKittyImage(pngBuf: Buffer, imageId: number): string {
  const b64 = pngBuf.toString('base64')
  const chunkSize = 4096
  let out = ''
  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize)
    const isLast = i + chunkSize >= b64.length
    const m = isLast ? 0 : 1
    if (i === 0) {
      // Control block on the first chunk only.
      out += `\x1b_Ga=t,f=100,i=${imageId},q=2,m=${m};${chunk}\x1b\\`
    } else {
      out += `\x1b_Gm=${m};${chunk}\x1b\\`
    }
  }
  return out
}

/**
 * Build an APC sequence asking Kitty to free image storage for `imageId`
 * (`a=d,d=I`). Called when an InlineImage unmounts so the terminal's
 * image buffer does not grow unbounded across a long session.
 */
export function deleteKittyImage(imageId: number): string {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2;\x1b\\`
}

/**
 * Render `rows × cols` worth of placeholder text. Each placeholder is
 * U+10EEEE + 3 diacritics encoding (row, col, id-high-byte). Per the Kitty
 * protocol, the **full image ID** is carried by a 24-bit SGR foreground
 * color set on the placeholder run; the 3rd diacritic only conveys bits
 * above bit 23 (we keep it for canonical encoding even though uint24 IDs
 * always have a zero high byte). Without the SGR, every placeholder maps
 * to image ID 0 in the terminal — see https://sw.kovidgoyal.net/kitty/graphics-protocol/#image-id
 *
 * Each row is wrapped with `\x1b[38;2;R;G;Bm...\x1b[39m` so the foreground
 * color encodes (R=highByte, G=midByte, B=lowByte) of the 24-bit ID.
 * `\x1b[39m` restores the default foreground at end-of-line so the SGR
 * does not leak into surrounding cells.
 */
export function placeholderLines(
  imageId: number,
  rows: number,
  cols: number,
): string[] {
  if (rows <= 0 || cols <= 0) return []
  if (rows > MAX_CELLS || cols > MAX_CELLS) {
    throw new RangeError(
      `kitty placeholder: image too large (max ${MAX_CELLS} cells/dim, got ${rows}x${cols})`,
    )
  }
  // Split 24-bit ID into bytes for the SGR foreground color.
  const idR = (imageId >> 16) & 0xff
  const idG = (imageId >> 8) & 0xff
  const idB = imageId & 0xff
  // bits 24-31 of the ID go to the 3rd diacritic. For uint24 IDs this is 0,
  // but we keep it explicit so a future 32-bit ID change still encodes.
  const idHighByte = (imageId >> 24) & 0xff
  const idDiacritic = diacriticChar(idHighByte)
  const sgrOn = `\x1b[38;2;${idR};${idG};${idB}m`
  const sgrOff = '\x1b[39m'
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    const rowDiacritic = diacriticChar(r)
    let line = sgrOn
    for (let c = 0; c < cols; c++) {
      line += KITTY_PLACEHOLDER + rowDiacritic + diacriticChar(c) + idDiacritic
    }
    line += sgrOff
    lines.push(line)
  }
  return lines
}

function diacriticChar(index: number): string {
  const cp = KITTY_DIACRITICS[index] ?? KITTY_DIACRITICS[0] ?? 0x0305
  return String.fromCodePoint(cp)
}

export const __test = { KITTY_DIACRITICS, MAX_CELLS }
