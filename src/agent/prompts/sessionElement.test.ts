import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'

// MACRO is replaced at build time by Bun.define but not in test mode.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/claudio-labs/claudin/issues',
  PACKAGE_URL: '@claudiolabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { getSessionId, switchSession } from 'src/platform/bootstrap/state.js'
import { getProjectTempDir } from 'src/platform/tmpdir.js'
import type { SessionId } from 'src/shared/types/ids.js'
import { getScratchpadDir } from 'src/agent/scratchpad.js'
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

// /clear, /new and /resume give the conversation a new session id. The
// permission check allows writes under the CURRENT id's scratchpad, so a
// prompt that kept naming the old one sent every write to a permission prompt.
test('a session switch moves the scratchpad path the prompt names', async () => {
  delete process.env.CLAUDIN_SCRATCHPAD
  const before = getSessionId()
  const next = randomUUID() as SessionId
  const fresh = [before, next]
    .map(id => join(getProjectTempDir(), id))
    .filter(dir => !existsSync(dir))
  await getSystemPrompt([], 'claude-opus-5-5')
  switchSession(next)
  try {
    const parts = await getSystemPrompt([], 'claude-opus-5-5')
    expect(parts.at(-1)).toContain(getScratchpadDir())
    expect(parts.at(-1)).not.toContain(before)
  } finally {
    switchSession(before)
    for (const dir of fresh) rmSync(dir, { recursive: true, force: true })
  }
})
