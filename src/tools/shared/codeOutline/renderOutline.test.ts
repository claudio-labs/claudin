import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'
import { OUTLINE_MAX_TOKENS, renderOutline } from 'src/tools/shared/codeOutline/renderOutline.js'

describe('renderOutline', () => {
  test('renders header, indented signatures, and a drill-in hint', () => {
    const src = [
      'export function first() {',
      '  return 1',
      '}',
      'class Box {',
      '  open() {',
      '    return true',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'typescript')
    const out = renderOutline(syms, 'demo.ts', 8, { reason: 'overcap' })

    expect(out).toContain('<system-reminder>')
    expect(out).toContain("exceeds the read cap")
    expect(out).toContain("Read(file_path, symbol='first')")
    expect(out).toContain('1-3')
    expect(out).toContain('function first()')
    // Method is indented one level deeper than its class.
    expect(out).toMatch(/\n {4}\d+-\d+ +open\(\)/)
  })

  test('truncated flag adds a scan-cap notice; absent by default', () => {
    const syms = scanSymbols('function a() {\n  return 1\n}', 'typescript')
    const truncated = renderOutline(syms, 'big.ts', 3, { truncated: true })
    expect(truncated).toContain('exceeds the 10 MB scan cap')
    expect(truncated).toContain('deeper symbols are not listed')

    const normal = renderOutline(syms, 'big.ts', 3)
    expect(normal).not.toContain('scan cap')
  })

  test('non-over-cap header uses neutral wording', () => {
    const syms = scanSymbols('function a() {\n  return 1\n}', 'typescript')
    const out = renderOutline(syms, 'demo.ts', 3)

    expect(out).toContain('Structural outline')
    expect(out).not.toContain('exceeds the read cap')
  })

  test('pivot header says the file is large, never that a cap was exceeded', () => {
    const syms = scanSymbols('function a() {\n  return 1\n}', 'typescript')
    const out = renderOutline(syms, 'demo.ts', 360, { reason: 'pivot' })

    // The defect this pins: the auto-outline pivot reused the over-cap lead,
    // so files well under every cap were told they exceeded one — measured at
    // 1,809 events over 504 files, none above 3k lines.
    expect(out).not.toContain('exceeds the read cap')
    expect(out).toContain("File 'demo.ts' (360 lines) is large")
    // Still an outline, and still says how to drill in.
    expect(out).toContain("Read(file_path, symbol='a')")
  })

  test('auto-cap truncates a pathological symbol count with a trailer', () => {
    // Enough symbols that the rendered body blows OUTLINE_MAX_TOKENS.
    const lines: string[] = []
    for (let i = 0; i < 6000; i++) {
      lines.push(`function symbolNumber${i}() { return ${i} }`)
    }
    const syms = scanSymbols(lines.join('\n'), 'typescript')
    expect(syms.length).toBe(6000)

    const out = renderOutline(syms, 'huge.ts', 6000, { reason: 'overcap' })
    expect(out).toMatch(/… \(\+\d+ more symbols/)

    const bodyTokens = out.length / 4 // crude upper bound
    expect(bodyTokens).toBeLessThan(OUTLINE_MAX_TOKENS * 2)
  })
})

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------
