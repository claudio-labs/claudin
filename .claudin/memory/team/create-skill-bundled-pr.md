---
name: /create bundled skill (PR #98)
description: feat/create-skill adds bundled /create teaching skills/rules/agents authoring in .claudin structure; /init now points at it
type: project
---

PR #98 (branch `feat/create-skill`, 2026-07-03) adds a bundled `/create` skill (`src/skills/bundled/create.ts`) that teaches the model to create/refine skills, rules, and custom agents in `.claudin/` (project) and `~/.claudin/` (global). Replaces the recommendation to install `skill-creator@claude-plugins-official` in `/init`.

Facts learned while building it (verified against loaders):
- Agent markdown frontmatter does NOT support `model` (`parseAgentFromMarkdown`, loadAgentsDir.ts) — session model is inherited.
- Skill `arguments` frontmatter must be a space-separated string or list of plain strings (`parseArgumentNames`) — a list of `{name, description}` objects is silently filtered and `$name` never substitutes. First E2E run produced exactly this bug; the skill prompt now warns about it.
- Rules support only `paths` frontmatter (`parseFrontmatterPaths`), not Cursor's `alwaysApply`/`globs`.
- Writes to `.claudin/**` are permission ask-gated even under headless `--permission-mode acceptEdits` and even with `--allowedTools "Write(.claudin/**)"` — headless E2E must stage elsewhere or the user approves interactively.
- Skills hot-reload via `skillChangeDetector` only if the skills dir existed at session start; agents/rules need a restart.
