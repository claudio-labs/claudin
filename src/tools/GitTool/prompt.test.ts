import { expect, test } from 'bun:test'
import { DESCRIPTION } from 'src/tools/GitTool/prompt.js'

/**
 * The description sits in the system prompt of EVERY request, while the payload
 * the tool saves only accrues on the ~26% of sessions that run a git command at
 * all. A RunTests-sized description (~1.5k chars) would cost more than the tool
 * returns on the other 74%, so the size is a product decision, not a style one.
 */
const MAX_DESCRIPTION_CHARS = 750

test('the description stays inside its per-request budget', () => {
  expect(DESCRIPTION.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS)
})

test('the description states the things the model gets wrong without it', () => {
  // A list, not a string; no shell operators; writes are allowed but prompt.
  expect(DESCRIPTION).toContain('commands')
  expect(DESCRIPTION).toContain('no pipes')
  expect(DESCRIPTION).toContain('permission')
  // The two escapes it would otherwise leave for Bash: a multi-line message,
  // and a diff too wide to come back whole.
  expect(DESCRIPTION).toContain('multi-line')
  expect(DESCRIPTION).toContain('full: true')
})
