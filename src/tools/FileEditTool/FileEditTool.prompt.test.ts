import { describe, expect, it } from 'bun:test'
import { buildEditToolDescription } from './prompt.js'

const GATED = [
  'NEVER write new files unless explicitly required',
  'Only use emojis if the user explicitly requests it',
]
const CORE = [
  'Performs exact string replacements in files.',
  'tool at least once in the conversation before editing',
  'preserve the exact indentation',
  'The edit will FAIL if',
  'Use `replace_all` for replacing and renaming',
]

describe('buildEditToolDescription', () => {
  const verbose = buildEditToolDescription(false)
  const lean = buildEditToolDescription(true)

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
