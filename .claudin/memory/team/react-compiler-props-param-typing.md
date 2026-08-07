---
name: React Compiler's t0 param is the root of ~1400 TS7006
description: the compiler strips the props annotation, so every callback touching props is a separate implicit-any error; annotate t0 and they all go, but grade each guess with the compiler
type: project
---

Roughly half this repo's `tsc` backlog was one cause. The React Compiler
rewrites `function C(props: P)` into `function C(t0)` and drops the annotation.
`t0` is then `any`, so `props.items.filter(x => …)` reports `x` — not `props` —
and one missing annotation shows up as five or fifty TS7006s.

**So count sites, not errors.** 403 sites produced 1710 diagnostics. Annotating
242 of them took the repo from 3161 to 2863.

**The type is almost always already in the file**, six lines above the function
the compiler rewrote: `XProps`, `XComponentProps`, or a bare `Props`.

**`_temp25`/`_temp22` are closures the compiler hoisted**, not components. They
match `function NAME(t0)` exactly, so any heuristic counting "components per
file" must exclude them or files with one component look like they have three.

**Do not trust the heuristic — grade it.** Apply every candidate, run tsc, keep
what reduced errors, revert what did not. Two passes scored 239 proposed / 216
kept and 42 proposed / 26 kept. The rule that sounded most obvious ("the
component named after its file owns the file's `Props`") was among the losers:
`ContextVisualization` is the sole component in `ContextVisualization.tsx` and
annotating it that way added nine errors.

A file going 0 → 2 may mean the annotation is RIGHT and exposed two real
errors. That is different work; revert it here and come back to it separately.

**What is left, measured 2026-08-07 at 2849 total errors:**

- **141 sites in 92 files, worth 639 TS7006.** No cheap rule left — each needs a
  human choosing among several declared types. Concentrated enough to attack
  top-down: twelve files carry 312 of those, led by `ContextVisualization.tsx`
  (58), `AskUserQuestionPermissionRequest.tsx` (35), `PermissionRuleList.tsx`
  (33) and `LogSelector.tsx` (33).
- **775 TS7006 sit in files with NO `function X(t0)` site at all** — a second,
  still-undiagnosed cause. This is the largest single block and the only one
  that might still hide another systematic fix like the `t0` one. Diagnose it
  before estimating any of the rest.
- **26 files where an annotation was applied and reverted.** These are the
  interesting ones: the type may be right and the code may hold a real error.
  `LogSelector.tsx` and `ContextVisualization.tsx` appear here AND in the 141,
  so some of that 639 is really this.

See [[typecheck-baseline-message-fingerprint-fragile]] for re-recording the
baseline afterwards, and [[typecheck-backlog-shape]] — whose "cannot be
hand-fixed" claim about this class this memory exists to correct.
