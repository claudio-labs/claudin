# Plan — Port upstream built-in skills into Claudin

Branch: `feat/port-builtin-skills`

Goal: bring the high-value, provider-agnostic built-in skills from the upstream
Claude Code harness (v2.1.156) into Claudin as **bundled skills**, adapted for
the multi-provider runtime and Claudin's config conventions.

Scope (this branch): `simplify`, `verify`, `run`, `fewer-permission-prompts`,
and reconcile the existing `init`.

The verbatim upstream prompts are captured under `captured/` as source-of-truth
(the originals live in volatile `/tmp/.../bundled-skills/`):

- `captured/simplify.md`
- `captured/verify.md` + `captured/verify-examples/{cli,server}.md`
- `captured/run.md` + `captured/run-examples/{cli,server,tui,electron,playwright,library}.md`
- `captured/fewer-permission-prompts.md`
- `captured/init.md`

## Why these (selection rationale)

All five are pure agent-loop behavior — they drive the Agent/Bash/Read tools and
git, with **zero dependency on Anthropic cloud infrastructure**. Contrast with
`schedule`/`dream`/`hunter` (cloud cron + Kairos backend), which are out of scope.

## Mechanism (how bundled skills register — verified)

- Each skill is a file in `src/skills/bundled/<name>.ts` exporting a
  `register<Name>Skill()` that calls `registerBundledSkill(definition)`.
- Wired up in `src/skills/bundled/index.ts` → `initBundledSkills()`.
- `BundledSkillDefinition` (in `src/skills/bundledSkills.ts`) fields we'll use:
  - `name`, `description`, `aliases?`, `whenToUse?`, `argumentHint?`
  - `getPromptForCommand(args, ctx) => Promise<ContentBlockParam[]>` — returns
    the injected prompt.
  - `files?: Record<string, string>` — extra reference files extracted to disk
    on first invocation; the prompt is auto-prefixed with `Base directory for
    this skill: <dir>`. **No bundled skill uses this yet — `verify` and `run`
    will be the first**, carrying their `examples/*.md`.
  - `isEnabled?`, `userInvocable?`, `disableModelInvocation?`, `model?`,
    `context?: 'inline' | 'fork'`, `agent?`.
- Model after `src/skills/bundled/code-review.ts` (arg parsing + `buildPrompt`).

## Per-skill port table

| Skill | Portability | Required adaptations |
|-------|-------------|----------------------|
| **simplify** | High — spawns 4 Agent-tool reviewers in parallel; provider-agnostic | Keep as-is. Reference to `/code-review` is valid (exists as bundled skill). Consider scaling agent count for weaker/cheaper providers (optional). |
| **verify** | High — runtime observation only | Carry both `examples/*.md` via `files:`. Soften/remove the `/run-skill-generator` references (that skill is gated off in the open build — see Open Questions). Wording: "Claude Code" → neutral. |
| **run** | High — launch & drive the app | Carry all 6 `examples/*.md` via `files:`. Same `/run-skill-generator` handling as verify. |
| **fewer-permission-prompts** | Medium — needs path adaptation | **Transcript path** and **settings path** must match Claudin (see Open Questions — confirm `~/.claude/projects` vs `~/.claudin`). The `readOnlyValidation.ts` / `readOnlyCommandValidation.ts` source-of-truth references are **valid in Claudin** (same paths). Respect `CLAUDIN_CONFIG_DIR`. |
| **init** | Already exists | `src/commands/init.ts` already implements `name: 'init'`. **Do not duplicate.** Reconcile: compare its prompt against `captured/init.md`, fold in any missing guidance (esp. Cursor/Copilot rule extraction), and adapt "Claude Code" wording to Claudin. |

## Work items

1. **`src/skills/bundled/simplify.ts`** — new. Port `captured/simplify.md`.
   `disableModelInvocation` left default (user-invocable + model-invocable).
2. **`src/skills/bundled/verify.ts`** — new. Prompt from `captured/verify.md`;
   `files:` = the two `verify-examples/*.md`. Decide `context: 'fork'` (runs as a
   sub-agent) vs inline — upstream runs inline; keep inline unless we want isolation.
3. **`src/skills/bundled/run.ts`** — new. Prompt from `captured/run.md`;
   `files:` = the six `run-examples/*.md`.
4. **`src/skills/bundled/fewerPermissionPrompts.ts`** — new. Port
   `captured/fewer-permission-prompts.md` with Claudin-correct paths.
5. **`src/commands/init.ts`** — edit. Reconcile with `captured/init.md`.
6. **`src/skills/bundled/index.ts`** — register the 4 new skills (unconditional,
   like `code-review`; no feature flag — these need no Anthropic infra).
7. **Tests** — colocated `*.test.ts` per skill following `code-review.test.ts` /
   `loop.test.ts`: assert registration, prompt contains key anchors, and (for
   verify/run) that `files:` keys map to the example paths.

## Wording / branding pass

Every captured prompt says "Claude Code". For Claudin, replace user-facing
mentions with neutral phrasing ("the agent" / "Claudin") so skills don't
misrepresent the tool. Keep tool names (Agent, Bash, Grep) and git commands as-is.

## Open questions (resolve before implementing)

1. **`/run-skill-generator` references** in `verify`/`run`: the skill is gated
   off (`RUN_SKILL_GENERATOR` not in `featureFlags`). Options: (a) strip the
   references, (b) keep them as soft suggestions (harmless no-op), (c) port
   `runSkillGenerator` too in a follow-up. → *Recommend (a) for this branch.*
2. **Transcript + settings paths** for `fewer-permission-prompts`: confirm where
   Claudin writes session JSONL and project settings. Memory shows transcripts
   under `~/.claude/projects/...` while config is `~/.claudin/`. Must verify the
   real runtime path (and `CLAUDIN_CONFIG_DIR` override) before hardcoding.
3. **`init` duplication**: confirm the existing command is the only `init`
   registration and that we're improving it in place, not shipping a second one.
4. **Agent-count scaling**: should `simplify`/`verify` reduce parallel agents on
   cheaper/slower providers? Default: no — keep upstream behavior, revisit if a
   provider chokes.

## Validation (pre-PR)

```bash
bun run build
bun run smoke
bun test src/skills/bundled/        # focused on new skills
```

Then from `bun run dev` (→ `claudindev`): invoke `/simplify`, `/verify`,
`/run`, `/fewer-permission-prompts` against a small diff on a non-Anthropic
provider via `/provider doctor`, to confirm they work off the Anthropic path.
Note which provider was exercised in the PR description.
