---
name: safeguards-classifier-rejected
description: Claudin does not send Claude Code's `safeguards` / dangerous-tool-use classifier context — Claude Code itself does not on the real endpoint, and it would ship permission rules, paths, git state and identity
type: project
scope: providers/anthropic-betas
impact: rejected
---

**Decision:** Claudin does not send the `safeguards` body field
(`[{type:"dangerous_tool_use", classifier_context}]`) or the
`dangerous-tool-use-2026-09-03` beta. Decided 2026-09-22 in the beta-parity
round.

**Why:**
- **Claude Code does not send it by default on the real first-party
  endpoint.** There its server-side arbiter needs GrowthBook
  `smooth_chipmunk`, default false.
- **The one capture that showed it was an artifact.** It pointed the base URL
  at a localhost mock, which Claude Code classifies as third-party, and there
  the arbiter defaults on.
- **The payload is a privacy cost.** `classifier_context` carries:
  - the permission mode, and the allow / deny / ask rules with their roots
  - cwd, home and the trusted directories
  - git branch, status and remote visibility
  - the user's identity

  Claudin's no-phone-home stance does not take that on for a feature it
  already covers locally, with the auto-mode classifier in
  `src/permissions/yoloClassifier/`.

**What changes for a teammate:** do not "close the gap" by adding
`safeguards`. A capture that shows it is a mock artifact unless it was taken
with `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1`, which
`scripts/bench/tokens/wire-matrix.ts` sets by default.

**Rejected:** porting the classifier-context builder: about 16 keys, plus its
256 KB shedding and 1.04 MB withholding logic.

**Evidence:** the confound table in `docs/tech/anthropic-betas/wire-matrix.md`.
The Claude Code 2.1.280 bundle anchors are `function xdr(e,n,r,s)` (the
context builder) and `smooth_chipmunk` (the gate).
