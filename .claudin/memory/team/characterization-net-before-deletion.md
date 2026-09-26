---
name: characterization-net-before-deletion
description: Before deleting a feature here, pin its observable surface from the BUNDLE — and break each new assertion, because a characterization test is unusually easy to write tautologically
type: feedback
---

Deleting a subsystem needs the same net a file split needs
([[tier3-file-split-roadmap]] step 2), with one extra requirement and two traps
that a split does not hit. Used on the 2026-09-15 dead-code round
([[dead-code-cleanup-2026-09-15]]) and it paid for itself three times.

## The net must be captured from the bundle, not from source

`feature()` reads **false for every flag** outside the build, so a snapshot
taken by importing source is the flag-OFF shape and proves nothing about what
ships. Three surfaces and how to capture each honestly:

- **System prompt** — spawn `dist/cli.mjs --dump-system-prompt` (and
  `--subagent`, assembled on a different path) and normalize only what varies by
  machine. Pin the model with `--model`, or the dump snapshots whichever profile
  the developer had active.
- **Tool registry** — TWO halves. `getAllBaseTools()` at runtime gives the
  ungated tools; a regex over `src/tools/tools.ts` for
  `const X = feature('F') ? require(…) : null` recovers the ones behind flags
  that ship **true**, which the runtime list cannot see at all. Either half
  alone lets a real deletion through.
- **Slash commands** — static scan only: `commands.ts` reaches the Ink tree,
  which `bun test` cannot import.

Add a test asserting the snapshot contains a string that exists ONLY behind a
true flag (`# Delivering work` for WORK_CONTRACT). That is what catches a
regeneration done from source later.

## Trap 1 — a sibling branch absorbs the mutation

Two of the four scanner tests written that day passed with the line they claimed
to guard deleted:

- The apostrophe case wrote `// it's fine` — an apostrophe inside a **line
  comment** never reaches the string scanner, because the comment branch
  consumes it first. Rewritten with JSX text (`<Text>don't stop</Text>`), which
  is code.
- The character-class case put the token on the **next line**, where the string
  scanner's own newline bail absorbs the mis-parse. Rewritten with the token on
  the same line.

Both are the general shape from `.claudin/rules/agent-safety.md`: pick a fixture
that cannot reach the other branches.

## Trap 2 — proving the whole chain, not the assertion

For a snapshot taken through a subprocess, the assertion passing says nothing
about the capture. Flip a shipped flag (`ANTI_NARRATION: true` → `false`),
**rebuild**, and watch the comparison fail. That is ~2 minutes and it is the only
thing that proves bundle → dump → normalize → compare is wired.

## What the net is FOR

Not "green after deletion" — **a diff you can read name by name**. The command
registry named exactly the five bindings that left; the flag table named exactly
`desktop_upsell` and `jade_anvil_4`. Never accept a snapshot change
with a blanket `--update-snapshots`: read the removed names and confirm each was
intended.
