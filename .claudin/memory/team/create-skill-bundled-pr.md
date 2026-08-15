---
name: /create bundled skill (commit 28eacc0c)
description: bundled /create teaches skills/rules/agents authoring in .claudin; cite the COMMIT, not "#98" — that number is a different PR on GitHub
type: project
---

Commit `28eacc0c` (branch `feat/create-skill`, 2026-07-03) adds a bundled `/create` skill (`src/skills/bundled/create.ts`) that teaches the model to create/refine skills, rules, and custom agents in `.claudin/` (project) and `~/.claudin/` (global). Replaces the recommendation to install `skill-creator@claude-plugins-official` in `/init`.

**Its `(#98)` suffix is NOT a GitHub number.** That PR was opened on the retired
`git.viudescloud.uk` remote, whose numbering is independent — GitHub's own #98 is
an unrelated bash-filter fix opened 2026-08-15. Every PR reference in a commit
message from before the GitHub move has the same problem, so resolve one by
commit SHA rather than by asking `gh` for the number.

Facts learned while building it (verified against loaders):
- Agent markdown frontmatter does NOT support `model` (`parseAgentFromMarkdown`, loadAgentsDir.ts) — session model is inherited.
- Skill `arguments` frontmatter must be a space-separated string or list of plain strings (`parseArgumentNames`) — a list of `{name, description}` objects is silently filtered and `$name` never substitutes. First E2E run produced exactly this bug; the skill prompt now warns about it.
- Rules support only `paths` frontmatter (`parseFrontmatterPaths`), not Cursor's `alwaysApply`/`globs`.
- Writes to `.claudin/**` are permission ask-gated even under headless `--permission-mode acceptEdits` and even with `--allowedTools "Write(.claudin/**)"` — headless E2E must stage elsewhere or the user approves interactively.
- Skills hot-reload via `skillChangeDetector` only if the skills dir existed at session start; agents/rules need a restart.
