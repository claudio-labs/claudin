import { registerBundledSkill } from 'src/skills/bundledSkills.js'
import { HOOK_VERIFICATION_FLOW, HOOKS_DOCS } from 'src/skills/bundled/hookDocs.js'

/**
 * `/create` — guide the model through creating (or refining) Claudin
 * customizations: skills, rules, custom agents, hooks and plugins.
 *
 * Claudin-native replacement for the heavyweight upstream skill-creator
 * plugin: no install, no eval harness, and it teaches the frontmatter
 * contract this codebase actually parses (see loadSkillsDir.ts,
 * loadAgentsDir.ts, and claudemd.ts) — including the `.claudin/` project
 * and `~/.claudin/` global directory layout.
 *
 * Hooks reuse the reference `/update-config` teaches (hookDocs.ts) rather than
 * a second copy; plugins follow src/plugins/pluginLoader.ts and schemas.ts.
 * Both are long, so the untyped guide only points at them — the model loads
 * one by invoking `/create hook …` or `/create plugin …`.
 */

type ArtifactType = 'skill' | 'rule' | 'agent' | 'hook' | 'plugin'

const TYPE_ALIASES: Record<string, ArtifactType> = {
  skill: 'skill',
  skills: 'skill',
  command: 'skill',
  rule: 'rule',
  rules: 'rule',
  agent: 'agent',
  agents: 'agent',
  subagent: 'agent',
  hook: 'hook',
  hooks: 'hook',
  plugin: 'plugin',
  plugins: 'plugin',
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
   - **Hook**: a command (or prompt, agent or HTTP call) the *harness* runs at
     a lifecycle event — the only artifact that makes something happen every
     time ("after each edit", "before any Bash", "when the session stops").
   - **Plugin**: a directory bundling skills, agents, hooks and MCP/LSP servers
     so they install together into other projects. Only when the user wants to
     share or reuse across repos — inside one repo, loose \`.claudin/\` files
     do the same job.
   If the choice is ambiguous, ask the user with a one-line trade-off summary.
3. **Scope** — Ask (or infer from the request) whether it belongs to the
   project (\`.claudin/\` in the repo, shared via git) or to the user globally
   (\`~/.claudin/\`, available in every project). Default: project for
   repo-specific workflows/conventions, global for personal preferences.
   A hook picks a settings layer or a frontmatter instead, and a plugin is its
   own directory wherever the user keeps it — their sections say how.
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

const HOOK_SECTION = `## Hooks

A hook is run by the harness, not by the model, so it is the right artifact for
anything that must happen *every time* — memory or a rule cannot promise that.

**Where a hook lives** — the same \`hooks\` object (shape below) in any of:
| Place | Where | Active |
|---|---|---|
| User settings | \`~/.claudin/settings.json\` → \`"hooks"\` | every project |
| Project settings | \`.claudin/settings.json\` → \`"hooks"\` | this repo, shared via git |
| Local settings | \`.claudin/settings.local.json\` → \`"hooks"\` | this repo, this user only (gitignore it) |
| Skill frontmatter | \`hooks:\` in the skill's \`SKILL.md\` (YAML, same nesting) | from the skill's first invocation to the end of the session |
| Agent frontmatter | \`hooks:\` in \`.claudin/agents/<name>.md\` | while that agent runs; a \`Stop\` hook fires as \`SubagentStop\` |
| Plugin | \`hooks/hooks.json\` in the plugin, as \`{ "hooks": { … } }\` | wherever the plugin is enabled |

Default: project settings for a repo convention, local settings for a personal
one, frontmatter only when the hook makes no sense outside that skill or agent.
A settings.json hook is exactly what \`/update-config\` builds, with the same
flow below. A plugin's hook commands reach the plugin's own scripts through
\`\${CLAUDIN_PLUGIN_ROOT}\`.

${HOOKS_DOCS}

${HOOK_VERIFICATION_FLOW}`

const PLUGIN_SECTION = `## Plugins

A plugin is a directory that bundles skills, agents, hooks, legacy commands and
MCP/LSP servers so they install together. Create it wherever the user keeps it
(ask) — not inside \`.claudin/\`.

**Layout** — only the manifest is required; each component directory is optional
and found by name:

\`\`\`
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # manifest — the directory really is .claude-plugin
├── skills/<name>/SKILL.md   # same contract as a project skill
├── agents/<name>.md         # same contract as a project agent, differences below
├── commands/<name>.md       # legacy single-file commands
├── hooks/hooks.json         # { "hooks": { …same shape as settings.json… } }
├── output-styles/
├── .mcp.json                # { "mcpServers": { … } }
└── .lsp.json
\`\`\`

**Manifest** (\`.claude-plugin/plugin.json\`):
\`\`\`json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What the plugin adds, shown in /plugin",
  "author": { "name": "Your Name" }
}
\`\`\`
Only \`name\` is required — kebab-case, no spaces; it namespaces everything
inside. Optional: \`version\`, \`description\`, \`author\` (\`name\`, \`email\`,
\`url\`), \`homepage\`, \`repository\`, \`license\`, \`keywords\`,
\`dependencies\`. \`skills\`, \`agents\`, \`commands\`, \`hooks\`, \`mcpServers\` and
\`lspServers\` can list *additional* paths, each starting with \`./\`; the
default directories need no entry.

**What changes inside a plugin**:
- Everything is namespaced: \`skills/review/SKILL.md\` in \`my-plugin\` is
  \`/my-plugin:review\`, and \`agents/checker.md\` is dispatched as
  \`my-plugin:checker\` — so nothing in a plugin collides with a built-in.
- Plugin agents **do** accept \`model\` (project agents do not), and **ignore**
  \`permissionMode\`, \`hooks\` and \`mcpServers\` — ship hooks and MCP servers
  at the plugin level instead.
- Paths in hook commands, \`.mcp.json\`/\`.lsp.json\` and agent prompts go through
  \`\${CLAUDIN_PLUGIN_ROOT}\` — an installed plugin runs from a cache, not from
  where it was written. \`\${CLAUDIN_PLUGIN_DATA}\` is a per-plugin directory that
  survives updates, for state.
- Otherwise skills, agents and hooks follow their own contracts, which this
  section does not repeat: load one by invoking the Skill tool with skill
  \`create\` and args \`skill …\`, \`agent …\` or \`hook …\`.

**Distributing** — a marketplace is a directory or repo with
\`.claude-plugin/marketplace.json\`:
\`\`\`json
{ "name": "my-marketplace", "owner": { "name": "Your Name" }, "plugins": [{ "name": "my-plugin", "source": "./my-plugin", "description": "…" }] }
\`\`\`
Users add it with \`claudin plugin marketplace add <path-or-repo>\` and install
from \`/plugin\`.

**Verifying a plugin**:
1. Run \`claudin plugin validate <plugin-dir>\` — it checks the manifest,
   \`hooks/hooks.json\` and the frontmatter under \`skills/\`, \`agents/\` and
   \`commands/\`. Fix every error it reports.
2. A running session cannot pick up a new plugin. Tell the user to start one
   with \`claudin --plugin-dir <plugin-dir>\` (loads it for that session only,
   no install) and check \`/skills\` for the \`/<plugin>:<name>\` entries.`

// The untyped guide stays at skill/rule/agent size: these two sections would
// double it, and most requests without a type are skills.
const HOOK_AND_PLUGIN_POINTER = `## Hooks and plugins

Their contracts are long, so this guide leaves them out. If step 2 lands on a
hook or a plugin, invoke the Skill tool with skill \`create\` and args
\`hook <the request>\` or \`plugin <the request>\` — that loads a different
section of this skill, so it is not re-running it — and continue from there.`

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
  hook: HOOK_SECTION,
  plugin: PLUGIN_SECTION,
}

function buildPrompt(args: string): string {
  const trimmed = args.trim()
  const [firstWord, ...rest] = trimmed.split(/\s+/)
  const type = firstWord ? TYPE_ALIASES[firstWord.toLowerCase()] : undefined

  // `/create rule <description>` → only that type's contract; otherwise the
  // full guide so the model can pick the right artifact in step 2.
  const sections = type
    ? [SECTIONS[type]]
    : [SKILL_SECTION, RULE_SECTION, AGENT_SECTION, HOOK_AND_PLUGIN_POINTER]

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
      'Create or refine Claudin customizations — skills, rules, custom agents, hooks and plugins — in the project (.claudin/) or global (~/.claudin/) structure.',
    whenToUse:
      'When the user wants to create, scaffold, improve, or fix a skill, rule, slash command, custom agent/subagent, hook, or plugin for Claudin.',
    argumentHint: '[skill|rule|agent|hook|plugin] [description]',
    userInvocable: true,
    disableModelInvocation: false,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildPrompt(args) }]
    },
  })
}
