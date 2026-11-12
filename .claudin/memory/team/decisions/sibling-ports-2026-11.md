---
name: sibling-ports-2026-11
description: The 2026-11-12 round against opencode and openclaude (a838b670..2d98d107) — what was ported on fix/sibling-ports-2026-11 (10 inherited bugs, .env read ask, auto-mode ask-rule hole, JSON error marker), the review round's 9 fixes, and every candidate dropped, with the measured reason
type: project
scope: providers, permissions, mcp, plugins, terminal
impact: functional
paths:
  - "src/permissions/filePermissions/dangerousPaths.ts"
  - "src/permissions/classifierDecision.ts"
  - "src/providers/shims/openaiErrorClassification.ts"
---

**Decision (user, 2026-11-12):** port the inherited bugs and the small, token-free ports; drop the rest.
Branch `fix/sibling-ports-2026-11`, one PR, one commit per area, red test commits first.

**Ported:**
- wrap-ansi pinned to 9.0.2. Version 10 expands tabs, so `Cursor` threw on the Node path (npm/dist). The binary uses `Bun.wrapAnsi`. `wrapAnsi.test.ts` holds npm == Bun, so a bump to 10 goes red in CI.
- MCP stdio `maxBufferSize` set to 128 MiB, client only. `mcp serve` is broken by the stub.
- CONNECT proxy: a `TargetTlsHttpsProxyAgent` hands the CA and mTLS options to `connect()`.
- Marketplace git calls all lead with `GIT_NO_HOOKS`. The sparse `checkout HEAD` used to run a global post-checkout hook.
- A hook carrying `args` is refused with `status: 1`. The schema keeps `args`, so the settings stay valid.
- `checkPathExists` uses `existsSync` instead of a shell `dir`.
- `reasoning_content` survives the assistant merge. This is a defensive guard: no claudin flow was found that produces the merge.
- **The shim's JSON error bodies kept no `[openai_category=…]` marker** (since the first commit). `APIError.generate` builds its message from the parsed body, so `error.message` is now set back after generate.
- 403 with a structured rate-limit signal: Retry-After, `x-should-retry: true`, or a rate-limit code or type in the body. It is retried like a 429. Prose alone does not count; openclaude spent 8 iterations on prose vetoes.
- An OpenAI-compatible `context_overflow` becomes `PROMPT_TOO_LONG_ERROR_MESSAGE`, so the compaction retry works on shim providers. The phrases come from opencode, with throttle exclusions.
- `/models` discovery reads `context_window`, `max_context_length` and `max_model_len`, first positive number wins.
- Auto mode: an ask from a rule or a `safetyCheck` no longer takes the allowlist or read-only fast path (`askMayTakeAllowlistFastPath`). A user's `Read(./secrets/**)` ask rule used to be a silent allow.
- **.env read ask**, a non-approvable `safetyCheck`. It applies at all three read gates: `checkReadPermissionForTool` with the batch Read, the Bash `isPathAllowed`, and the PowerShell mirror. A batch binds the strictest reason. Templates (`.example`, `.sample`, `.template`, `.dist`) are free. **Only an allow rule whose pattern names a .env opts out** (`envFileReadAllowRule`). The first version honored any matching allow rule, and the live check under `/tmp` was silently allowed by a user `Read(//tmp/**)`.
- `request-census` gained an InputValidationError-per-family table.

