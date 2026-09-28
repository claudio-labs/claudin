---
name: instruction-loader-walk-to-root-and-links
description: Outside a repo and outside home, the .claudin/<subdir> walk reaches / (a session in /tmp/work loads /tmp/.claudin/agents), and command/agent files that are links are followed anywhere — both kept for parity, found 2026-09-28
type: project
---

**Symptom:** none visible.
- On a shared machine, anyone who can write `/tmp/.claudin/agents/` plants an agent (hooks, tools) or a command in another user's session started under `/tmp`.
- A cloned repository can ship `.claudin/commands/x.md` as a link to a file in the user's home. Its first line is then listed to the model as the command's description, and its text becomes the prompt when the command runs.

**Where:** `getProjectDirsUpToHome` and the loader in `src/memory/instructions/markdownConfigLoader.ts`. The walk stops at the repository root or below home, and has no stop outside both. The `CLAUDE.md` loader walks the same way.

**Status 2026-09-28:** kept for parity by the clean-base rewrite (findings 6 and 7 of `docs/tech/rewrite/memory/markdownConfigLoader.md`). An ownership check on the walk would break legitimate shared setups owned by an administrator, and linked command libraries (`~/dotfiles`) rely on links, so neither is pure hardening; each needs its own decision.
