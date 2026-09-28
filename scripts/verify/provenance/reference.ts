/**
 * The committed reference: fingerprints.bin, read by the census and the CI
 * ratchet, written by build-fingerprints.ts.
 *
 * Layout, gzipped as a whole: the magic `CLPV`, a u32 byte length, a JSON
 * header (the fingerprint PARAMS and the source commits), then four sets in a
 * fixed order: Claude Code lines, Claude Code grams, openclaude lines,
 * openclaude grams. Each set is a u32 count followed by its sorted values as
 * varint deltas, which is what keeps ~400k random 32-bit hashes near 1 MB.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { PARAMS, type ReferenceSets } from './fingerprint.js'

export const REFERENCE_PATH = join(import.meta.dir, 'fingerprints.bin')

const MAGIC = 'CLPV'

export type ReferenceHeader = {
  params: typeof PARAMS
  /** Which commit of which repository each origin was fingerprinted from. */
  sources: Record<string, string>
  builtAt: string
}

export type Reference = {
  header: ReferenceHeader
  claudeCode: ReferenceSets
  openclaude: ReferenceSets
}

function writeSet(values: Set<number>, out: number[]): void {
  const sorted = Uint32Array.from(values).sort()
  pushU32(sorted.length, out)
  let previous = 0
  for (const value of sorted) {
    let delta = value - previous
    previous = value
    while (delta >= 0x80) {
      out.push((delta & 0x7f) | 0x80)
      delta = Math.floor(delta / 0x80)
    }
    out.push(delta)
  }
}

function pushU32(value: number, out: number[]): void {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

export function encodeReference(reference: Reference): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify(reference.header))
  const out: number[] = []
  for (const c of MAGIC) out.push(c.charCodeAt(0))
  pushU32(header.length, out)
  for (const byte of header) out.push(byte)
  writeSet(reference.claudeCode.lines, out)
  writeSet(reference.claudeCode.grams, out)
  writeSet(reference.openclaude.lines, out)
  writeSet(reference.openclaude.grams, out)
  return gzipSync(Uint8Array.from(out), { level: 9 })
}

export function decodeReference(bytes: Uint8Array): Reference {
  const data = gunzipSync(bytes)
  let at = 0
  const u32 = () => {
    const value = (data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) | (data[at + 3]! << 24)) >>> 0
    at += 4
    return value
  }
  const magic = String.fromCharCode(...data.subarray(0, 4))
  if (magic !== MAGIC) throw new Error(`not a provenance reference (magic ${JSON.stringify(magic)})`)
  at = 4
  const headerLength = u32()
  const header = JSON.parse(new TextDecoder().decode(data.subarray(at, at + headerLength))) as ReferenceHeader
  at += headerLength

  const readSet = () => {
    const count = u32()
    const values = new Set<number>()
    let previous = 0
    for (let i = 0; i < count; i++) {
      let delta = 0
      let scale = 1
      for (;;) {
        const byte = data[at++]!
        delta += (byte & 0x7f) * scale
        if (byte < 0x80) break
        scale *= 0x80
      }
      previous += delta
      values.add(previous)
    }
    return values
  }

  const claudeCode = { lines: readSet(), grams: readSet() }
  const openclaude = { lines: readSet(), grams: readSet() }
  return { header, claudeCode, openclaude }
}

export function writeReference(reference: Reference, path = REFERENCE_PATH): number {
  const bytes = encodeReference(reference)
  writeFileSync(path, bytes)
  return bytes.length
}

/**
 * The committed reference, refused when it was built under other PARAMS: the
 * hashes would still load, match nothing, and report a clean tree.
 */
export function loadReference(path = REFERENCE_PATH): Reference {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing. Build it with: bun run provenance:fingerprints`)
  }
  const reference = decodeReference(readFileSync(path))
  const built = JSON.stringify(reference.header.params)
  const current = JSON.stringify(PARAMS)
  if (built !== current) {
    throw new Error(
      `fingerprints.bin was built with ${built}, but fingerprint.ts now uses ${current}.\n` +
        'Rebuild it with: bun run provenance:fingerprints',
    )
  }
  return reference
}
