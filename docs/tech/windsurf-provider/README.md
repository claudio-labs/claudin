# Windsurf provider port — research archive (unreachable)

> **Status: the code is gone (verified 2026-09-21).** The branch
> `feat/windsurf-provider` reached 14 commits and a green audit, but it was
> pushed to the **retired self-hosted Gitea remote**. `git branch -a` in a
> checkout whose origin is GitHub finds nothing matching `windsurf`, and `src/`
> carries no windsurf provider slice — the 14 `windsurf` matches under `src/`
> are the *editor/IDE* integration (`commands/ide/`, `platform/ide/`,
> `terminal/`, `shared/editor.ts`, `shared/env.ts`), never a provider. This file
> consolidates the branch-state notes (previously `windsurf-provider-branch-state`
> in team memory) so the audit findings survive the code that produced them.
>
> Same situation as `docs/tech/devin-provider/README.md`. The wire-format
> reference a revival would start from is the sibling checkout
> `../opencode-windsurf-auth/`, described in the team memory
> `windsurf-upstream-reference.md`.

## What the branch reached (2026-06-05, after six audit passes)

14 commits. All P0/P1 correctness bugs from the earlier passes were fixed:

- `scrubSystemSentinel` applied on the array-text path.
- `eventTranslator` try/finally emits `content_block_stop` on a mid-stream throw.
- `ModelNotAvailableError` translates to `APIError(403)` via an exported
  `mapCloudErrors` generator (no longer an inline closure).
- JWT piggyback honors the epoch guard.
- OAuth `flushWaiters` error branch gained a state check — confirmed defensive,
  unreachable today since each `prepareLogin` opens its own loopback with one
  waiter.

Tests at the end: 108/108 windsurf, 494/494 `test:provider`, tsc clean.

## Why the audit passes are worth keeping

Audit pass 5 empirically reverted each "fix" and re-ran the tests, and caught
**two tautological tests** that pass 4 had let through — one was
`expect(true).toBe(true)`, the other re-called `APIError.generate` itself and
asserted on its own output. Pass 6 then broke each production line of
`mapCloudErrors` and confirmed 7 of 8 new tests guarded a real regression.

That break-and-restore methodology is now the standing rule in
`.claudin/rules/agent-safety.md` §4, and the harness that automates it is
`scripts/migrations/probes/` (`break-probe.ts`). This port is where it was first
paid for.

## Known remaining issues, all confessed in the commit messages

Do **not** re-flag these as new bugs if the branch is ever recovered:

- `nonStreaming.ts:142` mints its own `Message.id`, so non-streaming
  `data.id !== request_id`. Confirmed silent: no consumer compares, and
  telemetry used `request_id` only. Commit `a15b5dc`'s claim that "ONE id
  threaded through both withResponse closures" was a partial overclaim.
- The `mapCloudErrors` tests for `unauthenticated` / `CloudAuthError` do not
  actually observe the JWT-clear side effect (there is no public cache reader);
  only the status mapping is locked down. The test names overclaim and were left
  that way deliberately.
- `composeAbortSignal`'s fallback path is dead code under Node ≥ 22.12
  (`AbortSignal.any` is native). Left as belt-and-braces.
- `JSON.stringify(block.input ?? {})` in `messageBuilder.ts:138` has no
  try/catch — a circular ref would throw synchronously. Low risk, since the
  input is Anthropic-supplied.
- A `thinking: {type:'disabled'}` config is silently dropped; reasoning frames
  still surface.
- `nonStreaming` does not merge sequential text blocks when reasoning
  interleaves.

Deferred at the time: P1 #16 clock-skew JWT anchoring, and P2 `sessionCache`
(`session_id` / `cascade_id` never threaded, so the server cache missed every
turn).
