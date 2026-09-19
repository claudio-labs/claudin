---
name: bash-parser-unreachable-behind-tree-sitter-flag
description: RESOLVED 2026-09-18 in PR #213 — option 2 was taken and the hand-written TS bash parser plus the whole AST layer is deleted; kept for the two things that outlived it, the EVAL_LIKE_BUILTINS gap and the one live import that dragged 4.5k lines into the bundle
type: project
---

**This is closed. Do not go looking for `src/platform/bash/bashParser/` or
`bash/ast.ts` — neither exists.** Round 4 ([[dead-code-round-4-2026-09-18]], PR
#213) removed them, and the real size was more than double the estimate here:
the whole AST layer went, **16,957 lines in one commit**.

What this memory used to say, and what was wrong with it: it recorded the parser
as ~4.5k lines that "no code path can reach" and framed enable/delete/leave as a
product decision needing a human. The reachability half was right. The size was
an undercount, and one specific claim was **false** — `bashParser/tokens.ts` was
listed as *live* because `ast.ts` imported `SHELL_KEYWORDS` from it, but
`ast.ts` was itself dead, so the keywords' only consumers were `checkSemantics`
and the parser itself.

Three things worth keeping:

- **The shape.** A complete, tested implementation that no shipped path can
  reach stays green forever, because its tests import it directly. knip cannot
  see it either: a module imported by its own test counts as used. Same class as
  [[growthbook-source-dead-stub-is-real]], reached from the flag side rather
  than the stub side.
- **A single live-looking import can drag a whole subsystem into the bundle.**
  One `SHELL_KEYWORDS` import was the entire reason 16.9k lines shipped. When a
  removal is blocked by "but X imports it", check whether X is reachable before
  believing the block.
- **The security consequence that was NOT theoretical.** The parser was a bash
  security walker, and `EVAL_LIKE_BUILTINS` coverage lived only inside it. Round
  4 ported that to a live validator (`bashSecurity/validators/evalLike.ts`)
  **before** deleting the layer — which is why `source`, `.`, `exec` and
  `command` now prompt where a broad allow rule used to cover them. If that
  friction ever needs narrowing, it is a one-line change at `decide.ts:525`.

`TREE_SITTER_BASH` / `TREE_SITTER_BASH_SHADOW` are gone from the source; the
only surviving mentions are in docs and older memories.
