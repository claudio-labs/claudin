/**
 * Which Bedrock models Claudin sends through the Converse API, and the limits
 * it plans their requests around.
 *
 * Claude stays on @anthropic-ai/bedrock-sdk (InvokeModel with the Anthropic
 * body); every other model on Bedrock speaks only Converse. An application
 * inference profile ARN does not name its model, so it stays on the Claude
 * path, as it did before Converse existed, and so does any id without a
 * vendor prefix (`amazon.`, `us.meta.`): a Claude alias such as `sonnet`.
 *
 * The limits are the model cards' where they are stated plainly, and
 * conservative otherwise: a context window too small only compacts early, an
 * output cap too large is a ValidationException on every request.
 */

/** A model id Converse answers for: a vendor-prefixed id that is not Claude. */
export function usesConverse(model: string | undefined): boolean {
  const id = (model ?? '').trim().toLowerCase()
  if (!id.includes('.') || id.startsWith('arn:')) return false
  return !id.includes('anthropic') && !id.includes('claude')
}

type Limits = { context: number; output: number }

// First match wins: a family's narrower ids come before its wider ones.
const LIMITS: ReadonlyArray<[RegExp, Limits]> = [
  [/amazon\.nova-micro/, { context: 128_000, output: 10_000 }],
  [/amazon\.nova-(?:lite|pro)/, { context: 300_000, output: 10_000 }],
  [/amazon\.nova-premier/, { context: 1_000_000, output: 10_000 }],
  [/amazon\.nova/, { context: 300_000, output: 10_000 }],
  // Llama 3 caps generation at 2048 tokens on Bedrock.
  [/meta\.llama3/, { context: 128_000, output: 2_048 }],
  [/meta\.llama4/, { context: 128_000, output: 8_192 }],
  [/deepseek\.r1/, { context: 128_000, output: 32_768 }],
  [/deepseek\./, { context: 128_000, output: 8_192 }],
  [/qwen\.qwen3-32b/, { context: 32_768, output: 8_192 }],
  [/qwen\./, { context: 128_000, output: 8_192 }],
  [/openai\.gpt-oss/, { context: 128_000, output: 8_192 }],
  [/mistral\./, { context: 128_000, output: 8_192 }],
]

const FALLBACK: Limits = { context: 128_000, output: 8_192 }

function limitsFor(model: string): Limits {
  const id = model.trim().toLowerCase()
  return LIMITS.find(([re]) => re.test(id))?.[1] ?? FALLBACK
}

export function converseContextWindow(model: string): number {
  return limitsFor(model).context
}

export function converseMaxOutputTokens(model: string): number {
  return limitsFor(model).output
}
