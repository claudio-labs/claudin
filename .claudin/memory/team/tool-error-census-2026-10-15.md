---
name: tool-error-census-2026-10-15
description: Tool error census 2026-10-08..15 — real traffic 14,878 calls / 333 errors (2.2%); Edit/Write/Patch read-gate refusals ~0 on 1.1.44; 8 harness causes (~58 errors/wk) fixed on fix/tool-error-census-2026-10-15 - classifier API refusal, MCP 2020-12 schemas, clip-stub echo, Git --format split and no-upstream, Read file_paths of one, agent notifications held to turn end, TaskOutput after eviction
type: project
---

Paired tool_use↔tool_result over every transcript modified since 2026-10-08,
deduped by tool_use id, `-tmp*` bench projects split out (`census.ts`,
`buckets.ts`, `detail.ts`, and a reviewer's `audit/*.ts`, in that session's
scratchpad — rebuild rather than hunt). Real: **14,878 calls, 333 errors
(2.2%)**; bench 2,156/127. Top: Bash 72/3977 (mostly real command failures),
Git 53/808, playwright MCP ~75 (page selectors), ExitPlanMode 28 (rejections).

**#292 verified:** after 1.1.44 was installed (10-13 23:14Z) Edit/Write/Patch
had no read-gate refusal except one 27 s after the install, in a session
started before it (`toolu_018EgrqsmhArZS5kNYqxv2h3`).

**Harness causes fixed** (`scripts/migrations/probes/toolErrorCensus1015.json`,
42 probes, all red):
- **Classifier API refusal — 32 denials**, all at stage 2 "unparseable
  (stop_reason=refusal, 0 output tokens)", in runs (13 in one infra-home-lab
  session): the API declining the classifier request, not a verdict. `refused`
  → manual approval interactively, the ordinary denial headless; never
  retried (was 3 calls); a stage 1 with no verdict and a refusal skips stage 2
  (defensive — the census had none). `classifierFallback` in
  `permissions/permissions/denial.ts`.
- **MCP `$schema` 2020-12** (zod v4, @playwright/mcp): draft-07 Ajv refused
  every call of the server; the user wrote
  `infra_home_lab/.claudin/mcp/playwright-proxy.mjs` to strip it. Ajv class
  by declared draft (`tools/shared/jsonSchemaDraft.ts`, also used by
  StructuredOutput's `--json-schema`). An uncompilable schema lets every call
  through — remembered in a WeakSet, because Ajv caches a schema before the
  meta-schema check, so only the FIRST compile throws. Live: 1.1.44 fails,
  branch passes.
- **Clip-stub echo — 4** (3 errors: Patch "missing Begin/End"; 1 Edit that
  wrote the stub into a test, is_error=false). `agent/tools/clipStubEcho.ts`
  refuses a `clearableInputFields` field holding its own stub.
- **Git `--format=%h %s` unquoted — 6**, four sub-agents of one session,
  under "revision does not exist". The diagnosis names the split and writes
  the quoted form: nearest valued flag (`--date=format:%Y %H` too) or bare
  `--format`, through git's word and later placeholders; generic when another
  option sits between, nothing past the flag holds `%`, or it was quoted.
- **Git `rev-parse @{u}` on a never-pushed branch — 8:** a read's "no
  upstream configured" is an `answer` — not an error, ✓ in the UI, does not
  stop a later write.
- **Read `file_paths` of one — 4:** read as `file_path` (`readMulti.ts`
  `singleEntryAsFilePath`, a root preprocess — schema bytes unchanged), and
  the transcript walkers (resume, compaction, plan dossier, activity line,
  insights) read it the same way. A one-entry list is a batch only under
  CLAUDIN_READ_GLOBS, decided by the flag at read time.
- **Background-agent notifications held to turn end — 3 TaskOutput "No task
  found"** (a 4th was a made-up name): agents enqueued at `later`, which only
  a Sleep flushed mid-turn, and this build has NO Sleep tool. One report
  waited 39 min while the task was already evicted. Now `priority: 'next'`;
  TaskOutput's not-found names the saved output when the file exists.
  Making WaitFor flush `later` was tried and reverted: it would pull peer
  notices (meant to wait for the turn) and cron prompts into the turn.

**Not fixed:**
- `git pull`/`checkout` blocked by a dirty tree — 15 (14 Git, 1 Bash); the
  dirty files are the harness's own (`.claudin/rules/search-strategy.md` from
  the map sync, team-memory writes). The diagnosis names `--autostash`;
  `git config --global rebase.autoStash true` removes the pull bucket.
- Commit `-m "…"` with backticks — 3 (by design). Grep `-o`/`exclude` — 3.
- Portainer `outputSchema` without structured content — server bug.
- WaitFor `(?s)` mid-pattern — 1 (#288 fixed the leading form). Resumed
  sub-agent without Git — 2, pre-#288, fixed there.
- Eviction before delivery stays possible when the next tool round is longer
  than the 30 s panel grace — a TaskOutput miss only: the queued notice still
  carries `<result>`, and TaskOutput names the saved file. Left on purpose.
- WaitFor `(?s)` mid-pattern and the fixed `origin` in the no-upstream answer
  (`GitTool/errors.ts`): left on purpose, 1 case and repo-specific.

**Follow-ups fixed (branch `fix/subagent-background-inline`):**
- A background agent launched BY a sub-agent reported to main (its notice
  named no `agentId`) and the sub-agent never heard back. Rather than route
  it: only main owns background agents (`ownsBackgroundAgents`,
  `AgentTool/autoBackground.ts`) — a sub-agent's spawn, auto-background, 120 s
  timer and Ctrl+B stay inline, since a sub-agent never idles for a notice.
- "A classifier block never becomes an allow" was pinned on permissions.ts's
  text. The block now resolves in `decideClassifierBlock` (`denial.ts`), typed
  ask | deny; `denial.types.test.ts` makes widening it a tsc error.
- Probes: `subagentBackgroundInline.json`, `classifierBlockDecision.json`.

**How to apply:** re-run the census a week after the merge. Expect 0
"unparseable (stop_reason=refusal" denials (they become prompts), 0 "Failed to
compile JSON schema", 0 "missing Begin/End" from a stub, 0 "Too small …
file_paths", 0 no-upstream Git errors, TaskOutput not-found ≈ 0. Related:
[[edit-write-error-census-2026-10-12]], [[devtool-error-census-2026-10-11]],
[[tool-error-census-2026-09-20]].
