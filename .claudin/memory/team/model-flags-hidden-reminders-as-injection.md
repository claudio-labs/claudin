---
name: Reminders that say "don't tell the user" get flagged as prompt injection
description: A system-reminder carrying instructions plus a gag order, or stapled onto a tool result mid-turn, is reported to the user as injected text — how to word and place injected reminders
type: feedback
---

Two independent ways an injected `<system-reminder>` gets treated as an attack
by the model receiving it, both observed live 2026-07-26 while building the task
reconcile nudge:

1. **Wording.** Text that gives instructions *and* says "never mention this
   reminder to the user" is the textbook injection signature. The model refused,
   told the user it looked like injected text, and suggested they investigate.
   That instinct is correct — don't fight it.
2. **Placement.** The attachment pipeline runs again mid-turn after every batch
   of tool results (`getAttachments` with `input === null`). An attachment added
   without gating on `input !== null` gets stapled onto an unrelated tool result
   — e.g. a file read — and reads as text smuggled in through tool output.

**Why:** the model can't distinguish harness-authored text from attacker text by
provenance alone; it judges by shape and placement.

**How to apply:** rely on the `<system-reminder>` wrapper to signal harness
origin and never add a secrecy instruction. Gate new attachment producers in
`src/utils/attachments/pipeline.ts` on `input !== null` so they ride with a real
user prompt. Verify by running a real turn and reading the reply — a unit test
cannot catch either failure.
