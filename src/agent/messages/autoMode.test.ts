import { describe, expect, test } from 'bun:test'
import { getAutoModeFullInstructions } from 'src/agent/messages/autoMode.js'

function text(): string {
  const [message] = getAutoModeFullInstructions()
  const content = message!.message.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

describe('auto-mode full instructions', () => {
  // "Execute immediately" and "minimize interruptions" were two points saying
  // "make reasonable assumptions" until 2026-09-29; one point carries both.
  test('five points, the two about assumptions merged without losing a clause', () => {
    const t = text()
    expect(t).not.toContain('Minimize interruptions')
    expect(t).toContain(
      '2. **Otherwise, execute immediately** — When the user wants the work done, start implementing right away: make reasonable assumptions instead of asking about routine decisions, and proceed on low-risk work. When in doubt about an ambiguous *implementation* detail, start coding.',
    )
    expect(t).toContain('3. **Expect course corrections**')
    expect(t).toContain('4. **Do not take overly destructive actions**')
    expect(t).toContain('5. **Avoid data exfiltration**')
    expect(t).not.toContain('6. **')
  })

  // The plan-mode detection is the calibrated part: the pt-BR and English
  // examples are what scripts/bench/ab/auto-mode-plan-adherence-ab.ts measured.
  test('point 1 keeps the plan-mode detection with its examples', () => {
    const t = text()
    expect(t).toContain('1. **Detect when the user wants a plan, not code, and enter plan mode immediately**')
    for (const example of ['"vamos planejar"', '"me explica a abordagem antes"', '"como você faria X?"', 'how existing code *currently works*']) {
      expect(t).toContain(example)
    }
  })
})
