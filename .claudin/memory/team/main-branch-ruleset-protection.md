---
name: main branch protected by GitHub ruleset (linear history)
description: The claudio-labs/claudin main branch protection ruleset — what it enforces, the admin bypass, and the empty-include gotcha that left it inert
type: project
---

`main` on github.com/claudio-labs/claudin is protected by repository ruleset "main" (id 18691005), enabled/fixed 2026-07-08. Enforced rules on the default branch: `deletion`, `non_fast_forward`, `required_linear_history`, and `pull_request` (1 approving review, **squash-only** merge). Bypass: `RepositoryRole` admin (actor_id 5), `bypass_mode: always`.

**Gotcha found 2026-07-08:** the ruleset was created "active" but with an EMPTY `conditions.ref_name.include` → it targeted NO branch, so `main` had zero protection despite the ruleset showing as active. Fixed by setting include to `["~DEFAULT_BRANCH"]`.

**Why:** user asked to enforce linear history on `main`; the pre-existing ruleset already had `required_linear_history` but wasn't wired to a branch.

**How to apply:** For non-admins, direct pushes to `main` now require a PR (squash, 1 review); admins bypass via the role rule. To confirm a GitHub ruleset is actually enforced, check `gh api repos/OWNER/REPO/rules/branches/BRANCH` returns a non-empty rule list — a ruleset being "active" is NOT enough if its `ref_name.include` is empty. If the user wants ONLY linear history (no PR/review requirement), drop the `pull_request` rule and keep `required_linear_history` + `non_fast_forward`.
