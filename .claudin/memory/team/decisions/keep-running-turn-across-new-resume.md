---
name: keep-running-turn-across-new-resume
description: 2026-09-29 (#268) — /new and /resume keep a running turn alive by handing it to the Ctrl+B background task; a real multi-session runtime was rejected; the kept turn's output lands in the task's own transcript, not the session's
type: project
scope: sessions, /new, /resume
impact: functional
paths:
  - src/commands/new/newSession.ts
  - src/commands/resume/resume.tsx
---

**Decision:** leaving a session mid-turn no longer has to stop it. `/new` is `immediate` — it
asks at once instead of queueing behind the turn — and offers keep it running in the background /
stop it and keep the session open / stop it and end the session. The `/resume` picker asks
Enter = stop and switch, B = keep it running. "Keep running" reuses the Ctrl+B path
(`handleBackgroundQuery` → `startBackgroundSession`) through `backgroundTurn()`, which is awaited
before the conversation is cleared or switched.

**Why:** the user wanted two sessions to run side by side in one instance without one
interrupting the other. The REPL holds ONE conversation — one message list, one query loop, one
abort controller, the process-wide `getSessionId` — and the Ctrl+B background task was the only
seam that already survives `clearConversation`.

**What changes for a teammate:**
- A kept turn writes to the task's isolated transcript (`LocalMainSessionTask.ts`), NOT to the
  session it came from: a later `/resume` of that session does not contain what the turn
  produced; the result arrives as a task notification. "The resumed session is missing the
  answer" is this, by design — writing it into the session file would corrupt the post-clear
  conversation (the comment in `LocalMainSessionTask.ts` explains).
- A kept turn that needs a permission prompt shows it in whichever session is in front (its
  `canUseTool` is the foreground one). Queued prompts are not carried over.
- The hand-over must stay awaited: `startBackgroundSession` reads the conversation when it
  starts, and a clear that runs first hands it an empty one. Ctrl+B itself still ignores it.

**Rejected:** a real multi-session runtime (each session with its own messages, query loop and
AppState slice) — it touches REPL, AppState, the prompt cache and the process-wide session id;
judged out of scope and not recommended.

**Evidence:** plan `.claudin/plans/functional-floating-parnas.md`; commit 0dc5f216 (#268).
