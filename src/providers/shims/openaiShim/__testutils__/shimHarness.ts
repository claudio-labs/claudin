// Shared harness for the openaiShim suites.
//
// These helpers used to sit at the top of a single 4756-line
// `openaiShim.test.ts`. Splitting that file by topic is what forced them out
// here, and the way the state is armed changed in the process — the old shape
// does not survive being present in more than one file.
//
// The old shape: `mock.module(activeProvider)` ran at module scope and an
// `afterAll` put the real module back. With one file that is correct. With
// nine, whichever runs FIRST hands the real `tryGetActiveProvider` back while
// the other eight still need the stub, and they then resolve whatever provider
// the developer happens to have configured. Nothing throws; the transport-
// routing assertions just start describing someone's settings.json.
//
// What replaces it: the override is installed exactly once, and the exported
// `tryGetActiveProvider` decides AT CALL TIME which implementation to use by
// reading a module-level flag. `useShimHarness()` turns the flag on in
// `beforeEach` and off in `afterAll`, so the stub covers precisely the tests
// that asked for it and every other file in the run gets the real resolver by
// delegation. Order-independent, and it never re-evaluates the module graph.
//
// The flag is read inside the exported function on purpose. Reading it in the
// mock FACTORY instead would be latched the first time Bun built the namespace
// and no later toggle would be visible.
//
// NOT a `.test` file — it exports helpers, it does not register tests.

import { afterAll, afterEach, beforeEach, mock } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
}

// Spread the real module into a plain object BEFORE mocking. A live
// `import * as` namespace re-applies the stub when it is handed back, which is
// the documented way this suite has leaked before (see testing.md).
const realActiveProvider = { ...(await import('src/providers/presets/activeProvider.js')) }
const realActiveProviderSnapshot = { ...realActiveProvider }

type Transport =
  | 'anthropic'
  | 'openai_compat'
  | 'gemini'
  | 'mistral'
  | 'github_copilot'
  | 'codex_responses'
  | 'bedrock'
  | 'vertex'
  | 'foundry'

/** openaiShim and providerConfig consume tryGetActiveProvider() for transport
 * routing. The suites still set the `CLAUDE_CODE_USE_*` and `OPENAI_*` envs to
 * describe the desired provider, so synthesize a matching profile from those
 * envs and let the resolver-driven code paths see the same configuration. */
export function profileFromEnv(env: NodeJS.ProcessEnv): {
  transport: Transport
  baseUrl: string
  model: string
  apiKey?: string
  extras?: { githubToken?: string }
} | null {
  if (env.CLAUDIN_USE_GEMINI === '1' || env.CLAUDIN_USE_GEMINI === 'true') {
    return {
      transport: 'gemini',
      baseUrl: env.GEMINI_BASE_URL ?? env.OPENAI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: env.GEMINI_MODEL ?? env.OPENAI_MODEL ?? 'gemini-2.0-flash',
      apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY,
    }
  }
  if (env.CLAUDIN_USE_MISTRAL === '1' || env.CLAUDIN_USE_MISTRAL === 'true') {
    return {
      transport: 'mistral',
      baseUrl: env.MISTRAL_BASE_URL ?? env.OPENAI_BASE_URL ?? 'https://api.mistral.ai/v1',
      model: env.MISTRAL_MODEL ?? env.OPENAI_MODEL ?? 'mistral-large-latest',
      apiKey: env.MISTRAL_API_KEY ?? env.OPENAI_API_KEY,
    }
  }
  if (env.CLAUDIN_USE_GITHUB === '1' || env.CLAUDIN_USE_GITHUB === 'true') {
    return {
      transport: 'github_copilot',
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.githubcopilot.com',
      model: env.OPENAI_MODEL ?? 'github:copilot',
      apiKey: env.OPENAI_API_KEY,
      extras: { githubToken: env.GITHUB_TOKEN ?? env.GH_TOKEN },
    }
  }
  if (env.OPENAI_BASE_URL || env.OPENAI_API_KEY || env.OPENAI_MODEL) {
    return {
      transport: 'openai_compat',
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL ?? 'gpt-4o',
      apiKey: env.OPENAI_API_KEY,
    }
  }
  return null
}

/** Armed by `useShimHarness()`. While false the override below is a pass-through
 * to the real resolver, so files that never called it are unaffected. */
let envProfileResolverArmed = false

/** For `shimHarness.test.ts`, which pins the default-off half of the contract.
 * Between two test files the flag is always false: Bun runs a file's `afterAll`
 * before the next file starts. */
export function isEnvProfileResolverArmed(): boolean {
  return envProfileResolverArmed
}

mock.module('src/providers/presets/activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () =>
    envProfileResolverArmed
      ? profileFromEnv(process.env)
      : realActiveProviderSnapshot.tryGetActiveProvider(),
}))

// Imported AFTER the override is installed, and re-exported so the suites get
// the same ordering guarantee without repeating the dynamic import.
const { createOpenAIShimClient } = await import('src/providers/shims/openaiShim.js')
const { getSessionId } = await import('src/platform/bootstrap/state.js')

export { createOpenAIShimClient, getSessionId }

export type FetchType = typeof globalThis.fetch

export type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown> & {
        withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>> }>
      }
    }
  }
}

/** Every env var the suites write. Listed once so `useShimHarness` can clear
 * and restore the whole set rather than each file tracking its own subset. */
const MANAGED_ENV = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'CLAUDIN_USE_GITHUB',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'CLAUDIN_USE_OPENAI',
  'CLAUDIN_USE_GEMINI',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_ACCESS_TOKEN',
  'GEMINI_AUTH_MODE',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDIN_DISABLE_XAI_CONV_ID',
  'CLAUDIN_DISABLE_OPENCODE_SESSION_ID',
] as const

const originalEnv: Record<string, string | undefined> = Object.fromEntries(
  MANAGED_ENV.map(key => [key, process.env[key]]),
)

const originalFetch = globalThis.fetch

/** Restore one key. Never assign an `undefined` value — that stores the literal
 * string "undefined"; delete the key instead. */
export function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

export function makeSseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line))
        }
        controller.close()
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
      },
    },
  )
}

export function makeStreamChunks(chunks: unknown[]): string[] {
  return [
    ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ]
}

/**
 * Call once at the top level of each openaiShim suite.
 *
 * Registers the hooks in THAT file's scope — which is why this is a function
 * and not module-scope code. Hooks called while this module is first evaluated
 * would attach to whichever file happened to trigger the evaluation and to no
 * other.
 */
export function useShimHarness(): void {
  beforeEach(() => {
    envProfileResolverArmed = true
    for (const key of MANAGED_ENV) delete process.env[key]
    process.env.OPENAI_BASE_URL = 'http://example.test/v1'
    process.env.OPENAI_API_KEY = 'test-key'
  })

  afterEach(() => {
    for (const key of MANAGED_ENV) restoreEnv(key, originalEnv[key])
    globalThis.fetch = originalFetch
  })

  afterAll(() => {
    envProfileResolverArmed = false
  })
}
