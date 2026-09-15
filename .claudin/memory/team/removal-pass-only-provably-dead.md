---
name: removal-pass-only-provably-dead
description: In a dead-code pass remove only what the build proves unreachable; a behaviour change on a reachable path needs its own approval, and each phase gets its own commit
type: feedback
---

Set mid-flight on 2026-09-15 ([[dead-code-cleanup-2026-09-15]]). The user asked
"mas estamos removendo codigo ativo?", heard the honest list of eight deliberate
behaviour changes they had already approved, and then narrowed the mandate:
**"pode continuar mas sem remover codigos ativos do cli"**.

**Why:** the first half of that cleanup mixed two things — removing code the
build folds away, and deleting reachable surfaces that happened to be broken or
Anthropic-only. Both were approved, but the second kind is a product decision
and the user wants it separated from the mechanical work, not bundled into it.

**How to apply.**

- **Removable without asking:** a branch behind a `feature()` flag the build
  folds to `false`, a call whose destination the build stubs to an empty
  function, a module with no implementation behind its `.d.ts`. State the
  mechanism that makes it unreachable in the commit body.
- **Needs its own approval:** anything a user can reach today, even when it is
  broken, gated by a runtime default, or meaningless for third-party providers.
  Report it and stop rather than folding it in.
- **Leave type-level plumbing on live interfaces alone.** `AttributionState`
  survived the COMMIT_ATTRIBUTION removal because it is a required field of
  `AppState` and threads through `ToolUseContext` and the lifecycle-hook types.
  Nothing increments it any more, so it is inert — but unwinding it is a
  refactor of a live interface, not dead-code removal. Say so in the report
  instead of taking it.
- **When a wrapper function's body empties, that is not a local edit.** Deleting
  the function means following every caller, so it belongs to the slice-removal
  phase rather than a call-site codemod.

**Commit cadence:** the user asked for "ir comitando cada fase" — one commit per
phase, each independently green through the full gate (build, typecheck at zero,
`bun test`, `verify:privacy`, knip, `test:floor`). Note this is the OPPOSITE of
[[feedback-tui-feature-branch-uncommitted-rounds]], which applies to TUI feature
work they validate visually; a long mechanical refactor gets committed as it
goes so the bisect stays cheap under the single-PR plan.
