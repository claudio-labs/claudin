// The one invariant that keeps this feature honest:
//
//   if the picker offers an effort level, the request body carries it.
//
// Claudin shipped the opposite for a long time. `modelSupportsEffort` was an
// allowlist of model-name fragments and the shim's only `reasoning_effort`
// write sat inside the DeepSeek host branch, so the two could disagree without
// anything failing — `gpt-5.6-luna` on the OpenCode gateway rendered "Xhigh
// effort" under the model picker while its request body held exactly
// `{max_tokens, messages, model, stream}`. Nothing was red; the control simply
// did nothing.
//
// Both sides now resolve through src/providers/model/reasoningCatalog.ts. This
// file is what makes that structural, rather than true-for-now: it drives the
// real shim for each pair and compares the body against what the picker says.

import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  cycleEffortForModel,
  getAvailableEffortLevels,
  modelSupportsEffort,
} from 'src/providers/effort/effort.js'
import {
  createOpenAIShimClient,
  useShimHarness,
  type FetchType,
  type OpenAIShimClient,
} from 'src/providers/shims/openaiShim/__testutils__/shimHarness.js'

useShimHarness()

async function bodyFor(baseUrl: string, model: string, effortValue: string) {
  process.env.OPENAI_BASE_URL = baseUrl
  process.env.OPENAI_API_KEY = 'sk-invariant-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model,
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    system: 'test',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
    effortValue,
  })
  return requestBody
}

const OPENCODE_GO = 'https://opencode.ai/zen/go/v1'
const OPENCODE_ZEN = 'https://opencode.ai/zen/v1'

/**
 * `offered` is what the picker is expected to do, written out rather than
 * derived, so a change to the catalog that silently turns a control off shows
 * up here as a failure instead of as two agreeing wrongs.
 */
