import { describe, expect, it } from 'bun:test'
import { buildWriteToolDescription } from 'src/tools/FileWriteTool/prompt.js'

const GATED = [
  'NEVER create documentation files (*.md) or README files',
  'Only use emojis if the user explicitly requests it',
]
const CORE = [
  'Writes a file to the local filesystem.',
  'This tool will overwrite the existing file',
  'you MUST use the Read tool first',
  'Prefer the Edit tool for modifying existing files',
]

describe('buildWriteToolDescription', () => {
  const verbose = buildWriteToolDescription(false)
  const lean = buildWriteToolDescription(true)

  it('keeps every CORE line in both shapes', () => {
    for (const line of CORE) {
      expect(verbose).toContain(line)
      expect(lean).toContain(line)
    }
  })

  it('includes GATED guardrails only in the verbose shape', () => {
    for (const line of GATED) {
      expect(verbose).toContain(line)
      expect(lean).not.toContain(line)
    }
  })

  it('lean is shorter than verbose', () => {
    expect(lean.length).toBeLessThan(verbose.length)
  })

  it('verbose shape snapshot', () => {
    expect(verbose).toMatchSnapshot()
  })

  it('lean shape snapshot', () => {
    expect(lean).toMatchSnapshot()
  })
})
