/**
 * `/update-config`: changes the settings files, and builds hooks that are
 * proven to fire.
 *
 * Two modes. `[hooks-only]` (what `/init` sends) returns the hooks reference
 * alone, with the rest of the line as the task. Anything else returns the
 * settings guidance, the same hooks reference, and the settings schema,
 * generated on every call so it cannot drift from the settings types. The
 * schema is about 97 KB of the prompt.
 */
import { toJSONSchema } from 'zod/v4'

import { SettingsSchema } from 'src/platform/settings/types.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { EXTERNAL_PERMISSION_MODES } from 'src/shared/types/permissions.js'
import { CLI_COMMAND } from 'src/skills/bundled/shared/cliCommand.js'
import { HOOKS_REFERENCE } from 'src/skills/bundled/shared/hooksReference.js'
import { describeSettingsFiles } from 'src/skills/bundled/shared/settingsFiles.js'
import {
  type UpdateConfigRequest,
  parseUpdateConfigRequest,
} from 'src/skills/bundled/shared/updateConfigRequest.js'
import { registerBundledSkill } from 'src/skills/bundledSkills.js'
import { ASK_USER_QUESTION_TOOL_NAME } from 'src/tools/AskUserQuestionTool/prompt.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'

// -- Prose

const DESCRIPTION =
  'Edit the harness settings files (settings.json, settings.local.json): permissions, env vars, hooks and any other key. ' +
  'A request to act automatically on an event ("from now on…", "whenever…", "before/after…") needs a hook: the harness runs hooks, ' +
  'while a preference saved to memory never triggers anything. Also for hooks that do not fire. ' +
  'Examples: "allow npm test without asking", "set NODE_ENV for every session", "format files after each edit", "log every bash command".'

const WRITE_OR_EDIT = `${FILE_WRITE_TOOL_NAME}|${FILE_EDIT_TOOL_NAME}`

