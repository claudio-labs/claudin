import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// The ⎿ gutter leaves one column before the text ("  ⎿ Read 12 lines"), and
// several renderers draw it by hand rather than through MessageResponse. This
// keeps all of them on one column, and the widths sized to that gutter.

const SRC = join(import.meta.dir, '..')
// ⎿ followed by two spaces, either kind (the renderers use U+00A0 so a
// trailing space survives Ink's trimming), in the same string or in the JSX
// string right after it (`⎿{"  "}`).
const TWO_COLUMN_GUTTER = /⎿(?:\{["'])?[ \u00a0]{2}/

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('the ⎿ gutter is one column wide', () => {
  test('the pattern sees both ways of writing two spaces after ⎿', () => {
    expect(TWO_COLUMN_GUTTER.test('{"  "}⎿  ')).toBe(true)
    expect(TWO_COLUMN_GUTTER.test('{"  "}⎿{"  "}')).toBe(true)
    expect(TWO_COLUMN_GUTTER.test('{"  "}⎿{" "}')).toBe(false)
  })

  test('no renderer puts two spaces after ⎿', () => {
    const offenders = sources(SRC)
      .filter(file => TWO_COLUMN_GUTTER.test(readFileSync(file, 'utf8')))
      .map(file => relative(SRC, file))
    expect(offenders).toEqual([])
  })

  test('the widths around it count four columns, not five', () => {
    const read = (file: string) => readFileSync(join(SRC, file), 'utf8')
    expect(read('agent/ui/Message.tsx')).toContain('const t1 = columns - 4;')
    expect(read('agent/ui/messages/CollapsedReadSearchContent.tsx')).not.toContain('<Box width={5} flexShrink={0}>')
    expect(read('tools/GrepTool/UI.tsx')).toContain('<Box marginLeft={4}><Text>{content}</Text></Box>')
    expect(read('tools/LSPTool/UI.tsx')).toContain('<Box marginLeft={4}><Text>{content}</Text></Box>')
    expect(read('tools/BashTool/UI.tsx')).toContain('<Box paddingLeft={4}><Text dimColor={true}><KeyboardShortcutHint')
    expect(read('terminal/terminal.ts')).toContain('const PADDING_TO_PREVENT_OVERFLOW = 8')
  })
})
