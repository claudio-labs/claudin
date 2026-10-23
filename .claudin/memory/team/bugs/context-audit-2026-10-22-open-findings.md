---
name: context-audit-2026-10-22-open-findings
description: What the 2026-10-22 context-subsystem audit confirmed in the code and left open — dead snip/collapse code, instruction edits invisible until compaction, a stale cache-policy row
type: project
paths:
  - "src/agent/context.ts"
  - "src/memory/instructions/claudemd.ts"
  - "src/agent/compact/**"
---

A seven-item audit of the context subsystem on 2026-10-22. The scratchpad, output-style, count
and session-memory items were fixed in #315 ([[context-counts-share-one-sum]]). These were confirmed by reading the code, not reproduced,
and left open.

**1. Dead code nobody removed.**
- `HISTORY_SNIP` is not in the build's flag map, so it folds to false. The arm at
  `Message.tsx:250-281` is dead, and `snipCompact.ts` is a stub. Removing that arm shifts the
  React-Compiler `$[n]` slots (`feature-flags-source-guard.test.ts`).
- Context collapse (`marble-origami-*`): the writers in `sessions/persistence/record.ts` have no
  callers. The reader in `transcriptLoad.ts` still runs. The comment in `shared/types/logs.ts`
  that says nothing reads it is wrong.
- Reactive compact exists only in comments (`autoCompact.ts`, `injections.ts` and others).
- The `querySource === 'session_memory'` guards in `autoCompact.ts`, `query.ts` and
  `pipeline.ts` no longer guard anything.

**2. Instruction edits mid-session reach the model only after compaction.** `getUserContext`
(`agent/context.ts`) is memoized for the conversation and cleared only by compaction. No watcher
covers CLAUDE.md or AGENTS.md, in the REPL or headless. `/memory` calls
`clearMemoryFileCaches`, which clears only the inner `getMemoryFiles` cache, so an edit made
through `/memory` waits too. Before compaction, an edit surfaces only when the model Reads the
file or a file it already read changes (`edited_text_file`).

**3. Server-side `clear_tool_uses` is off on purpose.** `cli.tsx` defaults
`CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=true`. First-party still sends `clear_thinking` with
`keep:"all"`, which clears nothing. `docs/features/cache-policy.md:33` lists Bedrock and Vertex
under "retain" with server clear as the backstop, which cannot fire there:
`shouldIncludeFirstPartyOnlyBetas` is first-party or Foundry only.

**Why:** each was checked against the code with file:line evidence. Recording them saves the
next audit from re-deriving them, and says they were seen and left on purpose.

**How to apply:** fix one per branch. Snip and collapse removal need the bundle-first pin
([[characterization-net-before-deletion]]). Item 2 needs a red test that edits AGENTS.md
mid-session before any change to the memoization, since that cache is what keeps the prompt
prefix stable.
