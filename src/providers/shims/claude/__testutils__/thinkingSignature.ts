// A synthetic thinking-block signature with the layout a real Fable 5.1
// response had: field 1 = 4, field 2 = { 1: { 1: 18, 3: 2, 7: 1, 8: <kind> },
// 2..5: opaque }, and field 3 = 1. Real signatures are not committed: they are
// account-bound blobs, and isProgressUpdateBlock only needs the layout.
const varint = (n: number): number[] => {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return out
}
const key = (field: number, wire: number) => varint(field * 8 + wire)
const bytesField = (field: number, body: number[]) => [...key(field, 2), ...varint(body.length), ...body]
const varintField = (field: number, n: number) => [...key(field, 0), ...varint(n)]
const text = (s: string) => [...new TextEncoder().encode(s)]
const opaque = (n: number) => Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256)

/** A signature whose block kind (field 2 → 1 → 8) is `kind`: "narration" or "thinking". */
export function thinkingSignature(kind: string): string {
  const header = [...varintField(1, 18), ...varintField(3, 2), ...varintField(7, 1), ...bytesField(8, text(kind))]
  const inner = [
    ...bytesField(1, header),
    ...bytesField(2, opaque(12)),
    ...bytesField(3, opaque(12)),
    ...bytesField(4, opaque(48)),
    ...bytesField(5, opaque(300)),
  ]
  return Buffer.from([...varintField(1, 4), ...bytesField(2, inner), ...varintField(3, 1)]).toString('base64')
}
