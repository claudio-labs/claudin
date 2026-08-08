---
name: tier3-file-split-roadmap
description: The Tier-3 giant-file split roadmap (item 11a-11m) lives only in a DELETED ROADMAP.md — recover it with git show; 11b/11e are now done, 11i/11j/11k remain
type: project
---

The plan that drove every `src/<area>/` barrel-plus-siblings cluster in this repo
is **ROADMAP item 11**, and it is not in the working tree: `ROADMAP.md` was
deleted in `367058c2`, and an unrelated token-efficiency ROADMAP.md briefly
occupied the same path before that. Recover the real one with:

    git show cbf3325d:ROADMAP.md      # Tier 3 section, items 11a-11m

It is the only place the per-file suggestion, effort/risk grade and — critically —
the **deferred remainder** of each split are written down. Two of those deferrals
were worth more than the entries themselves:

- **11b** deferred "extração de `runHeadlessStreaming` em arquivo próprio com DI
  explícita (`HeadlessStreamingDeps`)".
- **11e** deferred "REPL.tsx mantém controllers (`onSubmit`/`onQuery*`) e
  composição. Controllers ficam para um trabalho futuro."

**Both were executed 2026-08-07** — `runHeadless.ts` 4197→604 across 9 siblings in
`src/cli/print/`, `REPL.tsx` 4369→3145 across 5 hooks in
`src/screens/repl/controllers/`. No non-test source file is above 4k any more; the
largest remaining are `openaiShim.test.ts` (4618) and `bashFilter.test.ts` (3966),
both tests. Still open from the list: **11i** `services/mcp/client.ts`, **11j**
`services/api/claude.ts`, **11k** `services/api/openaiShim.ts`. 11l (bridgeMain,
feature-gated off) and 11m (ansiToPng, base64 assets) are marked won't-do with
reasons.

## Two traps a file split hits here that a normal refactor does not

- **Some tests read source files as TEXT.** `stableStubState.eviction-cache-break.test.ts`
  `readFileSync`s the production file and asserts on literal call strings, so
  moving the code makes it fail even though behavior is identical — and it is
  invisible to a test run scoped to the directory you edited. Grep the whole repo
  for the filename you are splitting before believing a scoped run is green.
- **The typecheck ratchet fingerprints include the file path**, so a split shows
  up as N new + N fixed. That is the documented refresh case, but prove it is a
  relocation before refreshing: capture `tsc` at HEAD (a worktree outside the
  repo, `node_modules` symlinked) and diff the **path-normalized message
  multisets**, not the counts. The 2026-08-07 split came back 2841→2837 with zero
  new error kinds; the handful that looked new were the same mismatch printed with
  a different union-member order or diagnostic code. (Those two figures are the
  split branch pre-merge — `main` reads 2820 the same day. See
  [[typecheck-backlog-shape]] before citing any absolute total.)

See also [[coding-gotchas-go-in-rules-not-memory]], [[typecheck-backlog-shape]].
