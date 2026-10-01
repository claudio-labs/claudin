/**
 * The prompt-cache invariant on recorded wire bodies: each request of a thread
 * sends what the previous one sent — the same system prompt, tools and request
 * parameters, and every earlier message byte for byte — before anything new.
 * Compared in the break detector's canonical form (canonicalWireMessage), with
 * the billing header left out: the API does not cache it.
 */
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { canonicalWireMessage } from 'src/providers/cache/promptCacheBreakDetection.js'
import type { Json } from 'src/agent/cache/__testutils__/mockAnthropic.js'

const stripCacheControl = (value: unknown): string =>
  JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v))

/** What the request carries besides its messages, as the cache sees it. */
function frame(body: Json): Record<string, string> {
  const system = Array.isArray(body.system)
    ? body.system.filter((b: Json) => !String(b.text ?? '').startsWith('x-anthropic-billing-header:'))
    : body.system
  return {
    model: JSON.stringify(body.model),
    system: stripCacheControl(system),
    // The marker on the tools moves with the global cache scope; the tools do not.
    tools: stripCacheControl(body.tools),
    thinking: JSON.stringify(body.thinking),
    context_management: JSON.stringify(body.context_management),
    output_config: JSON.stringify(body.output_config),
    // Which cache the system blocks write to (TTL, scope).
    system_cache_control: JSON.stringify(
      Array.isArray(body.system) ? body.system.map((b: Json) => b.cache_control ?? null) : null,
    ),
  }
}

export type WireBreak = { from: number; to: number; where: string; sent: string; resent: string }

/** The first request of `bodies` that does not extend the one before it, or null. */
export function findWireBreak(bodies: readonly Json[]): WireBreak | null {
  const around = (a: string, b: string): [string, string] => {
    let at = 0
    while (at < a.length && a[at] === b[at]) at++
    const cut = (s: string) => JSON.stringify(s.slice(Math.max(0, at - 120), at + 200))
    return [cut(a), cut(b)]
  }
  for (let r = 1; r < bodies.length; r++) {
    const prev = bodies[r - 1]!
    const cur = bodies[r]!
    const [pf, cf] = [frame(prev), frame(cur)]
    for (const field of Object.keys(pf)) {
      if (pf[field] === cf[field]) continue
      const [sent, resent] = around(pf[field]!, cf[field] ?? '')
      return { from: r - 1, to: r, where: field, sent, resent }
    }
    const pm = (prev.messages ?? []) as BetaMessageParam[]
    const cm = (cur.messages ?? []) as BetaMessageParam[]
    for (let i = 0; i < pm.length; i++) {
      const a = JSON.stringify(canonicalWireMessage(pm[i]!))
      const b = cm[i] === undefined ? '(missing)' : JSON.stringify(canonicalWireMessage(cm[i]!))
      if (a === b) continue
      const [sent, resent] = around(a, b)
      return { from: r - 1, to: r, where: `messages[${i}] (${pm[i]!.role})`, sent, resent }
    }
  }
  return null
}

export function describeWireBreak(b: WireBreak): string {
  return `request ${b.to} changed ${b.where} that request ${b.from} had sent:\n  sent:   ${b.sent}\n  resent: ${b.resent}`
}
