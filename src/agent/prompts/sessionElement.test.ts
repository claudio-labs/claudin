import { afterEach, expect, test } from 'bun:test'

// MACRO is replaced at build time by Bun.define but not in test mode.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/claudio-labs/claudin/issues',
  PACKAGE_URL: '@claudiolabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { getSessionId } from 'src/platform/bootstrap/state.js'
import {
  getSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  SYSTEM_PROMPT_SESSION_MARKER,
  withoutSystemPromptMarkers,
} from 'src/agent/prompts/prompts.js'
import { clearSystemPromptSections } from 'src/agent/prompts/systemPromptSections.js'

// The session id may appear in exactly one system prompt element, the one
// after SYSTEM_PROMPT_SESSION_MARKER: splitSysPromptPrefix sends that one
// uncached and last, and everything else must render the same bytes in the
// next session so its cache breakpoint is read back instead of rewritten.

const priorScratchpad = process.env.CLAUDIN_SCRATCHPAD

afterEach(() => {
  if (priorScratchpad === undefined) delete process.env.CLAUDIN_SCRATCHPAD
  else process.env.CLAUDIN_SCRATCHPAD = priorScratchpad
  clearSystemPromptSections()
})

for (const model of ['claude-opus-5-5', 'gpt-5']) {
  test(`${model}: the session id is only in the element after the marker, which is last`, async () => {
    delete process.env.CLAUDIN_SCRATCHPAD
    const parts = await getSystemPrompt([], model)
    const sessionId = getSessionId()

    expect(parts.at(-2)).toBe(SYSTEM_PROMPT_SESSION_MARKER)
    expect(parts.at(-1)).toContain(sessionId)
    expect(parts.slice(0, -2).filter(p => p.includes(sessionId))).toEqual([])
  })
}

test('no scratchpad, no marker', async () => {
  process.env.CLAUDIN_SCRATCHPAD = '0'
  const parts = await getSystemPrompt([], 'claude-opus-5-5')
  expect(parts).not.toContain(SYSTEM_PROMPT_SESSION_MARKER)
})

test('withoutSystemPromptMarkers keeps the text and its order', async () => {
  delete process.env.CLAUDIN_SCRATCHPAD
  const parts = await getSystemPrompt([], 'claude-opus-5-5')
  const text = withoutSystemPromptMarkers(parts)
  expect(text).toEqual(
    parts.filter(
      p => p !== SYSTEM_PROMPT_SESSION_MARKER && p !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ),
  )
  expect(text.join('\n')).not.toContain('__SYSTEM_PROMPT_')
})
