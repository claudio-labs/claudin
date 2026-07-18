---
name: opencode (SST) feature-gap reference for claudin
description: Port-candidate backlog comparing the SST opencode monorepo at ../opencode against claudin, scouted 2026-06-24; distinct from the openclaude/gitlawb fork
type: reference
---

`../opencode` is the SST opencode monorepo (Effect/Layer everywhere; agent core in `packages/opencode/src`). Distinct from `../openclaude` (gitlawb fork — see openclaude-sibling-fork-reference.md). Scouted 2026-06-24 for features claudin lacks.

**Already in claudin (NOT gaps — verified against Claude Code inheritance):** markdown custom agents (`loadPluginAgents.ts`/`markdownConfigLoader.ts`), markdown slash commands w/ $ARGUMENTS/@file/!`shell`, wildcard permission allow/deny/ask (`settings/types.ts` PermissionsSchema), hooks, fork/auto-background subagents, read-only 9-op LSPTool, /resume + auto-compaction + auto-memory.

**Real port candidates (claudin genuinely lacks):**
- **apply_patch** `tool/apply_patch.ts` — codex-style multi-file atomic add/update/delete/rename; registry SWAPS edit/write→apply_patch for gpt-* models (`registry.ts:273-276`). Low effort, helps OpenAI-compat users.
- **Auto-format on edit/write** `format/` (wired at `edit.ts:156`/`write.ts:65`) — prettier/gofmt/ruff detection. claudin has NO auto-format. Low effort, isolated.
- **LSP diagnostics injected after edit/write** `edit.ts:197-201`/`write.ts:75-90` — claudin's LSPTool is read-only and does NOT auto-inject diagnostics. Medium effort.
- **ACP/Zed adapter** `acp/` (`opencode acp`, Agent Client Protocol over stdio) — diffs/click-to-open/permission prompt, 100% local. `acp/tool.ts`+`acp/permission.ts` liftable. High value.
- **Fuzzy edit (11 replacers)** `edit.ts` — reference impl for claudin's Tier-1 fuzzy-edit backlog.
- **Part-level revert/time-travel** `session/revert.ts:38-137` — snapshot-backed undo per message/part. High value, high effort (entangled w/ message graph).
- **Truncation spill-to-disk + delegate-to-subagent hint** `tool/truncate.ts:129-131`.
- **Background promote-to-foreground registry** `background/` — promote a bg job to foreground.

