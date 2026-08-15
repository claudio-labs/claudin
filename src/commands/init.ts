import type { Command } from 'src/commands/commands.js'
import { maybeMarkProjectOnboardingComplete } from 'src/platform/projectOnboardingState.js'

const INIT_PROMPT = `Set up a minimal AGENTS.md (and optionally CLAUDE.local.md, subagents, skills, hooks, and guardrails) for this repo. The root project instruction file is loaded into every Claude Code session, so it must be concise — only include what Claude would get wrong without it.

## Phase 1: Ask what to set up

Use AskUserQuestion to find out what the user wants:

- "Which instruction files should /init set up?"
  Options: "Project AGENTS.md" | "Personal CLAUDE.local.md" | "Both project + personal"
  Description for project: "Team-shared instructions checked into source control — architecture, coding standards, common workflows."
  Description for personal: "Your private preferences for this project (gitignored, not shared) — your role, sandbox URLs, preferred test data, workflow quirks."

- "Also set up skills and hooks?"
  Options: "Skills + hooks" | "Skills only" | "Hooks only" | "Neither, just the instruction file(s)"
  Description for skills: "On-demand capabilities you or Claude invoke with \`/skill-name\` — good for repeatable workflows and reference knowledge."
  Description for hooks: "Deterministic shell commands that run on tool events (e.g., format after every edit). Claude can't skip them."

- "Set up custom subagents for this project?"
  Options: "Yes — propose from codebase" | "No"
  Description for Yes: "Subagents are specialized AI workers Claude can dispatch (e.g., \`frontend-reviewer\`, \`backend-tester\`, \`db-migration-expert\`). Particularly useful in monorepos with distinct workspaces."

- "Configure guardrails (things Claudin should refuse or always ask before doing)?"
  Options: "Yes — propose from common categories" | "No, use defaults"
  Description for Yes: "Add \`permissions.ask\` / \`permissions.deny\` rules to block or confirm risky commands (e.g., git commits, force-push, docker, rm -rf, terraform apply). You can also opt into a real git pre-commit hook."

## Phase 2: Explore the codebase

Launch a subagent to survey the codebase, and ask it to read key files to understand the project: manifest files (package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, etc.), README, Makefile/build configs, CI config, existing CLAUDE.md, .claudin/rules/, AGENTS.md, .cursor/rules or .cursorrules, .github/copilot-instructions.md, .windsurfrules, .clinerules, .mcp.json.

Detect:
- Build, test, and lint commands (especially non-standard ones)
- Languages, frameworks, and package manager
- Project structure (monorepo with workspaces, multi-module, or single project). Check **all** of: \`package.json\` \`workspaces\` field (npm/yarn), \`pnpm-workspace.yaml\`, \`turbo.json\`, \`nx.json\`, \`Cargo.toml\` \`[workspace]\` (Rust), \`go.work\` (Go), \`pom.xml\` with \`<modules>\` (Maven multi-module), \`settings.gradle\` / \`settings.gradle.kts\` with \`include\` (Gradle multi-project). For each workspace found, capture path + dominant language/role.
- Code style rules that differ from language defaults
- Non-obvious gotchas, required env vars, or workflow quirks
- Existing \`.claudin/agents/\`, \`.claudin/skills/\`, and \`.claudin/rules/\` directories
- Formatter configuration (prettier, biome, ruff, black, gofmt, rustfmt, or a unified format script like \`npm run format\` / \`make fmt\`)
- Sensitive areas (only relevant if guardrails were opted in): \`Dockerfile\` / \`docker-compose.yml\` / \`compose.yml\`, \`.github/workflows/\`, \`terraform/\` or \`*.tf\`, \`migrations/\`, npm/make scripts whose name contains \`prod\`, \`deploy\`, \`release\`, \`publish\`
- Git worktree usage: run \`git worktree list\` to check if this repo has multiple worktrees (only relevant if the user wants a personal CLAUDE.local.md)

Note what you could NOT figure out from code alone — these become interview questions.

## Phase 3: Fill in the gaps

Use AskUserQuestion to gather what you still need to write good instruction files and skills. Ask only things the code can't answer.

If the user chose project AGENTS.md or both: ask about codebase practices — non-obvious commands, gotchas, branch/PR conventions, required env setup, testing quirks. Skip things already in README or obvious from manifest files. Do not mark any options as "recommended" — this is about how their team works, not best practices.

If the user chose personal CLAUDE.local.md or both: ask about them, not the codebase. Do not mark any options as "recommended" — this is about their personal preferences, not best practices. Examples of questions:
  - What's their role on the team? (e.g., "backend engineer", "data scientist", "new hire onboarding")
  - How familiar are they with this codebase and its languages/frameworks? (so Claude can calibrate explanation depth)
  - Do they have personal sandbox URLs, test accounts, API key paths, or local setup details Claude should know?
  - Only if Phase 2 found multiple git worktrees: ask whether their worktrees are nested inside the main repo (e.g., \`.claudin/worktrees/<name>/\`) or siblings/external (e.g., \`../myrepo-feature/\`). If nested, the upward file walk finds the main repo's CLAUDE.local.md automatically — no special handling needed. If sibling/external, the personal content should live in a home-directory file (e.g., \`~/.claudin/<project-name>-instructions.md\`) and each worktree gets a one-line CLAUDE.local.md stub that imports it: \`@~/.claudin/<project-name>-instructions.md\`. Never put this import in the project AGENTS.md — that would check a personal reference into the team-shared file.
  - Any communication preferences? (e.g., "be terse", "always explain tradeoffs", "don't summarize at the end")

**Synthesize a proposal from Phase 2 findings** — e.g., format-on-edit if a formatter exists, a project verification workflow if tests exist, an AGENTS.md note for anything from the gap-fill answers that's a guideline rather than a workflow. For each, pick the artifact type that fits, **constrained by the Phase 1 skills+hooks choice**:

  - **Hook** (stricter) — deterministic shell command on a tool event; Claude can't skip it. Fits mechanical, fast, per-edit steps: formatting, linting, running a quick test on the changed file.
  - **Skill** (on-demand) — you or Claude invoke \`/skill-name\` when you want it. Fits workflows that don't belong on every edit: deep verification, session reports, deploys.
  - **AGENTS.md note** (looser) — influences Claude's behavior but not enforced. Fits communication/thinking preferences: "plan before coding", "be terse", "explain tradeoffs".

  **Respect Phase 1's skills+hooks choice as a hard filter**: if the user picked "Skills only", downgrade any hook you'd suggest to a skill or an AGENTS.md note. If "Hooks only", downgrade skills to hooks (where mechanically possible) or notes. If "Neither", everything becomes an AGENTS.md note. Never propose an artifact type the user didn't opt into.

**Show the proposal via AskUserQuestion's \`preview\` field, not as a separate text message** — the dialog overlays your output, so preceding text is hidden. The \`preview\` field renders markdown in a side-panel (like plan mode); the \`question\` field is plain-text-only. Structure it as:

  - \`question\`: short and plain, e.g. "Does this proposal look right?"
  - Each option gets a \`preview\` with the full proposal as markdown. The "Looks good — proceed" option's preview shows everything; per-item-drop options' previews show what remains after that drop.
  - **Keep previews compact — the preview box truncates with no scrolling.** One line per item, no blank lines between items, no header. Example preview content:

    • **Format-on-edit hook** (automatic) — \`ruff format <file>\` via PostToolUse
    • **Verification workflow** (on-demand) — \`make lint && make typecheck && make test\`
    • **AGENTS.md note** (guideline) — "run lint/typecheck/test before marking done"

  - Option labels stay short ("Looks good", "Drop the hook", "Drop the skill") — the tool auto-adds an "Other" free-text option, so don't add your own catch-all.

**Build the preference queue** from the accepted proposal. Each entry: {type: hook|skill|note, description, target file, any Phase-2-sourced details like the actual test/format command}. Phases 4-7 consume this queue.

## Phase 4: Write AGENTS.md (if user chose project or both)

Write a minimal AGENTS.md at the project root. Every line must pass this test: "Would removing this cause Claude to make mistakes?" If no, cut it.

If the repo already has a checked-in root \`CLAUDE.md\` and does NOT already have a root \`AGENTS.md\`, do NOT silently create a second root instruction file. In that case, update the existing root \`CLAUDE.md\` in place by default. Only create or migrate to root \`AGENTS.md\` if the user explicitly asks to migrate.

**Consume \`note\` entries from the Phase 3 preference queue whose target is AGENTS.md** (team-level notes) — add each as a concise line in the most relevant section. These are the behaviors the user wants Claude to follow but didn't need guaranteed (e.g., "propose a plan before implementing", "explain the tradeoffs when refactoring"). Leave personal-targeted notes for Phase 5.

Include:
- Build/test/lint commands Claude can't guess (non-standard scripts, flags, or sequences)
- Code style rules that DIFFER from language defaults (e.g., "prefer type over interface")
- Testing instructions and quirks (e.g., "run single test with: pytest -k 'test_name'")
- Repo etiquette (branch naming, PR conventions, commit style)
- Required env vars or setup steps
- Non-obvious gotchas or architectural decisions
- Important parts from existing AI coding tool configs if they exist (AGENTS.md, .cursor/rules, .cursorrules, .github/copilot-instructions.md, .windsurfrules, .clinerules)

Exclude:
- File-by-file structure or component lists (Claude can discover these by reading the codebase)
- Standard language conventions Claude already knows
- Generic advice ("write clean code", "handle errors")
- Detailed API docs or long references — use \`@path/to/import\` syntax instead (e.g., \`@docs/api-reference.md\`) to inline content on demand without bloating AGENTS.md
- Information that changes frequently — reference the source with \`@path/to/import\` so Claude always reads the current version
- Long tutorials or walkthroughs (move to a separate file and reference with \`@path/to/import\`, or put in a skill)
- Commands obvious from manifest files (e.g., standard "npm test", "cargo test", "pytest")

Be specific: "Use 2-space indentation in TypeScript" is better than "Format code properly."

Do not repeat yourself and do not make up sections like "Common Development Tasks" or "Tips for Development" — only include information expressly found in files you read.

Prefix the file with:

\`\`\`
# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
\`\`\`

If AGENTS.md already exists: read it, propose specific changes as diffs, and explain why each change improves it. Do not silently overwrite.

For projects with multiple concerns, suggest organizing instructions into \`.claudin/rules/\` as separate focused files (e.g., \`code-style.md\`, \`testing.md\`, \`security.md\`). These are loaded automatically alongside AGENTS.md and can be scoped to specific file paths using \`paths\` frontmatter.

For projects with distinct subdirectories (monorepos, multi-module projects, etc.): mention that subdirectory AGENTS.md files can be added for module-specific instructions (they're loaded automatically when Claude works in those directories). Offer to create them if the user wants.

## Phase 5: Write CLAUDE.local.md (if user chose personal or both)

Write a minimal CLAUDE.local.md at the project root. This file is automatically loaded alongside AGENTS.md. After creating it, add \`CLAUDE.local.md\` to the project's .gitignore so it stays private.

**Consume \`note\` entries from the Phase 3 preference queue whose target is CLAUDE.local.md** (personal-level notes) — add each as a concise line. If the user chose personal-only in Phase 1, this is the sole consumer of note entries.

Include:
- The user's role and familiarity with the codebase (so Claude can calibrate explanations)
- Personal sandbox URLs, test accounts, or local setup details
- Personal workflow or communication preferences

Keep it short — only include what would make Claude's responses noticeably better for this user.

If Phase 2 found multiple git worktrees and the user confirmed they use sibling/external worktrees (not nested inside the main repo): the upward file walk won't find a single CLAUDE.local.md from all worktrees. Write the actual personal content to \`~/.claudin/<project-name>-instructions.md\` and make CLAUDE.local.md a one-line stub that imports it: \`@~/.claudin/<project-name>-instructions.md\`. The user can copy this one-line stub to each sibling worktree. Never put this import in the project AGENTS.md. If worktrees are nested inside the main repo (e.g., \`.claudin/worktrees/\`), no special handling is needed — the main repo's CLAUDE.local.md is found automatically.

If CLAUDE.local.md already exists: read it, propose specific additions, and do not silently overwrite.

## Phase 5.5: Suggest and create subagents (if user opted in for subagents in Phase 1)

Skip this phase entirely if the user said "No" to subagents.

Subagents are stored as markdown files with YAML frontmatter. Project-scoped → \`.claudin/agents/<slug>.md\`; personal-scoped → \`~/.claudin/agents/<slug>.md\`. The loader requires only \`name\` and \`description\`; everything else is optional.

1. **Inventory** existing agents (if any) under \`.claudin/agents/\` and \`~/.claudin/agents/\`. Read their \`name\` from frontmatter. **Never propose a slug that already exists** — propose a different name or skip the area.

2. **Propose agents** based on Phase 2 findings:

   - **Monorepo** (workspaces detected): propose **one subagent per workspace with a clearly distinct role**. Examples:
     - \`apps/web\` (Next.js/React) → \`frontend-reviewer\`
     - \`services/api\` (Express/Fastify) → \`backend-tester\`
     - \`packages/sdk\` (library) → \`sdk-author\`
     - \`infra/\` or \`terraform/\` → \`infra-reviewer\`
     - \`migrations/\` → \`db-migration-expert\`
     - \`docs/\` → \`docs-writer\`
     Do NOT propose an agent for a workspace whose role is unclear or just a thin wrapper — quality > quantity.

   - **Single project**: propose 1–3 thematic agents only when Phase 2 surfaced something specific. Examples:
     - Has \`src/services/api/\` and provider shims → \`provider-shim-reviewer\`
     - Has \`src/tools/\` with multiple tools → \`tool-author\`
     - Has \`CHANGELOG.md\` plus git tags → \`release-cutter\`
     If nothing concrete jumps out, propose **zero agents** and tell the user — don't pad.

3. **Confirm via a single \`AskUserQuestion\` with \`multiSelect: true\`.** Each option = one proposed agent. Use the \`preview\` field to show, for each focused option, the full file contents that would be written (slug, scope/paths, description, tools, justification, body). Add a "None — skip" option (auto-added "Other" handles custom slug requests).

4. **Scope choice** follows the Phase 1 instruction-file choice:
   - "Project AGENTS.md" or "Both" → write under \`.claudin/agents/\`.
   - "Personal CLAUDE.local.md" only → write under \`~/.claudin/agents/\`.

5. **Write each accepted agent** as a minimal file:

   \`\`\`markdown
   ---
   name: <slug>
   description: <one-liner: when to dispatch this subagent>
   tools: [Read, Grep, Glob, Bash]    # tailor per agent — reviewers rarely need Bash; authors usually need Edit/Write; infra agents may want only Read/Grep
   ---

   # Scope

   <Paths this subagent owns, e.g. \`apps/web/**\`, \`src/services/api/**\`. Be specific.>

   # When to dispatch

   <Concrete triggers: code review in this area, writing new modules here, debugging a class of bug, etc.>

   # Conventions and gotchas

   <2–4 bullet points pulled from Phase 2 findings: testing rules, code-style quirks, common pitfalls. Cite the project lint/test commands when relevant.>
   \`\`\`

   Keep agents minimal — only \`name\` + \`description\` are required by the loader. Other fields the loader supports (use only when they add value): \`disallowedTools\`, \`model\` (\`opus|sonnet|haiku\`), \`effort\` (\`high\`), \`permissionMode\` (\`acceptEdits|plan|bypassPermissions|default\`), \`skills: [<slug>...]\`.

6. After writing, tell the user: "Run \`/agents\` to refine these (edit prompts, change models, adjust tool allow/deny, etc.)."

## Phase 6: Suggest and create skills (if user chose "Skills + hooks" or "Skills only")

Skills add capabilities Claude can use on demand without bloating every session.

**First, consume \`skill\` entries from the Phase 3 preference queue.** Each queued skill preference becomes a SKILL.md tailored to what the user described. For each:
- Name it from the preference (e.g., "verify-deep", "session-report", "deploy-sandbox")
- Write the body using the user's own words from the interview plus whatever Phase 2 found (test commands, report format, deploy target). If the preference maps to an existing project workflow, write a project skill that captures the user's specific constraints on top.
- Ask a quick follow-up if the preference is underspecified (e.g., "which test command should verify-deep run?")

**Then suggest additional skills** beyond the queue when you find:
- Reference knowledge for specific tasks (conventions, patterns, style guides for a subsystem)
- Repeatable workflows the user would want to trigger directly (deploy, fix an issue, release process, verify changes)

For each suggested skill, provide: name, one-line purpose, and why it fits this repo.

If \`.claudin/skills/\` already exists with skills, review them first. Do not overwrite existing skills — only propose new ones that complement what is already there.

When authoring each SKILL.md, invoke the bundled \`create\` skill (Skill tool, \`skill: "create"\`) for the full Claudin frontmatter contract (\`when_to_use\`, \`allowed-tools\`, \`context: fork\`, conditional \`paths\`, etc.) instead of relying on the minimal template below.

Create each skill at \`.claudin/skills/<skill-name>/SKILL.md\`:

\`\`\`yaml
---
name: <skill-name>
description: <what the skill does and when to use it>
---

<Instructions for Claude>
\`\`\`

Both the user (\`/<skill-name>\`) and Claude can invoke skills by default. For workflows with side effects (e.g., \`/deploy\`, \`/fix-issue 123\`), add \`disable-model-invocation: true\` so only the user can trigger it, and use \`$ARGUMENTS\` to accept input.

## Phase 7: Suggest additional optimizations

Tell the user you're going to suggest a few additional optimizations now that AGENTS.md and skills (if chosen) are in place.

Check the environment and ask about each gap you find (use AskUserQuestion):

- **GitHub CLI**: Run \`which gh\` (or \`where gh\` on Windows). If it's missing AND the project uses GitHub (check \`git remote -v\` for github.com), ask the user if they want to install it. Explain that the GitHub CLI lets Claude help with commits, pull requests, issues, and code review directly.

- **Linting**: If Phase 2 found no lint config (no .eslintrc, ruff.toml, .golangci.yml, etc. for the project's language), ask the user if they want Claude to set up linting for this codebase. Explain that linting catches issues early and gives Claude fast feedback on its own edits.

- **Guardrails** (only if the user opted in to guardrails in Phase 1):

  Guardrails are persisted as \`permissions.ask\` or \`permissions.deny\` rules in a settings file. Matcher syntax: \`Bash(<command>:*)\` for a prefix wildcard (the colon separates the command from the wildcard), \`Bash(<command>)\` for an exact match. Example: \`Bash(git commit:*)\` matches any \`git commit ...\` invocation.

  **Important**: \`/init\` configures the repo at its current path only. **Never run \`npm install\`, \`pip install\`, \`brew install\`, or any other package-manager install command** as part of guardrail setup. If a category would require new dependencies (e.g., full husky/pre-commit-framework install), print the commands as a "Next steps" suggestion and move on.

  1. **Present the category menu** via a single \`AskUserQuestion\` with \`multiSelect: true\`. Use \`preview\` to show, for each focused option, the exact rules that will be written. Default categories:

     - **No git commits** → \`permissions.ask\` for \`Bash(git commit:*)\`
     - **No git push** → \`permissions.ask\` for \`Bash(git push:*)\`
     - **No destructive git** → \`permissions.deny\` for \`Bash(git push --force:*)\`, \`Bash(git push -f:*)\`, \`Bash(git reset --hard:*)\`, \`Bash(git branch -D:*)\`, \`Bash(git clean -f:*)\`
     - **No rebase** → \`permissions.ask\` for \`Bash(git rebase:*)\`, \`Bash(git pull --rebase:*)\`
     - **No docker / compose up** → \`permissions.ask\` for \`Bash(docker run:*)\`, \`Bash(docker compose up:*)\`, \`Bash(docker-compose up:*)\`, \`Bash(docker start:*)\`
     - **No prod / deploy scripts** → only offer if Phase 2 detected such script names. \`permissions.deny\` for \`Bash(npm run <script>:*)\` (and equivalents for yarn/pnpm/bun/make) where \`<script>\` matched \`prod\`/\`deploy\`/\`release\`/\`publish\`.
     - **No dangerous fs / sudo** → \`permissions.deny\` for \`Bash(rm -rf:*)\`, \`Bash(sudo:*)\`, \`Bash(chmod -R:*)\`
     - **No terraform apply** → \`permissions.ask\` for \`Bash(terraform apply:*)\`, \`Bash(terraform destroy:*)\` (only offer if \`.tf\` files were detected)
     - **Custom rule** → use the auto-added "Other" free-text option; user types a matcher.

     **Overlap between categories is fine.** Picking both "No git push" (\`ask\` on \`Bash(git push:*)\`) and "No destructive git" (\`deny\` on \`Bash(git push --force:*)\`) coexists as two separate rules — the more specific deny wins for force-push, the ask still gates regular push. Do not warn the user about this.

  2. **Per-category scope.** For each accepted category, ask where to persist (project-shared vs personal) with a sensible default:
     - **Default project** (\`projectSettings\` → \`.claudin/settings.json\`): terraform/docker/prod scripts, dangerous fs — these are repo rules that protect the whole team.
     - **Default personal** (\`userSettings\` → \`~/.claudin/settings.json\`): commits, push, rebase — these are individual workflow preferences.
     Offer the default first; let the user flip.

     If you would write to \`.claudin/settings.json\` (project scope): check whether \`.claudin/\` or \`.claudin/settings.json\` is matched by \`.gitignore\`. If ignored, do NOT prompt to commit the file. If not ignored, mention to the user that this file is intended to be committed (team-shared rules).

  3. **Persist the rules.** Use \`addPermissionRulesToSettings({ ruleValues, ruleBehavior }, source)\` from \`src/permissions/permissionsLoader.ts\` (it deduplicates and preserves existing entries). \`ruleBehavior\` is \`'ask'\` or \`'deny'\`; \`source\` is \`'projectSettings'\` or \`'userSettings'\`. Construct each \`ruleValue\` as \`{ toolName: 'Bash', ruleContent: '<command>:*' }\` (or omit \`ruleContent\` for the whole tool).

     **Managed-settings fallback**: if \`addPermissionRulesToSettings\` returns \`false\` (e.g., \`shouldAllowManagedPermissionRulesOnly()\` blocked the write, or the source is read-only), tell the user that settings are managed and print the proposed rules as a copy-paste block they can hand to their admin. Do not fail the whole \`/init\`.

  4. **Commit gate (real git pre-commit hook).** Separately from the permission rules above, if Phase 2 found lint/typecheck/test commands AND no existing pre-commit hook (\`.git/hooks/pre-commit\`, \`.pre-commit-config.yaml\`, \`.husky/pre-commit\`, \`lefthook.yml\`), ask via \`AskUserQuestion\`:

     - **"Add raw \`.git/hooks/pre-commit\` script"** (default) — write a bash script under \`.git/hooks/pre-commit\` that runs the detected commands (lint + typecheck + fast test). Make it executable (\`chmod +x\` via Bash tool). Warn the user the file is NOT tracked by git and must be re-added per clone unless they switch to a tracked solution. Never add \`--no-verify\`.
     - **"Add \`.husky/pre-commit\`"** — only show this option if \`.husky/\` already exists. Write the hook file only; do NOT run \`npm install\` or \`npx husky init\`.
     - **"Skip — just mention \`/commit\` in AGENTS.md"** — lightweight fallback.
     - **"Print install instructions for husky / pre-commit / lefthook and continue"** — \`/init\` outputs the commands the user can run later; nothing else is written.

     Reminder (already in this prompt): \`PreToolUse\` hooks cannot filter \`Bash\` by command content, so a real commit gate must be a git hook, not a Claudin hook. The permission rules from step 1 above DO work for matching \`git commit\` invocations from Claudin's side because they're glob-based at the matcher level.

- **Proposal-sourced hooks** (if user chose "Skills + hooks" or "Hooks only"): Consume \`hook\` entries from the Phase 3 preference queue. If Phase 2 found a formatter and the queue has no formatting hook, offer format-on-edit as a fallback. If the user chose "Neither" or "Skills only" in Phase 1, skip this bullet entirely.

  For each hook preference (from the queue or the formatter fallback):

  1. Target file: default based on the Phase 1 instruction-file choice — project → \`.claudin/settings.json\` (team-shared, committed); personal → \`.claudin/settings.local.json\`. Only ask if the user chose "both" in Phase 1 or the preference is ambiguous. Ask once for all hooks, not per-hook.

  2. Pick the event and matcher from the preference:
     - "after every edit" → \`PostToolUse\` with matcher \`Write|Edit\`
     - "when Claude finishes" / "before I review" → \`Stop\` event (fires at the end of every turn — including read-only ones)
     - "before running bash" → \`PreToolUse\` with matcher \`Bash\`
     - "before committing" (literal git-commit gate) → **not a hooks.json hook.** Matchers can't filter Bash by command content, so there's no way to target only \`git commit\`. Route this to a git pre-commit hook (\`.git/hooks/pre-commit\`, husky, pre-commit framework) instead — offer to write one. If the user actually means "before I review and commit Claude's output", that's \`Stop\` — probe to disambiguate.
     Probe if the preference is ambiguous.

  3. **Load the hook reference** (once per \`/init\` run, before the first hook): invoke the Skill tool with \`skill: 'update-config'\` and args starting with \`[hooks-only]\` followed by a one-line summary of what you're building — e.g., \`[hooks-only] Constructing a PostToolUse/Write|Edit format hook for .claudin/settings.json using ruff\`. This loads the hooks schema and verification flow into context. Subsequent hooks reuse it — don't re-invoke.

  4. Follow the skill's **"Constructing a Hook"** flow: dedup check → construct for THIS project → pipe-test raw → wrap → write JSON → \`jq -e\` validate → live-proof (for \`Pre|PostToolUse\` on triggerable matchers) → cleanup → handoff. Target file and event/matcher come from steps 1–2 above.

Act on each "yes" before moving on.

## Phase 8: Final AGENTS.md pass and summary

### 8a: Reflect created artifacts back into AGENTS.md (only if AGENTS.md was written in Phase 4)

Re-open the AGENTS.md you wrote in Phase 4 and add/update these sections **idempotently** (if the section already exists, update its contents in place rather than appending a duplicate). Keep each entry to a single line.

- \`## Subagents\` — one bullet per agent created in Phase 5.5: \`- \`<slug>\` — <description>\`. Skip the whole section if no agents were created.
- \`## Skills\` — one bullet per skill created in Phase 6: \`- \`/<skill-name>\` — <description>\`. Skip the whole section if no skills were created.
- \`## Guardrails\` — one bullet per guardrail category accepted in Phase 7, e.g. \`- Commits require confirmation (\`permissions.ask\` on \`Bash(git commit:*)\`).\`, \`- Force-push and hard reset are blocked.\`. Skip if no guardrails were configured.
- If a real git pre-commit hook was created in Phase 7, add a single line under your existing workflow/testing section (or create \`## Workflow\` if absent) like: \`Pre-commit hook at \`.git/hooks/pre-commit\` runs <commands>.\`

Finish the file with a one-line pointer: \`To refine: \`/create\` (skills, rules, agents), \`/agents\` (subagents), \`/skills\` (skills), \`/permissions\` (viewer for permission rules — edit \`settings.json\` directly to change them).\`

**Important — interaction with Phase 6**: Phase 6 (skill creation) may have already written sections into AGENTS.md. Always read AGENTS.md before editing in this pass; never overwrite an existing section, only update its contents.

### 8b: Update .gitignore

If you created any of these in the project tree, ensure \`.gitignore\` covers them (append if missing, never duplicate lines):
- \`CLAUDE.local.md\` (always — it's personal)
- Any personal-scoped agents written under the home directory do NOT need a project gitignore entry. Skip.

Note: \`.claudin/settings.json\` (project-scoped guardrails written in Phase 7) is intended to be **committed** so the rules apply to every contributor — do NOT add it to \`.gitignore\` unless the user explicitly asked for personal-only rules.

### 8c: Recap

Recap what was set up — which files were written and the key points included in each. Remind the user these files are a starting point: they should review and tweak them, and can run \`/init\` again anytime to re-scan.

Then tell the user that you'll be introducing a few more suggestions for optimizing their codebase and Claude Code setup based on what you found. Present these as a single, well-formatted to-do list where every item is relevant to this repo. Put the most impactful items first.

When building the list, work through these checks and include only what applies:
- If frontend code was detected (React, Vue, Svelte, etc.): \`/plugin install frontend-design@claude-plugins-official\` gives Claude design principles and component patterns so it produces polished UI; \`/plugin install playwright@claude-plugins-official\` lets Claude launch a real browser, screenshot what it built, and fix visual bugs itself.
- If you found gaps in the Phase 7 optimizations menu (missing GitHub CLI, missing linting, etc.) and the user said no: list them here with a one-line reason why each helps. (This is separate from the guardrails sub-section of Phase 7.)
- If tests are missing or sparse: suggest setting up a test framework so Claude can verify its own changes.
- To create or refine skills, rules, and custom agents later, Claudin ships the \`/create\` skill — no install needed; it knows the \`.claudin/\` project and \`~/.claudin/\` global structure. For eval-driven skill optimization there is also the official skill-creator plugin: \`/plugin install skill-creator@claude-plugins-official\`. (Always include this one.)
- Browse official plugins with \`/plugin\` — these bundle skills, agents, hooks, and MCP servers that you may find helpful. You can also create your own custom plugins to share them with others. (Always include this one.)`

const command = {
  type: 'prompt',
  name: 'init',
  description:
    'Initialize project instruction file(s), optional subagents, skills, hooks, and guardrails based on codebase analysis',
  contentLength: 0, // Dynamic content
  progressMessage: 'analyzing your codebase',
  source: 'builtin',
  async getPromptForCommand() {
    maybeMarkProjectOnboardingComplete()

    return [
      {
        type: 'text',
        text: INIT_PROMPT,
      },
    ]
  },
} satisfies Command

export default command
