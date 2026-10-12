---
name: /create bundled skill (commit 28eacc0c)
description: bundled /create teaches skill/rule/agent/hook/plugin authoring in .claudin; cite the COMMIT, not "#98" — that number is a different PR on GitHub
type: project
---

Commit `28eacc0c` (branch `feat/create-skill`, 2026-07-03) adds a bundled `/create` skill (`src/skills/bundled/create.ts`) that teaches the model to create/refine skills, rules, and custom agents in `.claudin/` (project) and `~/.claudin/` (global). Replaces the recommendation to install `skill-creator@claude-plugins-official` in `/init`.

**Its `(#98)` suffix is NOT a GitHub number.** That PR was opened on the retired
`git.viudescloud.uk` remote, whose numbering is independent — GitHub's own #98 is
an unrelated bash-filter fix opened 2026-08-15. Every PR reference in a commit
message from before the GitHub move has the same problem, so resolve one by
commit SHA rather than by asking `gh` for the number.

Facts learned while building it (verified against loaders):
- `model` in agent frontmatter depends on where the agent lives (re-checked 2026-10-12). `.claudin/agents/*.md`: **ignored** — the type declares `model?: string`, but `parseAgentFromMarkdown` in `loadAgentsDir.ts` never reads `frontmatter.model`, so `/create`'s "Not supported" line is right. Plugin agents: **read** (`loadPluginAgents.ts`). The Agent tool's per-call `model` works either way. The 2026-09-10 edit of this line claimed support from the declaration alone; re-read the parser, not the type, before trusting a frontmatter claim.
- Since 2026-10-12 `/create` also takes `hook` and `plugin`; the hook text is shared with `/update-config` through `src/skills/bundled/hookDocs.ts`, and `/skill-doctor` lints the skills `/create` writes.
- Skill `arguments` frontmatter must be a space-separated string or list of plain strings (`parseArgumentNames`) — a list of `{name, description}` objects is silently filtered and `$name` never substitutes. First E2E run produced exactly this bug; the skill prompt now warns about it.
- Rules support only `paths` frontmatter (`parseFrontmatterPaths`), not Cursor's `alwaysApply`/`globs`.
- Writes to `.claudin/**` are permission ask-gated even under headless `--permission-mode acceptEdits` and even with `--allowedTools "Write(.claudin/**)"` — headless E2E must stage elsewhere or the user approves interactively.
- Skills hot-reload via `skillChangeDetector` only if the skills dir existed at session start; agents/rules need a restart.