**Skip:** Share (`share/share-next.ts` uploads transcript to https://opncd.ai — violates privacy stance; build local HTML/MD exporter instead, schema at `share-next.ts:292-298`). Server/SDK REST+OpenAPI (claudin chose gRPC; use endpoint list as parity checklist). websearch Exa/Parallel-via-MCP + webfetch Cloudflare-challenge fallback = minor.

**Tax:** everything is Effect/Layer → de-Effect for claudin's plain Node runtime.

**Refresh round 2 (2026-06-24 PM, repo grew: now has `packages/llm`, `packages/core`).** New self-contained candidates the first scout missed, ranked by value÷effort:
- **`invalid` tool** `tool/invalid.ts` (whole file ~20 lines) — registry routes malformed tool-args to a no-op tool that returns "arguments invalid: …" as a NORMAL tool_result, turning a hard parse error into a recoverable turn. Tiny, copy verbatim. Registered first in builtins (`registry.ts:220`).
- **`doom_loop` detector** `session/processor.ts:522-546` (threshold=3) — last 3 parts = same tool + byte-identical input → permission `ask` "you're stuck". Complements openclaude's tool-FAILURE-loop-guard (this catches identical SUCCESS loops too).
- **Derived subagent permissions** `agent/subagent-permissions.ts` (pure fn, ~27 lines, read in full) — child inherits ONLY parent's `external_directory` + `deny` rules, then auto-denies `todowrite`/`task` unless subagent ruleset opts in (stops recursive task-spawn / todo spam). Directly portable.
- **Bash prefix→arity table** `permission/arity.ts:1-161` (~150 cmds: `git checkout`→2, `npm run dev`→3, `docker compose`→3) — permission patterns match the meaningful command, not flags. Pure data table; cleaner than claudin's bash-filter canonicalizer for perm-matching.
- **Two-tier prune-vs-compact** `session/compaction.ts:251-297` — `prune()` protects recent 40k tok (`PRUNE_PROTECT`), erases older completed tool outputs once erasable>20k (`PRUNE_MINIMUM`), NEVER touches `skill` outputs. Distinct from summarization; mostly pure.
- **`small()` cost·age model scoring** `core/catalog.ts:244-281` — picks cheap compact model (cost·0.8+age·0.2, ≤18mo, name `/nano|flash|lite|mini|haiku|small|fast/`). BUT opencode never wires it to compaction (`compaction.ts:200` uses main model) → claudin can finish the `compactModel` backlog and be AHEAD.
- **Context-overflow regex detector** `llm/provider-error.ts:4-27` — 19 patterns + `4(00|13) no-body` heuristic; drop into claudin `errorUtils.ts` for OpenAI-compat classification.
- **Status→retryable taxonomy + 429 quota-vs-ratelimit body sniff + dual-vendor ratelimit-header parse** `llm/route/executor.ts:112-275` + `schema/errors.ts:42-158` — pure classification tables (strip Effect). 429 + `/insufficient.quota/i`→NOT retryable; plain 429→retryable. 529 explicitly retryable.
- **Single-flight OAuth refresh** `plugin/openai/codex.ts:412-468` — module-scoped `refreshPromise` dedups concurrent token refreshes. Plain Promise, NOT Effect → directly hardens claudin Codex/Copilot/xAI adapters against refresh stampedes.
- **Cross-pending permission resolution** `permission/index.ts:140-177` — replying "always" auto-resolves every other pending request whose pattern now matches; one reject rejects all pending in session.
- **`.env` read = `ask` by default** `agent/agent.ts:130-135` — default ruleset asks on `*.env`/`*.env.*` (allows `.env.example`). Trivial security win.
- **Resumable subagent via `task_id`** `tool/task.ts:121-123` — Task tool can continue a prior subagent's full history instead of fresh spawn; returns `task_id` for parent reuse.
- **Remote skill registries** `skill/discovery.ts:48-95` — `skills.urls` fetch `index.json` registry, download+cache skill files. Also: skills auto-register as `/commands` (`command/index.ts:142-153`); skill load returns rg-sampled file manifest (`tool/skill.ts:35-67`).
- **mcp-websearch** `tool/mcp-websearch.ts` (read in full) — Exa/Parallel via raw JSON-RPC `tools/call` over HTTP, dual JSON+SSE `data:` parse; websearch A/B-splits providers by `checksum(sessionID)%2` (`websearch.ts:30-37`).
- **4-breakpoint shared-counter cache budget** `llm/protocols/utils/cache.ts:10-34` — `{remaining,dropped}` counter threaded across tools/system/msgs, drops markers past cap to avoid provider 400. Cleaner marker-capping; compare to claudin clip-frontier. Note: opencode anchors cache on LATEST USER MSG (weaker — invalidates per turn) vs claudin's frontier cap.
- **Plan→build handoff** `tool/plan.ts:30-69` + `session/reminders.ts:15-90` — plan_exit writes plan .md, asks to switch to build agent, injects per-turn "execute plan at X" reminder.
- Bigger/tangled (note, don't rush): snapshot shadow-git via `objects/info/alternates` seeding for fast snapshots on huge repos (`snapshot/index.ts:206-241`); tree-sitter shell-cmd AST → per-path `external_directory` perm (`tool/shell.ts:188-291`); 30-formatter roster (`format/formatter.ts:18-404`).

**Confirmed ABSENT in opencode (no port source here — these live in ../openclaude):** provider-failover chains, credential/key pools. de-Effect tax still applies to everything in `packages/llm` + `core`.
