---
name: Product roadmap 2026-07 (market-gap × codebase audit)
description: Ranked roadmap of 5 opportunities from the 2026-07-17 market research (3 WebResearcher passes) crossed with a codebase capability audit; replaces the fully-shipped token-efficiency roadmap
type: project
---

Roadmap decided 2026-07-17. Method: 3 web-research passes (coding-CLI tool landscape, LLM dev-infra stack, trends/opportunity gaps) crossed with a 10-point codebase capability audit. Supersedes `token-efficiency-roadmap.md` (deleted — its entire BUILD list #1–#7 shipped to main by 2026-06-29; SKIP verdicts condensed below).

**Why:** picks what to build next based on where market gaps intersect code that is already half-present in this repo, and records why the rest was skipped.

**How to apply:** when picking the next feature initiative, start at R1. If asked to build a "não fazer" item, surface the recorded reason first.

## Market context (2026-07)
- Gaps the research converged on: (a) agent reliability in production (deterministic replay, trace→eval, session-level observability); (b) action guardrails/governance (only 21% of enterprises have mature agent governance); (c) per-task economics (caching → batch → confidence-gated routing; pricing shifting per-seat → per-task).
- Background agents (issue/ticket → sandboxed run → PR) are the dominant new surface; GitHub already closes the review loop back to the agent.
- "Just bash" ablations: strong models need few tools; structured tools pay off more for weaker models — relevant for a multi-provider harness.
- MCP won (10k+ servers, Linux Foundation); 2026-07-28 spec RC adds stateless HTTP core, Tasks, MCP Apps.

## Roadmap (ranked)

### R1 — Cost routing per task (effort S, quick win)
`getSmallFastModel()` (`src/utils/model/model.ts:47`) already routes ~15 internal call sites, but there is no user-configurable `compactModel` nor a provider fallback chain. Both are already identified Tier-1 ports from the openclaude sibling fork (`openclaude-sibling-fork-reference.md`). Implements the 2026 cost playbook (routing after caching, which we already lead on). First step: port `compactModel` setting + `providerFallbackChain` from `../openclaude`.

### R2 — Real sandbox backend (effort M, strategic unlock)
The full sandbox adapter EXISTS (`src/platform/sandbox/sandbox-adapter.ts`, ~994 lines, wired into BashTool via `shouldUseSandbox.ts`), but `scripts/build.ts` (~lines 383–420) stubs `@anthropic-ai/sandbox-runtime` with a no-op Proxy — net effect today is permission-prompts only. Writing a real Linux backend (bubblewrap/landlock) reuses all existing plumbing. This is Codex CLI's headline differentiator and the autonomy unlocker both research passes point at (guardrail gap = biggest quantified whitespace).

### R3 — Self-hosted background agent — ✅ IMPLEMENTED 2026-07-17
Shipped (branch `feat/self-hosted-background-agent`, uncommitted at time of note):
`workflow run|watch` subcommands over the existing `/workflows` engine — the
entry surface that was missing. TriggerSource abstraction (github/url/command +
`--match`), headless `runWorkflow`, worktree-per-job + PR-out, atomic dedup. See
`r3-background-agent-implemented.md` and `docs/tech/background-agent/`. Privacy-
first, outbound-only (no webhook server) — the unique differentiator no vendor
offers. Original gap (now closed): the webhook/entry surface driving `claudin -p`
in an isolated worktree → PR + report loop.

### R4 — Record & replay as regression eval (effort M)
All raw pieces exist: per-session JSONL transcripts (+ per-subagent), `--fork-session`, `scripts/profile/fakeProviderE2E.ts`, ~25 benches + A/B harnesses. Missing: the seam — "replay this recorded session against a new build/model and diff behavior/cost". Research says deterministic replay is becoming its own product category; here it doubles as our own regression harness (trace→eval pipeline, the other named whitespace).

### R5 — MCP Apps / 2026-07-28 spec (effort M, speculative)
We are already MCP client AND server (`mcp serve` in `src/platform/main/lifecycle.ts:201`). MCP Apps (`ui://`) support is minimal (touched only in `useManageMCPConnections.ts` + doctor). Spec RC is ~3 weeks old — early-adopter window for Tasks + stateless HTTP core + Apps rendering in the TUI.

## Não fazer (with recorded reasons)
- **Session observability/telemetry export for third parties** — conflicts with the no-telemetry positioning; local `/stats`/`/usage` covers the user's own need.
- **Semantic/embedding repo search** — research confirmed absent from every major CLI and unmissed; grep+outline won empirically. (Also: vector memory skip from old roadmap — LLM-ranked retrieval already exists in `findRelevantMemories.ts`, scale tiny, native deps bundle-stubbed.)
- **LSP beyond current read-only tool** — usage measured ~zero pre-removal; opencode-style *diagnostics-after-edit as a hook* is the only form worth revisiting, NOT more LSP tool surface.
- **Standalone vector DB / RAG infra** — market absorbed into pgvector; not our layer.
- Condensed carry-over SKIPs from the token-efficiency roadmap (full reasons in git history of `token-efficiency-roadmap.md`): tree-sitter code compression (bundle conflict — use `scanSymbols.ts`), ML prose compression / ONNX (bundle), per-turn effort routing (openaiShim binds effort at construction; misclassification risk), BM25/relevance reordering (breaks clip-frontier cache; no query at summarizer call site), cross-agent memory sharing (team/ dir covers it), live dashboards (fabricated CIs; `/usage` line is the right form).

## Open follow-ups inherited from the old roadmap
Project-aggregate persistence of tokens-saved (/usage), runs=3 median A/B for verbosity steering magnitude, 50KB threshold tuning for tool-result persistence, SmartCrusher lossless-first compaction renderer (defer), `scanSymbols` cheap code-outline side-bet: PR #95 was open as of 2026-06-29.

## Cross-cutting invariant
Any new marker/stub/injection MUST sit behind the clip-frontier or it breaks prompt-cache work (`cache-break-audit-2026-06`).
