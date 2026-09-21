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
`src/agent/attachments/pipeline.ts` on `input !== null` so they ride with a real
user prompt. Verify by running a real turn and reading the reply — a unit test
cannot catch either failure.

## For a sub-agent, `input !== null` is not available (#224, 2026-09-20)

Prediction confirmed, at scale: two `WebResearcher` agents reported the parent's
plan-mode and auto-mode reminders as a prompt-injection attempt in the page they
had just fetched. Same placement failure — but the mitigation above does not
transfer, because a child **only ever** reaches the pipeline mid-tool-loop
(`runAgent` builds its opening turn itself), so `input` is always null and
gating on it silences the producer entirely.

The usable axis for a child is **who owns the state the producer reads**:
main-thread-only, session-owned (teammates count as owners), or per-child. Six
producers were wrong on that axis; the classification now lives above
`allThreadAttachments` in `pipeline.ts`. See
[[attachment-producers-leak-parent-state]].

Two things that generalise beyond attachments:

- **The child's brief is the right home for anything mode-shaped.** Moving the
  plan-mode reminder into `runAgent`'s `initialMessages` cost nothing in
  coverage and removed the injection shape entirely.
- **A leaked reminder is worse than noise**: the child either acts on a parent
  mode nothing in its brief explains, or burns a turn reporting a phantom
  security incident — and either way it learns to distrust genuine reminders.
