---
name: Cache TTL tiering for subagents (5m) + slim-subagent attachment fix
description: c43aab2/6257f0f (2026-07-05) — agent:* and short-lived utility querySources get 5m TTL, fork keeps 1h; omitClaudeMd now honored in attachment pipeline; deferred findings list, incl. the 2026-09-20 measurement that a Bash call >5 min inside a 5m-TTL sub-agent rewrites its whole prefix
type: project
---

Shipped 2026-07-05 on main (c43aab2 + 6257f0f):

1. **Slim-subagent attachment fix** — `omitClaudeMdAttachments`/`omitGitStatusAttachments` on ToolUseContext (set by runAgent from AgentDefinition, inherited by forks in createSubagentContext) gate `claude_md_delta`/`memory_delta`/`nested_memory`/`git_status_delta` in pipeline.ts. Before, Explore/Plan/WebResearcher got full CLAUDE.md + rules + memory re-injected despite `omitClaudeMd: true` (the attachment pipeline read globals, bypassing runAgent's userContext strip).
2. **Cache TTL tiers** — `should1hCacheTTL` (cacheControl.ts) now: `agent:*` → 5m (1.25x write) EXCEPT `agent:builtin:fork` (shares main thread's 1h prefix); `SHORT_LIVED_QUERY_SOURCES` denylist (web_search_tool, agent_summary, away_summary, hook_prompt/agent, etc.) → 5m; main thread/compact/session_memory/speculation/prompt_suggestion/side_question/magic_docs/auto_dream keep 1h (they fork the main thread's prefix). `auto_mode` was initially in the 5m set, REVERTED to 1h in 44e197f: the yoloClassifier caches a transcript-sized prefix that grows all session and fires per tool call — a mini main thread; >5min pauses would force full 1.25x rewrites at 5m.

**Why:** subagent caches die with the run; reads refresh 5m TTL for free, so 1h's 2x write never amortizes. Also fixes ~10KB rules re-injection per Read in Explore agents.

**Deferred findings from the 2026-07-05 code review (accepted trade-offs):**
- `agent_summary` at 5m mismatches when summarizing a FORK child (fork = main thread's 1h line) — dormant while autoBackgroundAgentsEnabled defaults false.
- Long-lived `agent:*` threads (teammates 'agent:custom' behind CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS; background agents idling >5min via Monitor/long Bash) pay rewrite-per-wake at 5m; no per-agent TTL knob exists.
  **Measured 2026-09-20:** in the 09-14..20 window, 4 full rewrites (~300k
  each, 1.2M tokens) in two `d606547d` sub-agents, each right after a Bash
  call that ran 7–14 min (timeouts 620–1250s); the week had 505 Bash calls
  with `timeout ≥ 300000` and 277 ≥ 600000. Any of those inside a 5m-TTL
  agent expires the prefix before the next call. Candidate fixes: a
  keep-alive request (`max_tokens:1` against the same prefix ≈ ctx×$0.5/M,
  ~$0.15 at 300k vs a $2 rewrite) fired at ~4.5 min into a running tool, or
  the Bash tool refusing timeout >5 min inside a sub-agent in favour of
  `run_in_background` + `WaitFor`. See [[weekly-token-census-2026-09-20]].
- compact-inside-subagent stamps 1h on the subagent's 5m prefix (~2k-token tail, once per compaction — small).
- SHORT_LIVED set is untyped string literals; `src/constants/querySource.ts` is absent from the repo so Set<QuerySource> can't enforce membership.
- Deeper fix candidate: thread runAgent's resolvedUserContext/systemContext into the attachment producers (injections.ts reads globals) so the boolean flags become unnecessary; new global-reading producers currently bypass the gate silently.

**How to apply:** new one-shot utility querySources must be added to SHORT_LIVED_QUERY_SOURCES or they default to the expensive 1h tier; anything that re-sends the main thread's prefix must NOT be added.
