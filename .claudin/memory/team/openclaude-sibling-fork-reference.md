---
name: openclaude is a sibling fork to mine for features
description: openclaude (sibling Claude Code fork) lives at ../openclaude; feature-gap backlog vs claudin as of 2026-06-23 (v0.19 vs v0.6.9)
type: reference
---

`@gitlawb/openclaude` is a sibling fork of Claude Code (same multi-provider retarget as claudin), checked out as a sibling directory at `../openclaude`. Useful to mine for features/fixes when extending claudin — same architecture (openaiShim, providerConfig, withRetry, Ink TUI, slash commands, MCP).

**Why:** Both forks evolve the same upstream independently; openclaude moves fast on providers + context-mgmt and often lands features claudin lacks.

**How to apply:** Cross-check any candidate against claudin's tree first — several things converged independently (claudin already HAS: `/goal`, reasoned-denial permission prompts, per-agent model routing in `/agents`, bypassPermissions mode, 5xx/HTML-overload retry).

Feature gaps found 2026-06-23 (openclaude HAS, claudin MISSING/PARTIAL) — Tier 1 to port: providerFallbackChain (429→switch provider, PR#1176); credential pool failover for OpenAI-compat keys (#1706); compactModel = cheaper model for compaction (#1629); `/ctx` + token bars in `/cost` (#1610, claudin has `/context` grid only); fuzzy match in FileEditTool (#1561); export to MD/JSON (#1193, claudin `/export` is .txt only); `/update` self-updater w/ PM detection (#1687). Revivable stubs (flag off in claudin): CONTEXT_COLLAPSE span-summarization (#1619), HISTORY_SNIP snip tool (#1407).

Second-batch gaps (verified 2026-06-23): MISSING & worth porting — tool-failure loop guard (stop repeated identical tool failures, persist across successes; PR#1219/#1277); multilingual+structural continuation nudge (claudin's is EN-only `query.ts:1447`, has NO structural detection; reuse phantomLaunchGuard.ts EN+PT-BR pattern; PR#1280); startup safety warning for 3P provider + permissive mode skipping AI classifier (primitives exist: isFirstPartyAnthropicBaseUrl; PR#1260); redacted diagnostic issue report (claudin `/issue` is a disabled stub; PR#1647). Lower-value MISSING: i18n of slash-command descriptions (#1431), JSON-schema non-object root wrap/unwrap (#1261), per-provider env-file (#1668), profile picker modes (#1472). PARTIAL enhancements: /doctor large-context warning not local-model-gated (#1238), disable-thinking per-Ollama-model flag (#1376), cache-break reliability-tier label (#1693, low value).

Already HAS (convergence, do NOT port): dynamic model discovery, Copilot full catalog + Enterprise, keep-thinking-on-resume for reasoning-echo providers, conversation/session persistence, Windows/WSL robustness (grep paths + WSL stdin + raw-mode), eager/deferred tool split (= "system-prompt immediate tools"), /goal, reasoned-denial prompts, per-agent model routing, bypassPermissions, 5xx/HTML-overload retry.

BIG-EFFORT, skip as cherry-pick: detached daemon background SESSIONS (#1642) — needs reviving DAEMON/BG_SESSIONS flags, source not mirrored.

IGNORE: openclaude's sponsor providers (Xiaomi MiMo, Atlas Cloud, Fireworks, NEAR AI, OpenGateway/Gitlawb, OpenCode Zen/Go); their `/bughunter` (claudin keeps it a deliberate disabled stub); their ~50-commit zero-tsc-errors cleanup (claudin baseline ~4320, cosmetic).
