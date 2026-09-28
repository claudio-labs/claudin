---
name: skill-arguments-reach-shell-pass
description: Skill arguments are substituted before the embedded-shell pass, so !`cmd` in args runs under the skill's allowed-tools grant (and ${CLAUDIN_*} in args expands) — kept for parity in the 2026-09 rewrite, not fixed
type: project
---

**Symptom:** none visible. When the model invokes a skill from disk through the Skill tool, the arguments it writes are treated like the skill author's own text:
- `${CLAUDIN_SKILL_DIR}` and `${CLAUDIN_SESSION_ID}` in the arguments expand.
- An inline `` !`cmd` `` or a ```` ```! ```` block in the arguments runs through the permission check with the skill's `allowed-tools` granted.

A skill with no placeholder is exposed too. Leftover arguments are appended after `ARGUMENTS: `, and the inline form needs only whitespace before the `!`.

**Where:**
- `getPromptForCommand` of a skill created by `createSkillCommand` in `src/skills/loadSkillsDir.ts`.
- The order is spelled out in `docs/tech/rewrite/skills/loadSkillsDir.md` §6 (arguments, then variables, then shell), and the finding is under Security requirements there.

**Repro:**
1. A skill whose frontmatter grants `allowed-tools: Bash(npm:*)`.
2. Invoke it with the arguments `` x !`npm run anything` ``.
3. The command runs without a prompt.

MCP skills are not affected: they never run embedded shell.

**Status (2026-09-28):**
- Found while characterizing the module for the clean-base rewrite.
- The rewrite keeps the order deliberately, because `$ARGUMENTS` inside an embedded command is a legitimate pattern and a plain reorder would break it.
- **Proposed fix:** substitute shell-quoted values inside command spans, and never scan argument text for shell syntax. Pin it with a test that arguments containing `` !`…` `` run nothing.