const SETTINGS_GUIDANCE = `# Configure the harness

You are changing how this CLI behaves by editing its settings files. The harness reads them; nothing you remember or promise has the same effect.

## Setting or hook?

When the user wants something to happen on its own at some event ("from now on…", "whenever…", "before/after…"), that is a hook: the harness runs it every time, which a preference saved to memory never would. Map the request to its event:
- "before compacting" → \`PreCompact\`
- "after writing or editing files" → \`PostToolUse\` with matcher \`${WRITE_OR_EDIT}\`
- "when running shell commands" → \`PreToolUse\` with matcher \`${BASH_TOOL_NAME}\`

Anything else is a plain key in a settings file (common ones below, the full schema at the end). \`theme\`, \`editorMode\` and \`verbose\` are not settings keys: they live in the global config, which the user changes through \`/config\`, so send them there.

## The files

${describeSettingsFiles()}

Pick by audience: just this user, everywhere → user; the whole team → project; just this user, just here → local.

## Changing a file

1. **Clarify first.** When the file, the scope or the value is ambiguous (which file, add to a list or replace it, which of several values), ask with \`${ASK_USER_QUESTION_TOOL_NAME}\`.
2. **Read** the target file. If it does not exist, create it; a new \`.claudin/settings.local.json\` also goes into \`.gitignore\`.
3. **Merge.** Keep every existing key and entry. Append to arrays such as \`permissions.allow\` or a hook list instead of replacing them, and never rewrite the file with only the new entries.
4. **Write** valid JSON: no comments, no trailing commas.
5. **Tell the user** what changed, and in which file.

For example:
- "stop asking before \`npm test\`": read \`.claudin/settings.local.json\`, append \`"${BASH_TOOL_NAME}(npm test)"\` to \`permissions.allow\`, and write it back with the other rules intact.
- "set \`NODE_ENV=development\` for every session": merge it into the \`env\` object of \`~/.claudin/settings.json\`.
- "format Python files after each edit": a \`PostToolUse\` hook on \`${WRITE_OR_EDIT}\`, built and proven with "Constructing a Hook" below.

## Keys people ask for

Permissions. A rule is a tool name for any use (\`${WEB_FETCH_TOOL_NAME}\`), an exact command (\`${BASH_TOOL_NAME}(npm test)\`), or a prefix (\`${BASH_TOOL_NAME}(git diff:*)\`):

\`\`\`json
{
  "permissions": {
    "allow": ["${BASH_TOOL_NAME}(npm test)", "${BASH_TOOL_NAME}(git diff:*)", "${WEB_FETCH_TOOL_NAME}"],
    "deny": ["${BASH_TOOL_NAME}(curl:*)"],
    "ask": ["${BASH_TOOL_NAME}(git push:*)"],
    "defaultMode": "acceptEdits",
    "additionalDirectories": ["../shared-lib"]
  }
}
\`\`\`

\`defaultMode\` is one of ${EXTERNAL_PERMISSION_MODES.map(mode => `\`${mode}\``).join(', ')}. \`additionalDirectories\` opens folders outside the project.

The session:

\`\`\`json
{
  "env": { "NODE_ENV": "development" },
  "model": "<model id or alias>",
  "agent": "<agent that runs the main thread>",
  "alwaysThinkingEnabled": false
}
\`\`\`

Attribution added to commits and PR descriptions; an empty string hides it:

\`\`\`json
{ "attribution": { "commit": "", "pr": "" } }
\`\`\`

MCP servers declared in the project's \`.mcp.json\`:

\`\`\`json
{
  "enableAllProjectMcpServers": false,
  "enabledMcpjsonServers": ["github"],
  "disabledMcpjsonServers": ["filesystem"]
}
\`\`\`

Plugins, keyed \`name@source\`:

\`\`\`json
{ "enabledPlugins": { "formatter@team-tools": true } }
\`\`\`

Interface and housekeeping:

\`\`\`json
{
  "language": "portuguese",
  "cleanupPeriodDays": 30,
  "respectGitignore": true,
  "spinnerTipsEnabled": false,
  "spinnerVerbs": { "mode": "append", "verbs": ["Tinkering"] },
  "spinnerTipsOverride": { "excludeDefault": true, "tips": ["Run the linter before pushing"] },
  "syntaxHighlightingDisabled": false
}
\`\`\`

- \`language\`: the language replies are written in.
- \`cleanupPeriodDays\`: how many days transcripts are kept (default 30). \`0\` turns transcript persistence off: nothing is written, and existing transcripts are deleted at startup.
- \`respectGitignore\`: whether the file picker skips gitignored files (default true).
- \`spinnerVerbs\`: \`append\` adds to the built-in verbs, \`replace\` uses only these. \`spinnerTipsOverride.excludeDefault\` shows only the listed tips.

## Mistakes to avoid

- Replacing a file, or an array in it, instead of merging.
- Editing the wrong file for the scope the user meant.
- Leaving invalid JSON behind: a file that does not parse is ignored as a whole.
- Writing a file you have not read.

## When a hook does not run

1. Is it in the file you expect, and does that file parse (\`jq . <file>\`)?
2. Does the matcher match? Tool names are case-sensitive.
3. Does the event run that hook type (see "Hook types")?
4. Run the command by hand with a sample payload piped in (step 3 of "Constructing a Hook").
5. Restart with \`${CLI_COMMAND} --debug\` and read the debug log to see which hooks ran and what they returned.`

/** The live settings schema, input side: the shape a settings file is written in. */
function settingsSchemaSection(): string {
  const schema = toJSONSchema(SettingsSchema(), { io: 'input' })
  return `## Settings schema

Every settings file is validated against this JSON Schema:

\`\`\`json
${jsonStringify(schema, null, 2)}
\`\`\``
}

function renderPrompt(request: UpdateConfigRequest): string {
  if (request.mode === 'hooks-only') {
    return request.task === undefined
      ? HOOKS_REFERENCE
      : `${HOOKS_REFERENCE}\n\n## Task\n\n${request.task}`
  }
  const prompt = [SETTINGS_GUIDANCE, HOOKS_REFERENCE, settingsSchemaSection()].join('\n\n')
  return request.request === undefined
    ? prompt
    : `${prompt}\n\n## The user's request\n\n${request.request}`
}

// -- Registration

export function registerUpdateConfigSkill(): void {
  registerBundledSkill({
    name: 'update-config',
    description: DESCRIPTION,
    allowedTools: [FILE_READ_TOOL_NAME],
    argumentHint: '[what to configure]',
    userInvocable: true,
    disableModelInvocation: false,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: renderPrompt(parseUpdateConfigRequest(args)) }]
    },
  })
}
