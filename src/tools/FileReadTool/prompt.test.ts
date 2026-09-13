import { describe, expect, test } from 'bun:test'
import {
  LINE_FORMAT_INSTRUCTION,
  renderPromptTemplate,
} from 'src/tools/FileReadTool/prompt.js'

const prompt = renderPromptTemplate(LINE_FORMAT_INSTRUCTION, '')

const ORDINAL_RE = /^(\d+)\. /

describe('Read tool prompt — the reading-strategy list', () => {
  test('numbers each step exactly once', () => {
    // A merge once left two bullets numbered `1.` — the old wording and the
    // new one — so the rendered list read 1, 1, 2, 3, 4 and handed the model
    // the same step twice. Neither an equality nor a prefix check catches that
    // pair (the first ends in `.` where the second has `,`); the ordinals do.
    const ordinals = prompt
      .split('\n')
      .map(line => ORDINAL_RE.exec(line)?.[1])
      .filter((n): n is string => n !== undefined)
    expect(ordinals).toEqual(['1', '2', '3', '4'])
  })

  test('names the supported languages once', () => {
    // The list used to appear twice: once in the strategy header and again in
    // a bullet below that re-stated the strategy itself. Two copies of a fact
    // is how the two halves drift apart.
    expect(prompt.split('TS/JS, Python, Go, Java').length - 1).toBe(1)
  })

  test('says what the outline covers beyond those languages', () => {
    // The non-code cases are the part that only that paragraph carries, and
    // the reason it survived the compression.
    expect(prompt).toContain('Markdown and HTML outline by heading')
    expect(prompt).toContain("symbol='<path>' returns that file's hunks")
    expect(prompt).toContain('head and tail with the line count')
  })

  test('never recommends reading the whole file', () => {
    // The offset/limit bullet used to end "it's recommended to read the whole
    // file by not providing these parameters", ten lines under "Default to
    // surgical reads". Both shipped, in the tool that dominates token spend.
    // The alternative wording already existed but hung on a GrowthBook gate
    // this fork stubs dead, so it could never render.
    expect(prompt).not.toContain('recommended to read the whole file')
    expect(prompt).toContain('only read that part')
  })
})

describe('Read tool prompt — delegation is not its subject', () => {
  test('carries no fork or sub-agent guidance', () => {
    // It used to end with a "Multi-file investigations" block telling the
    // model to `fork yourself (Agent with no subagent_type)`, contradicting
    // both AgentTool/prompt.ts and getAgentToolSection() in the same request —
    // a fork measured 4x the cost of a fresh `Code` agent at equal answers
    // (scripts/bench/ab/fork-vs-fresh-ab.ts, 2026-09-09). Delegation policy
    // has one owner now: the system prompt plus the Agent tool. Bringing any
    // of it back here re-opens the drift that made the two disagree.
    expect(prompt).not.toContain('fork')
    expect(prompt).not.toContain('subagent')
    expect(prompt).not.toContain('Agent tool')
  })
})