**Dropped, and why:**
- Built-in LSP servers, LSP recommendation, `/lsp`: removed on 06-17 ([[lsp-tool-reintroduced-plugin-only]]).
- Formatter-on-write: it rewrites the file under the model, so stale Edits follow. A PostToolUse hook covers it.
- Repo map: rejected twice. keybindings.json: deleted on 09-25 as unused.
- Skill file sample and the maxTurns wrap-up turn: tokens per load or per turn. Doom-loop: no census showed it.
- Key pool / smart routing: the provider is process-global (#341). Keep-alive stop-on-miss: only with census evidence.
- Truncation notice: `max_tokens` already auto-resumes ×3 (`query.ts:143`), and a notice is re-sent assistant text.
- Read on a directory: 5 real EISDIR errors in the whole transcript corpus.
- Proxy dispatcher reset: rare trigger, global undici state, 4 upstream iterations.
- Cross-pending "always": claudin already rechecks the queue (`useToolUseContext.ts:192-204`).
- **Tool-arg coercion:** the census of 2026-10-29..11-12 (5 projects, ~21k tool uses) found 12 InputValidationErrors, only 1 a wrong type. Re-run `request-census` before reopening.
- Command palette, tabs, embedded terminal, ACP/Zed: no demand signal.

**Review round (3 agents, same day), 8 fixes the full suite and the live checks had missed:**
- A rate_limited 403 skipped the long-reset stop and the quota check, both 429-only (`rateLimitInfo.ts` `isRateLimitStatus`). An 8 h Retry-After slept 8 h ×10.
- Grep printed `.env` content: it checked only its root. A search now passes `!.env`, `!.env.*`, `!*.env`, and a glob naming one asks. Templates leave the sweep too: a positive rg glob turns every glob into a whitelist, so they cannot be re-included. Named as the path, they are still searched.
- Bash `cat .env*` / `./*.env` were judged by the glob's base dir, and `tac` had no path check at all. `globCouldMatchEnvFile` (picomatch, `dot` per shell).
- The opt-out regex matched `.env` anywhere in a rule (`Read(~/.envs/**)`): only the rule's last segment counts now. A `.env` directory (venv) and `.env.ts` no longer ask. The ask offers `Read(<file>)` (the Bash prompt offered a dir rule the guard ignores).
- Overflow: "exceeds the limit of N" needs `tokens` (images and tool counts used it), and monthly/daily token-limit quotas are excluded. The `^throttling error:` exclusion never matched a JSON body.
- Discovery: `??` stopped at a `0`/`-1`/string. `meta.n_ctx_train` is dropped: it is the trained context, not the server's `-c`.
- The JSON marker fix hid the server's words behind per-category hints (`errorDetails` renders nowhere). The hint is now followed by the server's own message.
- A PreToolUse hook with `args` failed open (status 1): it now exits 2 there, and 1 elsewhere, since 2 on Stop forces a continue.
- Found by the live check after the fix round: the marked 403 stopped at its 8 h reset but said "no reset time reported". The marker branch now formats the `extractRateLimitInfo` a 429 gets.
- Not fixed, by choice: wrap-ansi 9 splits ZWJ emoji and drops ANSI on wrap under Node, the same as Bun, and parity was the goal. A JSON 404 retried 2×: the design of the 404 retry.

**Evidence:** `scripts/migrations/probes/inheritedBugs20261112.json` (41 probes, all red on break).

Live on the built bundle:
- A fake OpenAI server: a 403 with Retry-After, then a llama.cpp overflow, became a retry and then "Prompt is too long".
- Haiku `-p`: `.env` Read and `cat .env` denied, `.env.example` read.
- Auto mode `--debug` logged `[auto-mode] new action being classified: Read …secrets/key.txt`.
- A Node-bundled Cursor driver measured a tab without throwing.
- After the review round: a 403 with an 8 h Retry-After ended in 1 s with "resets in 8h"; a JSON 500 retried, then showed "CUDA out of memory"; a tool-count 400 was not prompt-too-long; Haiku's recursive Grep skipped `prod.env` and showed the template; `cat *.env` and a `*.env` Grep glob were denied; `ls .env` on a venv ran.

**Traps hit:**
- `fastMode.test.ts` mocked axios without re-pinning it, which broke `axios.create` only in the full run (fixed).
- A text pin in `envNaming.test.ts` reads any `CLAUDE_*` literal, model ids included.
- `throwClassifiedHttpError`'s own classify call is unreachable, because both callers pass a preclassified failure.
