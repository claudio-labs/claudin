/**
 * Regression tests for `getAttributionHeader` byte-stability across turns.
 *
 * Anthropic's prompt cache is prefix-matched on literal bytes. The
 * attribution header is the FIRST element of the system prompt array
 * (claude.ts:1348-1359) and `splitSysPromptPrefix` (utils/api.ts:399-485)
 * places it as block 0 with `cacheScope: null` — the bytes still travel
 * on the wire and a single-byte change at this position invalidates every
 * downstream cache_control breakpoint.
 *
 * Historically, `getAttributionHeader` injected `cc_workload=cron` into
 * its output when invoked inside an AsyncLocalStorage cron context. That
 * shifted block-0 bytes between cron-fired turns and interactive REPL
 * turns of the same session, busting the prefix cache (~27k rebill
 * tokens per flip on sonnet-4-5). The workload subsystem has been
 * removed entirely — the function now produces a single byte-stable
 * string per fingerprint+entrypoint+attestation set.
 */
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/anthropics/claude-code/issues',
  PACKAGE_URL: '@claudiolabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { getAttributionHeader } from 'src/agent/prompts/system.ts'

const ENV_KEYS = ['CLAUDIN_ATTRIBUTION_HEADER', 'CLAUDE_CODE_ENTRYPOINT'] as const
const savedEnv: Record<string, string | undefined> = {}

/**
 * The lane predicate is injected rather than mocked: `getAPIProvider()` reads
 * the developer's own config under `bun test`, and `mock.module` overrides leak
 * into every other file in the run.
 */
const FIRST_PARTY = { isFirstPartyLane: () => true }
const THIRD_PARTY = { isFirstPartyLane: () => false }

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  // Force header on regardless of growthbook stub default.
  process.env.CLAUDIN_ATTRIBUTION_HEADER = 'true'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('getAttributionHeader byte-stability', () => {
  test('two calls with the same fingerprint produce byte-identical headers', () => {
    const a = getAttributionHeader('fp1', FIRST_PARTY)
    const b = getAttributionHeader('fp1', FIRST_PARTY)
    expect(a).toBe(b)
  })

  test('header is the prefix-cache anchor: must start with x-anthropic-billing-header', () => {
    const h = getAttributionHeader('fp1', FIRST_PARTY)
    expect(h.startsWith('x-anthropic-billing-header:')).toBe(true)
  })

  test('header never carries the cc_workload tag (removed to keep the prefix stable)', () => {
    const h = getAttributionHeader('fp1', FIRST_PARTY)
    expect(h).not.toContain('cc_workload')
  })

  test('different fingerprints still produce different headers (sanity)', () => {
    const a = getAttributionHeader('fp1', FIRST_PARTY)
    const b = getAttributionHeader('fp2', FIRST_PARTY)
    expect(a).not.toBe(b)
  })
})

/**
 * The block is Anthropic's own billing/QoS tag and only the first-party
 * backend reads it. It is the system-prompt twin of the identity HEADERS,
 * which `src/providers/transport/identityHeaders.ts` already scopes to that
 * one lane — it used to be prepended unconditionally, so every OpenAI-compat,
 * Gemini, Codex and Ollama request carried upstream identity in its body.
 */
describe('getAttributionHeader lane scoping', () => {
  test('third-party lanes get no block at all', () => {
    expect(getAttributionHeader('fp1', THIRD_PARTY)).toBe('')
  })

  test('the lane check wins over the env opt-in', () => {
    process.env.CLAUDIN_ATTRIBUTION_HEADER = 'true'
    expect(getAttributionHeader('fp1', THIRD_PARTY)).toBe('')
  })

  test('the env killswitch still wins on the first-party lane', () => {
    process.env.CLAUDIN_ATTRIBUTION_HEADER = 'false'
    expect(getAttributionHeader('fp1', FIRST_PARTY)).toBe('')
  })
})
