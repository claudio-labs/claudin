---
name: R3 self-hosted background agent — implemented
description: workflow run|watch commands, TriggerSource abstraction (github/url/command + --match), status/where-it-lives; supersedes the "planned" R3 line in the roadmap
type: project
---

R3 (self-hosted background agent, from roadmap-2026-07) is **implemented** as of
2026-07-17, on branch `feat/self-hosted-background-agent` (uncommitted at time of
writing). It is a thin ingress over the existing `/workflows` engine — no new
run engine.

**Why:** market-gap item — vendor "issue→PR" background agents, but self-hosted,
outbound-only (no webhook server/port), privacy-first, under the user's own creds.

**How to apply / where it lives:**
- `src/main/commands/workflow.ts` — `workflow run <name> --task …` and
  `workflow watch --workflow …` subcommands (gated by `AGENT_WORKFLOWS`, on).
- `src/cli/workflow/runWorkflowHeadless.ts` — headless `ToolUseContext`
  (mirrors `src/entrypoints/mcp.ts`), calls `runWorkflow` directly (NOT the `-p`
  loop), `bypassPermissions` session; worktree + report + PR + exit code
  (0=done, 1=not-done/threw, 2=invalid/worktree-fail).
- `src/cli/workflow/sources.ts` — `TriggerSource` interface + 3 impls:
  `github` (labeled issues via gh, comments PR back), `url` (HTTP GET),
  `command` (local shell cmd, reads stdout). Shared pure `parseFeed(kind,…)`:
  JSON array / `{tasks|items}` → task per element; else content-hash trigger.
  Ids are prefixed per source (`gh#`/`url#|url:`/`cmd#|cmd:`) to avoid collisions.
- `src/cli/workflow/watchLoop.ts` — source-agnostic serial poll loop; `--match
  <regex>` filter (`compileMatcher`/`itemMatches`, tested against title\nbody;
  filtered items NOT marked processed); ref'd sleep timer.
- `src/cli/workflow/watchState.ts` — atomic (temp+rename) processed-id dedup at
  `.claudin/workflow-watch-state.json`.
- Docs: `docs/tech/background-agent/README.md` (comprehensive) + README.md feature line.

**Tests:** `src/cli/workflow/*.test.ts` (34 pass). 3 reviewer-bugs agents ran
2026-07-17 and their findings were fixed: worktree-leak-on-chdir, `--pr`-no-worktree
`git add -A`, non-atomic state write (dup-PR risk), PR-regex line anchor,
extractPrUrl bogus-fallback. Injection-safe (execFileNoThrow shell:false); privacy clean.

**Out of scope (v1):** inbound webhooks, parallel jobs, sandbox (=R2),
non-GitHub forge report-back, committed GH Action template.
