---
name: dogfood-without-repo-steering
description: Keep always-loaded steering (AGENTS.md, rules without paths:) minimal in the claudin repo — it makes Claudin behave better here than in other projects and hides the bugs users hit there; the user trimmed AGENTS.md and deleted agent-safety.md on 2026-09-24 for this
type: feedback
---

Don't grow AGENTS.md or a path-less rule to steer how Claudin behaves. Fix the
behavior in the product (system prompt, tool prompts, the tools themselves) and
check it where no repo steering exists.

**Why:** (user, 2026-09-24) AGENTS.md and path-less rules are in context on
every turn here, so Claudin works well in this repo on the strength of
instructions no other project has, and its bugs surface in other projects
instead. For this reason the user deleted `agent-safety.md` and trimmed
AGENTS.md, `search-strategy.md` and `testing.md` (commit c28cfca8). The same
day's A/B shows the gap: in a throwaway project the model ran `bun test | tail`
in Bash and never loaded the deferred RunTests, while this repo's `testing.md`
told it to use RunTests ([[dev-tools-deferred-advice-ab-2026-09-24]]).

**How to apply:** verify a behavior change from a throwaway cwd (the session
scratchpad, the `/tmp` bench fixtures), never only here. If the model needs a
nudge, put it in the product, not in this repo's context files. The other reason
AGENTS.md stays lean — other harnesses read it — is
[[agents-md-excludes-claudin-only-behavior]]. What still loads every turn in this
repo: the team and private MEMORY.md indexes, and `git-conventions.md`.