const PAIRS: ReadonlyArray<{ baseUrl: string; model: string; offered: boolean }> = [
  // The gateway from the original report.
  { baseUrl: OPENCODE_GO, model: 'glm-5.3-flash', offered: true },
  { baseUrl: OPENCODE_GO, model: 'glm-5.3', offered: true },
  { baseUrl: OPENCODE_GO, model: 'grok-4.6', offered: true },
  { baseUrl: OPENCODE_GO, model: 'deepseek-v4-pro', offered: true },
  { baseUrl: OPENCODE_GO, model: 'kimi-k3', offered: true },
  { baseUrl: OPENCODE_GO, model: 'gpt-5.6-luna', offered: true },
  // Declared as having no effort control upstream — an empty reasoning_options
  // for the glm-5.x pair, a bare toggle for minimax.
  { baseUrl: OPENCODE_GO, model: 'glm-5.1', offered: false },
  { baseUrl: OPENCODE_GO, model: 'glm-5', offered: false },
  { baseUrl: OPENCODE_GO, model: 'minimax-m3', offered: false },
  // The Zen lane is a different catalog row from the Go lane.
  { baseUrl: OPENCODE_ZEN, model: 'glm-5.3-flash', offered: true },
  // Other families, to cover both wire shapes.
  { baseUrl: 'https://openrouter.ai/api/v1', model: 'z-ai/glm-5.2', offered: true },
  {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3-flash-preview',
    offered: true,
  },
  { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', offered: false },
  // Declared levels this UI has no way to show: `none` and `default` both mean
  // "think less", which is already spelled `adaptive` here. A row made only of
  // those is not a control, and offering it would put a level on screen whose
  // selection the wire would have to reinterpret.
  { baseUrl: 'https://api.groq.com/openai/v1', model: 'qwen/qwen3.6-27b', offered: false },
  // An endpoint no catalog row claims: the GPT-5 family keeps its control,
  // everything else gets none rather than a guess.
  { baseUrl: 'https://llm.example.test/v1', model: 'gpt-5.4', offered: true },
  { baseUrl: 'https://llm.example.test/v1', model: 'glm-5.3-flash', offered: false },
]

for (const { baseUrl, model, offered } of PAIRS) {
  const host = new URL(baseUrl).host + new URL(baseUrl).pathname
  test(`picker and wire agree for ${model} on ${host}`, async () => {
    process.env.OPENAI_BASE_URL = baseUrl
    process.env.OPENAI_API_KEY = 'sk-invariant-test'

    const supported = modelSupportsEffort(model)
    expect(supported).toBe(offered)
    expect(getAvailableEffortLevels(model).length > 0).toBe(offered)

    const body = await bodyFor(baseUrl, model, 'high')
    const onWire =
      body?.reasoning_effort !== undefined || body?.reasoning !== undefined
    expect(onWire).toBe(offered)
  })
}

test('the picker never offers a level the request would have to clamp away', async () => {
  // glm-5.3-flash accepts low/high/max. If the picker still offered `medium`,
  // choosing it would send `low` and the UI would be lying about the request.
  process.env.OPENAI_BASE_URL = OPENCODE_GO
  process.env.OPENAI_API_KEY = 'sk-invariant-test'

  const levels = getAvailableEffortLevels('glm-5.3-flash') as string[]
  expect(levels).toEqual(['low', 'high', 'max'])

  for (const level of levels) {
    const body = await bodyFor(OPENCODE_GO, 'glm-5.3-flash', level)
    expect(body?.reasoning_effort).toBe(level)
  }
})

test('shift-cycling steps only through the levels the model accepts', () => {
  // The model picker's ←/→ used to run its own low/medium/high(/max) ladder,
  // which put `medium` on screen for a glm-5.3-flash. Found by driving the real
  // app, not by any unit test — the shared cycler is what closes it.
  process.env.OPENAI_BASE_URL = OPENCODE_GO
  process.env.OPENAI_API_KEY = 'sk-invariant-test'

  const seen: string[] = []
  let level: string | undefined = 'high'
  for (let i = 0; i < 3; i++) {
    level = cycleEffortForModel(level as never, 'glm-5.3-flash', 'right')
    seen.push(String(level))
  }
  expect(seen).toEqual(['max', 'low', 'high'])
  expect(seen).not.toContain('medium')
})

test('the model picker has no effort ladder of its own', () => {
  // ModelPicker.tsx reaches the Ink renderer, so it cannot be imported under
  // `bun test` (see ink-tui.md) — reading it as text is the only guard available
  // for the surface where the second ladder actually lived.
  const source = readFileSync(
    join(import.meta.dir, '../../ui/ModelPicker.tsx'),
    'utf8',
  )
  expect(source).toContain('cycleEffortForModel')
  expect(source).not.toMatch(/levels: EffortLevel\[\] = \[/)
})

test('DeepSeek and Kimi Code are the two documented exceptions', async () => {
  // Both own their dialect in the shim — DeepSeek pairs reasoning_effort with a
  // `thinking` toggle and only sends it while thinking is on, Kimi Code sends
  // `thinking.effort` instead. The catalog deliberately leaves them alone, so
  // their picker state is governed by the older rules and is NOT part of the
  // invariant above. Pinned here so removing the exclusion is a visible choice.
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_API_KEY = 'sk-invariant-test'
  expect(modelSupportsEffort('deepseek-v4-pro')).toBe(false)

  const deepseek = await bodyFor('https://api.deepseek.com/v1', 'deepseek-v4-pro', 'high')
  // Without an explicit thinking toggle the DeepSeek branch writes nothing, so
  // the two happen to agree here; the branch's own tests cover the other half.
  expect(deepseek?.reasoning_effort).toBeUndefined()

  process.env.OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1'
  expect(modelSupportsEffort('k3')).toBe(true)
  const kimi = await bodyFor('https://api.kimi.com/coding/v1', 'k3', 'high')
  expect(kimi?.thinking).toEqual({ type: 'enabled', effort: 'high', keep: 'all' })
  expect(kimi?.reasoning_effort).toBeUndefined()
})
