// Fork gate: refuse a fork ONCE when the parent's context is large.
//
// A fork child inherits the parent's whole history and re-reads it on every
// call. The 2026-09-09 fork-vs-fresh A/B (scripts/bench/ab/fork-vs-fresh-ab.ts)
// measured a fork at a 200k parent costing 4× a fresh `Code` agent for the
// same answer; the 2026-09-10 census then watched one session fork seven
// times at ~300k — $35 of sidechain spend, 84% of it inherited reads. The
// system prompt already says to write the brief out for a fresh agent, and
// it was not enough on the day.
//
// Same shape as the Bash→Read/Grep/Git redirects: a `Blocked:` result that
// names the cheaper call, and the IDENTICAL re-send goes through — a fork
// whose question really is about this conversation is one round-trip away,
// never unreachable. Keyed by the prompt text, which is what a re-send
// repeats verbatim.

import { createOneShotMemo } from 'src/tools/shared/redirect.js'

/**
 * Parent context, in tokens, above which a fork is refused once. The A/B
 * measured at 200k; 150k leaves margin below it and sits under the census's
 * 64%-of-calls-above-150k line, which is where the spend was.
 */
export const DEFAULT_FORK_MAX_PARENT_TOKENS = 150_000

/** `CLAUDIN_FORK_MAX_PARENT_TOKENS=<n>` overrides the limit; `0` disables. */
export function forkParentTokenLimit(): number {
  const raw = process.env.CLAUDIN_FORK_MAX_PARENT_TOKENS
  if (raw === undefined || raw === '') return DEFAULT_FORK_MAX_PARENT_TOKENS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FORK_MAX_PARENT_TOKENS
}

const k = (n: number): string => `${Math.round(n / 1000)}k`

export function renderForkGate(parentTokens: number, limit: number): string {
  return [
    `Blocked: a fork would inherit this conversation's ${k(parentTokens)} tokens and re-read them on every call it makes — above ${k(limit)} that is measured at 4× the cost of a fresh agent for the same answer.`,
    '',
    'Delegate with subagent_type: "Code" and a written brief instead: what to find, where to look, what to rule out, what to report, and an output-length cap. A fresh agent starts from the prompt alone, so put the file paths and the question in it.',
    '',
    'If the task genuinely needs this conversation — the user\'s own words, output you already hold — re-send this exact call and it will fork.',
  ].join('\n')
}

const memo = createOneShotMemo()

/**
 * The refusal to return, or null to let the fork through. Refuses only the
 * first time a given prompt is seen above the limit; the identical re-send
 * passes. `0` (or an unset parent size) never refuses.
 */
export function forkGateVerdict(
  parentTokens: number,
  prompt: string,
  limit: number = forkParentTokenLimit(),
): string | null {
  if (limit <= 0 || parentTokens <= limit) return null
  if (!memo.shouldRefuse(prompt)) return null
  return renderForkGate(parentTokens, limit)
}

/** Test-only: forget every refused prompt. */
export function _resetForkGateForTesting(): void {
  memo.reset()
}
