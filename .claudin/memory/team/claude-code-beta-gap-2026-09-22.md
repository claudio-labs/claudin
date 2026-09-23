---
name: claude-code-beta-gap-2026-09-22
description: The 9 anthropic-beta headers Claude Code 2.1.280 sends and Claudin does not, measured on the wire — which already exist behind the experimental switch and which have no code at all
type: project
---

Measured 2026-09-22 while registering Opus 5.5, by capturing both CLIs' real
request bodies (`scripts/bench/tokens/wire-diff.ts`, OAuth session, same model).
**Deferred to its own round — nothing here was changed on `feat/opus-5-5`.**

Claude Code sends 14 betas, Claudin 6. The nine it lacks split into three
groups, and the split is the whole point: most are not missing features.

**Already implemented, off only because of the default switch.**
`src/platform/entrypoints/cli.tsx:74` runs
`process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS ??= 'true'`, so everything
behind `shouldIncludeFirstPartyOnlyBetas()` ships disabled unless the user opts
out with `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=false`:

- `context-management-2025-06-27` — and with it the server-side
  `clear_thinking_20251015` edit that `src/agent/cache/anthropic/apiMicrocompact.ts`
  already builds. Also needs the RETAIN cache profile (`serverToolClearEnabled`
  is false under aggressive).
- `prompt-caching-scope-2026-01-05`
- `thinking-token-count-2026-05-13` and `redact-thinking-2026-02-12` — these two
  also require an interactive session.

**Conditioned on something else, not on the switch.**

- `advisor-tool-2026-03-01` — emitted from `streaming.ts` when the advisor runs.
- `afk-mode-2026-01-31` — behind `feature('TRANSCRIPT_CLASSIFIER')`.

**No code at all** (zero matches under `src/`):

- `mid-conversation-system-2026-04-07`
- `per-turn-control-2026-07-01`
- `mid-conversation-tool-changes-2026-07-01`
- `dangerous-tool-use-2026-09-03` — the `safeguards` body field, a server-side
  dangerous-tool classifier with no counterpart here.

**The one with a running cost.** `thinking.display: "omitted"` rides on
`redact-thinking`, so by default Claudin never omits thinking text while Claude
Code always does — full reasoning text comes back on every response, on every
model. Token cost, not a failure; the best candidate to pick up first.

**NOT a gap, do not "fix" it:** Claudin sends `thinking.block_binding` and
`thinking-binding-controls-2026-08-01` where Claude Code sends neither. That is
deliberate — Claude Code does not rewrite its own prefix, Claudin does. See
`docs/tech/opus-5-5/wire-capture.md`.

**How to re-measure** (no real API calls, both harnesses are committed):

```
bun run scripts/bench/tokens/wire-diff.ts --model=<id> --a=claude --b=claudindev --full
bun run scripts/bench/tokens/thinking-replay-capture.ts --bin=claudindev --full --user-turns=4
```

Strip `CLAUDIN_*` from the child env before believing any beta diff — a session
running with the switch set hands it to the child and the gap reads bigger than
it is. Both harnesses do that already.

Related: [[defingerprinting-branch-2026-08]]
