---
name: rule-map-end-of-turn
description: Since PR 287 (merged 2026-10-11) the navigation map is synced at the end of a main-thread turn, not at startup, with a stateless dirty gate, a rule_map footer task and the /map command; an automatic LLM annotation fork was rejected
type: project
scope: memory/instructions (navigation map), agent/tasks
impact: functional
paths:
  - "src/memory/instructions/ruleMap*.ts"
  - "src/agent/tasks/RuleMapTask/**"
---

**Decision:** `.claudin/rules/search-strategy.md` is synced by `ruleMapScheduler.ts`
from `handleStopHooks`, beside auto-dream, on the main thread only. The sync left
`setup.ts`. A turn costs two `stat`s (`<gitdir>/index` and the map itself) unless
one moved. An uncommitted map still heals when its diff against `HEAD`, or against
the index for a staged map, is only numbers the healer manages (`isHealerOnlyDiff`).
On a generated map, every entry must match its committed line apart from counts and
connectors, a new entry must read exactly `name/ (N) ← TODO`, and a dropped entry
must be a directory that now holds too few files. A generated map whose tree holds
text a redraw would drop is `edited` (`ruleMapKind`): text beside a count, a line
that is not an entry, or a duplicate directory. An edited map heals numbers only, so
nothing is deleted and it does not freeze. Glosses are kept whole past a second `←`.
The git paths are posix `HEAD:./<path>`, so subdirectory roots work (Windows is
untested, though the path no longer carries `\`). CRLF is normalized. A write shows up three ways, all using the
`describeRuleMapWrite` clause (`updated · src/x/ 1→9`):
- a transcript line `Navigation map · <path> · …`, at level `suggestion`;
- a `rule_map` task in the footer's `Maps` group, held for 8 s by the generic
  `holdTerminalTask` (framework.ts), reachable with ↓, its detail view pinning it
  open (`pinTerminalTask`/`releaseTerminalTask`);
- `/map status|sync|on|off|annotate`.

`/init` syncs the map itself before Phase 4.5, unless `/map off`
(`syncRuleMapIfEnabled`). `/map sync` and `/map annotate` override the switch on
purpose and pass `announce: false`, because the command result reports the outcome.

**Why:** startup had three costs that are not visible in the diff.
- **The map froze.** The first heal left the file `M`, and `M` read as "the user is
  editing", so no heal ran again until someone committed. Main sat that way with
  `tools 682→751` uncommitted.
- **The heal landed in the next session**, usually somebody else's, as an unrelated
  diff.
- **Three git spawns were awaited before the first prompt.**

A mid-session write is cache-safe: no prefix is rewritten. A map not yet injected
loads the new bytes; one already injected is in `readFileState`, so the model gets
an `edited_text_file` diff appended to the next turn (it does NOT stay as sent).

**What changes for a teammate:**
- **The map can change mid-session.** Expect `M .claudin/rules/search-strategy.md`
  in `git status` after a turn that staged or committed files. Stage it by name if
  it belongs in your commit.
- **A test that drives stop hooks is safe.** The scheduler is a no-op until
  `initRuleMapSync()` (backgroundHousekeeping), so it cannot write the real checkout.
  A test that calls `/init` or `/map sync` must set `CLAUDIN_DISABLE_RULE_MAP_SYNC=1`,
  because the project root under `bun test` is this repo.
- **`holdTerminalTask` is reusable.** Any task that ends too fast to be seen can
  call it once terminal + notified: it sets `displayUntil`, arms the eviction, and
  the per-turn GC leaves it alone. `isListedBackgroundTask` lists it;
  `isBackgroundTask` (headless wait, running pill and counts, kill hints) still
  says no.

**Rejected:**
- **An automatic LLM fork, in the style of dream, that fills `TODO`s and places new
  directories.** The user chose deterministic only. A fork costs tokens on every run
  and writes judgment into a tracked file. Annotation stays on demand
  (`/map annotate`, `/init`).
- **Recording the hash of our last write in project config.** The stateless diff
  check works across machines and pulls, which a per-user hash cannot.
- **A lightweight status line instead of a real task.** The user wanted it beside
  the dream icon and in the Shift+↓ dialog.
- **Faking `running` for the display window.** It would hold `-p` exit at
  `turnLoop.ts:686`.
- **Splitting into two PRs.** The user chose one.

**Known gaps, 2026-10-11:**
- The nf-md-file_tree glyph (U+F0645) is unverified on the user's font. tmux showed
  the `Maps` fallback.
- System messages at level `info` are hidden outside verbose mode
  (`SystemTextMessage.tsx:197`), which is how the first build shipped an invisible
  notice.

**Evidence:**
- Plan `.claudin/plans/dapper-swimming-penguin.md`.
- Two three-reviewer audits on 10-11 (correctness / elegance / UX+tests).
  - Round 1: the subdirectory freeze, a note inside a generated tree being deleted,
    `/init` vs `/map off`, and untested wiring.
  - Round 2: four more ways an uncommitted edit to a generated map was read as the
    healer's and deleted, plus `pending` counted as held, three phrasings, and the
    drain not waiting for a queued sync.
  - All of these were fixed the same day.
- Break-probe `scripts/migrations/probes/ruleMapEndOfTurn.json`: 49 red, plus a green
  control.
- End-to-end runs in a throwaway repo:
  - `-p`, from a repo subdirectory: created, then healed twice while `M`.
  - `-p`: an uncommitted `← a ← b` note was kept while the tree grew. Committed, it
    survived a regenerate whole. A committed note line inside the tree kept healing
    numbers-only for two rounds.
  - tmux: `● Navigation map updated …`; `Maps (1)` alone in the footer offered
    `↓ to navigate`; Enter opened the detail view, which stayed open past 8 s and
    evicted the row on close.
