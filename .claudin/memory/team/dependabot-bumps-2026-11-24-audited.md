---
name: dependabot-bumps-2026-11-24-audited
description: Dependabot #358/#359/#360/#361 (2026-11-24) — ansi-tokenize 0.4.0 needed readonly AnsiCode[] typings in the Ink renderer; type-fest 6, indent-string 6, knip 6.47, SDK 1.11 audited, no action
type: project
---

All four merged one at a time (squash). Only #359 needed code. #358/#360/#361
were red on the three provider-test leaks `78672770` had already fixed on main
(#362); `@dependabot rebase` cleared them. Rebased all three at once: each
stayed `CLEAN` after the one before it merged, so no second rebase was needed.

- **Trap:** on #359 `@dependabot rebase` answered "I don't have any knowledge
  about this pull request" and left it `DIRTY`. Fixed by hand without a force
  push: merge `origin/main` into the branch, take each side's bumped line in the
  `package.json` / `bun.lock` workspace block, then `bun install
  --frozen-lockfile` passes and a plain `bun install` leaves the lock unchanged.

- **@alcalzone/ansi-tokenize 0.3.1 → 0.4.0 (#359) — readonly typings.** A style
  run now shares ONE `styles` array, typed `readonly AnsiCode[]`, so
  `typecheck:ci` failed in `output.ts`. `StylePool` (`screen.ts`) now stores and
  returns `readonly AnsiCode[]`, and `output.ts` / `log-update.ts` follow. Safe
  because nothing mutates a pooled array: `withInverse` spreads,
  `withCurrentMatch` / `withSelectionBg` filter before `push`. The typings do NOT
  compile against 0.3.1 (its `diffAnsiCodes` takes a mutable array), so the fix
  had to ride the bump's own branch, not land on main first.
  A/B over 0.3.1 vs 0.4.0, all four in 0.4.0's favour: bold+dim → bold emitted a
  bare `22m` and dropped the bold (`StylePool.transition` uses `diffAnsiCodes`);
  colon SGRs (`38:2::r:g:b`, curly `4:3`) were dropped from cell styles, so tool
  output lost those colours; `58;5;N` underline colour split into a bogus
  `\e[196m`; an OSC 8 link closed with ST never closed. Residual: `\e[4:0m` is
  now kept as an active style, harmless.
- **SDK 1.8 → 1.11 (#359), no action.** 1.9's stricter streamed-tool-input JSON
  parser only runs in `MessageStream`; `claude/streaming.ts` uses the raw stream.
  1.9 deprecates `extended-cache-ttl-2025-04-11` and `cache-diagnosis-2026-04-07`
  — both still sent, kept because Claude Code 2.1.322 sends both. 1.10 adds
  typed 429 `ContractSpendLimitReachedError`; Claudin reads no `errorCode`, so a
  spend-limit 429 retries unless the server sends `x-should-retry: false`
  (unmeasured). undici 8.13, marked 18.2.1 (task lists unchanged; fenced code
  keeps trailing blank lines), ignore 7.0.16: fixes only.
- **type-fest 6.0.3 (#360), no action.** v6 declares
  `exactOptionalPropertyTypes: false` unsupported; this tsconfig has it off. Only
  `Except` (Box, Button, ScrollBox) and `IsEqual` (the hooks schema assertion in
  `shared/types/hooks.ts`) are used. Probed on v6: `IsEqual` still refutes an
  extra optional key, an extra required key and a widened field; `Except` still
  removes the named keys.
- **indent-string 6.0.0 (#361), no action.** One call,
  `render-node-to-output.ts` without `includeEmptyLines`, so the CRLF fix does not
  apply. The new regex uses the `v` flag — runs under Bun 1.3.11 and Node.
- **knip 6.47 + @types/bun 1.4.5 (#358), no action.** Dead-code count unchanged
  (1129 against a 1145 baseline from 11-09, so a refresh would tighten it).
