import { describe, expect, it } from 'bun:test'
import { getSimplePrompt } from './prompt.js'

// GATED blocks: present only in the verbose (weak-family) shape.
const GATED = [
  'first use this tool to run `ls`',
  'Always quote file paths that contain spaces',
  'tool calls in a single message', // parallel-tool-call batching item
  'Avoid unnecessary `sleep` commands:',
]

// CORE: present in both shapes regardless of family. Note the command-
// composition rules (header, &&-chaining, no-bare-newlines) stay CORE — the
// permission/sandbox command splitter is sensitive to them.
const CORE = [
  'Executes a given bash command',
  'Try to maintain your current working directory',
  'You may specify an optional timeout',
  'Read files: Use',
  'When issuing multiple commands:',
  "use a single Bash call with '&&' to chain them together",
  'DO NOT use newlines to separate commands',
]

describe('getSimplePrompt family tiering', () => {
  const verbose = getSimplePrompt(false)
  const lean = getSimplePrompt(true)

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
