import { registerBundledSkill } from 'src/skills/bundledSkills.js'

/**
 * `/create` — guide the model through creating (or refining) Claudin
 * customizations: skills, rules, and custom agents.
 *
 * Claudin-native replacement for the heavyweight upstream skill-creator
 * plugin: no install, no eval harness, and it teaches the frontmatter
 * contract this codebase actually parses (see loadSkillsDir.ts,
 * loadAgentsDir.ts, and claudemd.ts) — including the `.claudin/` project
 * and `~/.claudin/` global directory layout.
 */

type ArtifactType = 'skill' | 'rule' | 'agent'

const TYPE_ALIASES: Record<string, ArtifactType> = {
  skill: 'skill',
  skills: 'skill',
  command: 'skill',
  rule: 'rule',
  rules: 'rule',
  agent: 'agent',
  agents: 'agent',
  subagent: 'agent',
}

const WORKFLOW = `# Create Claudin Customizations

You are helping the user create or refine Claudin customizations. Follow this
workflow:

1. **Intent** — Decide whether the user wants to *create* something new or
   *refine* an existing artifact. If refining, Read the existing file first and
   validate its frontmatter against the contract below before changing it.
2. **Type** — Pick the right artifact for the job:
   - **Skill**: a reusable workflow or reference knowledge, invoked on demand
     (\`/<name>\` by the user, or auto-invoked by the model when relevant).
     Costs nothing in context until invoked.
   - **Rule**: always-on (or path-conditional) instructions loaded into
     context automatically. Costs context every session — keep rules short.
   - **Agent**: a subagent with its own system prompt, tool allowlist, and
     context window, dispatched via the Agent tool for delegated work.
   If the choice is ambiguous, ask the user with a one-line trade-off summary.
3. **Scope** — Ask (or infer from the request) whether it belongs to the
   project (\`.claudin/\` in the repo, shared via git) or to the user globally
   (\`~/.claudin/\`, available in every project). Default: project for
   repo-specific workflows/conventions, global for personal preferences.
4. **Interview** — Ask only what you cannot infer: what should it do, when
   should it trigger, which tools does it need, any inputs/arguments. Keep it
   to one short round; if the current conversation already contains the
   workflow being captured ("turn this into a skill"), extract the answers
   from it instead of asking.
5. **Draft & save** — Write the file at the correct path using the contract
   for its type. Look at existing artifacts in the target directory first and
   match their style; never overwrite an existing file without telling the
   user.
6. **Verify** — Confirm the artifact loads (see "Verifying" below) and show
   the user the file plus a one-line usage example.

The description fields (\`description\`, \`when_to_use\`) are what the runtime
uses to decide auto-invocation and delegation — spend the most effort there.
Be specific about the trigger conditions, not just the capability.`

const SKILL_SECTION = `## Skills

**Location** (layout is mandatory — a loose \`.md\` at the root of \`skills/\`
is ignored):
- Project: \`.claudin/skills/<name>/SKILL.md\`
- Global: \`~/.claudin/skills/<name>/SKILL.md\`
- Nested categories work: \`skills/<category>/<name>/SKILL.md\`
- Extra files (references, scripts) may live next to \`SKILL.md\` — discovery
  only picks up \`SKILL.md\`, so use sibling files for progressive disclosure
  and tell the skill body to Read them on demand.
- \`.claudin/commands/\` also loads but is **deprecated** — always create
  skills, and offer to migrate if you find the user still has commands there.

**Format** — YAML frontmatter + markdown body (the body becomes the prompt):

\`\`\`markdown
---
name: my-skill
description: What it does AND when to use it — this drives auto-invocation.
---

Instructions for the model...
\`\`\`

**Supported frontmatter** (anything else is ignored):
| Key | Meaning |
|---|---|
| \`name\` | Display name (defaults to the directory name) |
| \`description\` | What/when — shown in \`/skills\` and used for auto-invocation |
| \`when_to_use\` | Extra trigger guidance (note: snake_case, unlike the other keys) |
| \`allowed-tools\` | Tool allowlist while the skill runs, e.g. \`Read, Bash(git diff:*)\` |
| \`argument-hint\` | Hint shown in the composer, e.g. \`[pr-number]\` |
| \`arguments\` | Argument names as a space-separated string or YAML list of plain strings (e.g. \`arguments: name repo\`) — NOT a list of objects; each name becomes a \`$<name>\` placeholder |
| \`disable-model-invocation\` | \`true\` = only the user can invoke (use for side-effectful workflows like deploys) |
| \`user-invocable\` | \`false\` = model-only (hidden from \`/\` menu) |
| \`model\` | Override model for this skill, or \`inherit\` |
| \`effort\` | Effort level (\`low\`/\`medium\`/\`high\`/...) or an integer |
| \`context\` | \`fork\` = run in a forked subagent instead of inline |
| \`agent\` | Named agent to run the skill in (with \`context: fork\`) |
| \`paths\` | Globs — makes the skill conditional, loaded when matching files are touched |
| \`hooks\` | Skill-scoped hooks (same schema as settings.json hooks) |
| \`version\` | Informational version string |

**Body features**: \`$ARGUMENTS\` is replaced with the full invocation args,
\`$0\`/\`$ARGUMENTS[0]\` with individual args, and \`$<name>\` with the
positional arg matching \`arguments\`; \`\${CLAUDIN_SKILL_DIR}\` resolves to the
skill's directory (for referencing sibling scripts); \`!\` + backtick-wrapped
shell commands are executed before the prompt is sent (gated by
\`allowed-tools\`).

**Gotchas**:
- \`SKILL.md\` must be inside its own directory — \`skills/foo.md\` silently
  does not load.
- Keep the body focused; move long reference material to sibling files.`

const AGENT_SECTION = `## Agents (subagents)

**Location** — flat \`.md\` files, one agent per file:
- Project: \`.claudin/agents/<name>.md\`
- Global: \`~/.claudin/agents/<name>.md\`

**Format** — the markdown body is the agent's **system prompt**:

\`\`\`markdown
---
name: my-reviewer
description: Use this agent when the user asks for a security-focused review.
tools: Read, Grep, Glob
---

You are a security reviewer. Given a diff, you...
\`\`\`

**Supported frontmatter**:
| Key | Meaning |
|---|---|
| \`name\` | **Required** — the agent type used in Agent tool dispatch. Files without it are silently skipped |
| \`description\` | **Required** — "when to delegate to this agent"; drives automatic delegation |
| \`tools\` | Tool allowlist (comma list). Omit = all tools |
| \`disallowedTools\` | Tools to remove from the allowlist |
| \`model\` | ⚠️ **Not supported** in agent markdown — do not add it (common habit from other tools); the agent inherits the session model |
| \`color\` | Accent color in the TUI |
| \`background\` | \`true\` = always run as a background task |
| \`memory\` | \`user\` \\| \`project\` \\| \`local\` — persistent agent memory scope (auto-adds Read/Write/Edit) |
| \`isolation\` | \`worktree\` = run in an isolated git worktree |
| \`effort\` | Effort level or integer |
| \`permissionMode\` | Permission mode the agent runs under |
| \`maxTurns\` | Turn budget (positive integer) |
| \`skills\` | Skill names to preload into the agent |
| \`initialPrompt\` | Text prepended to the agent's first user turn |
| \`mcpServers\` | MCP servers by name reference or inline config |
| \`hooks\` | Agent-scoped hooks |

**Gotchas**:
- Missing \`name\` or \`description\` → the file is treated as co-located
  documentation and skipped without an error.
- Write \`description\` from the *dispatcher's* point of view ("Use this agent
  when...") — it is what the main model reads when deciding to delegate.
- For interactive creation the \`/agents\` wizard also works; creating the
  \`.md\` directly is equivalent and reviewable in git.`

const RULE_SECTION = `## Rules

**Location** — plain markdown, nested subdirectories allowed:
- Project: \`.claudin/rules/<topic>.md\`
- Global: \`~/.claudin/rules/<topic>.md\`

**Format** — markdown, auto-loaded into context. The only supported
frontmatter key is \`paths\`:

\`\`\`markdown
---
paths: src/api/**, src/services/api/**
---

# API conventions
...
\`\`\`

- No \`paths\` (or \`paths: "**"\`) → the rule is unconditional: loaded into
  every session. **It costs context every turn — keep it short and factual.**
- With \`paths\` globs → conditional: activated only when files matching the
  globs are touched. Project-rule globs are relative to the directory
  containing \`.claudin/\`.

**Gotchas**:
- \`alwaysApply\`, \`globs\`, \`description\` frontmatter (Cursor/other tools) are
  **not supported** — only \`paths\`. Migrate \`globs:\` → \`paths:\`.
- One topic per file; prefer several small conditional rules over one large
  unconditional one.
- If guidance is only needed on demand, make it a skill instead of a rule.`

const VERIFY_SECTION = `## Verifying

- **Skills**: if the skills directory already existed when the session
  started, a file watcher picks up the new skill within a few seconds — check
  with \`/skills\` or by invoking \`/<name>\`. If you just created the
  \`skills/\` directory itself, the watcher is not attached: tell the user to
  restart the session.
- **Agents and rules**: loaded at session start — tell the user to restart
  the session (agents also reload when the \`/agents\` wizard runs).
- Always show the user the final file path and how to invoke or trigger what
  you created.`

const SECTIONS: Record<ArtifactType, string> = {
  skill: SKILL_SECTION,
  rule: RULE_SECTION,
  agent: AGENT_SECTION,
}

function buildPrompt(args: string): string {
  const trimmed = args.trim()
  const [firstWord, ...rest] = trimmed.split(/\s+/)
  const type = firstWord ? TYPE_ALIASES[firstWord.toLowerCase()] : undefined

  // `/create rule <description>` → only that type's contract; otherwise the
  // full guide so the model can pick the right artifact in step 2.
  const sections = type
    ? [SECTIONS[type]]
    : [SKILL_SECTION, RULE_SECTION, AGENT_SECTION]

  const request = type ? rest.join(' ') : trimmed
  const requestSection = request
    ? `\n\n## User Request\n\n${type ? `Artifact type: ${type}. ` : ''}${request}`
    : type
      ? `\n\n## User Request\n\nArtifact type: ${type}. Ask the user what it should do.`
      : ''

  return [WORKFLOW, ...sections, VERIFY_SECTION].join('\n\n') + requestSection
}

export function registerCreateSkill(): void {
  registerBundledSkill({
    name: 'create',
    description:
      'Create or refine Claudin customizations — skills, rules, and custom agents — in the project (.claudin/) or global (~/.claudin/) structure.',
    whenToUse:
      'When the user wants to create, scaffold, improve, or fix a skill, rule, slash command, or custom agent/subagent for Claudin.',
    argumentHint: '[skill|rule|agent] [description]',
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildPrompt(args) }]
    },
  })
}
