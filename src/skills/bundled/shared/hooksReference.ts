/**
 * The hooks reference: how a hook is declared, what it reads and returns, and
 * the flow that proves a new one works. `/update-config` returns it alone for
 * `[hooks-only]`, which `/init` asks for before building a hook, and inside
 * its full prompt otherwise, so both carry exactly this text. `/init` sends
 * the model to the "Constructing a Hook" heading by name.
 *
 * Which events run which hook type follows src/platform/lifecycleHooks/: a
 * `prompt` hook needs the tool-use context, which only the events dispatched
 * inside the conversation loop pass, and an `agent` hook also needs the
 * conversation's messages, which only `Stop` passes.
 */
import type { HOOK_EVENTS } from 'src/platform/entrypoints/sdk/coreTypes.js'
import { ASK_USER_QUESTION_TOOL_NAME } from 'src/tools/AskUserQuestionTool/prompt.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'

type HookEventName = (typeof HOOK_EVENTS)[number]

type EventRow = {
  readonly event: HookEventName
  /** What the event's matcher is compared with. */
  readonly matcher: string
  readonly runs: string
}

const EVENTS: readonly EventRow[] = [
  { event: 'PreToolUse', matcher: 'tool name', runs: 'before a tool call; can block it' },
  { event: 'PostToolUse', matcher: 'tool name', runs: 'after a tool call succeeds' },
  { event: 'PostToolUseFailure', matcher: 'tool name', runs: 'after a tool call fails' },
  { event: 'PermissionRequest', matcher: 'tool name', runs: 'before a permission prompt is shown; can answer it' },
  { event: 'Notification', matcher: 'notification type', runs: 'when the user is sent a notification' },
  { event: 'Stop', matcher: 'none', runs: 'when the assistant finishes its turn' },
  { event: 'PreCompact', matcher: '`manual` or `auto`', runs: 'before the conversation is compacted' },
  { event: 'PostCompact', matcher: '`manual` or `auto`', runs: 'after compaction, with the summary in `compact_summary`' },
  { event: 'UserPromptSubmit', matcher: 'none', runs: 'when the user submits a prompt, before the model sees it' },
  { event: 'SessionStart', matcher: '`startup`, `resume`, `clear` or `compact`', runs: 'when a session starts or resumes' },
]

const PROMPT_HOOK_EVENTS: readonly HookEventName[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'UserPromptSubmit',
  'Stop',
]
const AGENT_HOOK_EVENTS: readonly HookEventName[] = ['Stop']

const MATCHABLE_TOOLS = [
  BASH_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
]

const WRITE_OR_EDIT = `${FILE_WRITE_TOOL_NAME}|${FILE_EDIT_TOOL_NAME}`

/** `a`, `b` and `c` */
function codeList(items: readonly string[]): string {
  const quoted = items.map(item => `\`${item}\``)
  return quoted.length < 2
    ? quoted.join('')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
}

const DECLARING = `## Hooks

A hook is an action the harness runs whenever an event fires, whatever the model is doing. Hooks live under \`"hooks"\` in a settings file, keyed by event, then grouped by matcher:

\`\`\`json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "${WRITE_OR_EDIT}",
        "hooks": [
          {
            "type": "command",
            "command": "npm run lint -- --fix",
            "timeout": 60,
            "statusMessage": "Fixing lint"
          }
        ]
      }
    ]
  }
}
\`\`\`

- \`matcher\` selects what the event is about (see the table). Omitted or \`*\`, it matches everything; \`${WRITE_OR_EDIT}\` matches either name exactly; anything else is read as a regular expression.
- Each hook needs \`type\` and \`command\`. \`timeout\` (in seconds) and \`statusMessage\` (shown while the hook runs) are optional.
- In the file, the command is a JSON string: escape \`"\` and \`\\\`.`

const EVENTS_SECTION = `### Events

| Event | Matcher compared with | Runs |
|---|---|---|
${EVENTS.map(row => `| \`${row.event}\` | ${row.matcher} | ${row.runs} |`).join('\n')}

Tool names to match: ${codeList(MATCHABLE_TOOLS)}. An MCP tool is \`mcp__<server>__<tool>\`.`

const TYPES_SECTION = `### Hook types

- \`"type": "command"\` runs a shell command. It works on every event.
- \`"type": "prompt"\` has a model judge a condition: \`{ "type": "prompt", "prompt": "Is every task the user asked for done? $ARGUMENTS" }\`, where \`$ARGUMENTS\` becomes the event's input JSON. When the condition is not met, the event is blocked and the reason goes back to the assistant. It runs on ${codeList(PROMPT_HOOK_EVENTS)}.
- \`"type": "agent"\` runs an agent that can use tools to check something: \`{ "type": "agent", "prompt": "Confirm the unit tests were run and pass. $ARGUMENTS" }\`. It needs the conversation, so it runs on ${codeList(AGENT_HOOK_EVENTS)} only.`

const INPUT_SECTION = `### What a hook reads

One JSON object on stdin, with \`session_id\`, \`transcript_path\`, \`cwd\` and \`hook_event_name\`. Tool events add \`tool_name\` and \`tool_input\` (\`.tool_input.file_path\` for \`${FILE_WRITE_TOOL_NAME}\` and \`${FILE_EDIT_TOOL_NAME}\`, \`.tool_input.command\` for \`${BASH_TOOL_NAME}\`), and \`PostToolUse\` alone adds \`tool_response\`.`

const OUTPUT_SECTION = `### What a hook returns

Exit code 0 is success. Exit code 2 blocks the event where it can be blocked and sends stderr back to the assistant. Any other code is a non-blocking error shown to the user.

For finer control, print one JSON object on stdout. Every field is optional:
- \`systemMessage\`: a message shown to the user.
- \`"continue": false\` stops the assistant; \`stopReason\` is what the user sees.
- \`suppressOutput\`: keeps the hook's stdout out of the transcript.
- \`"decision": "block"\` with a \`reason\` blocks \`PostToolUse\` (the reason reaches the assistant), \`Stop\` (the assistant keeps working) and \`UserPromptSubmit\` (the prompt is dropped). It is deprecated for \`PreToolUse\`: use \`permissionDecision\` there.
- \`hookSpecificOutput\`: \`{ "hookEventName": "<event>", "additionalContext": "…" }\` adds context for the assistant. For \`PreToolUse\` it can also carry \`permissionDecision\` (\`allow\`, \`deny\` or \`ask\`), \`permissionDecisionReason\` and \`updatedInput\`, which replaces the tool's input. \`PermissionRequest\` answers with \`"decision": { "behavior": "allow" }\` or \`{ "behavior": "deny", "message": "…" }\` there instead.`

const PATTERNS_SECTION = `### Common patterns

- Format each file after it is written (\`PostToolUse\`, matcher \`${WRITE_OR_EDIT}\`):
  \`jq -r '.tool_input.file_path' | { read -r f; npx prettier --write "$f"; } 2>/dev/null || true\`
- Log every shell command (\`PreToolUse\`, matcher \`${BASH_TOOL_NAME}\`):
  \`jq -r '.tool_input.command' >> ~/.claudin/bash-commands.log\`
- Show a message when the turn ends (\`Stop\`):
  \`echo '{"systemMessage": "Turn finished: review the diff before committing"}'\`
- Run the tests after edits and send failures back (\`PostToolUse\`, matcher \`${WRITE_OR_EDIT}\`):
  \`npm test > /tmp/hook-tests.log 2>&1 || { tail -n 30 /tmp/hook-tests.log >&2; exit 2; }\``

const CONSTRUCTING_SECTION = `### Constructing a Hook

Go through every step. A hook that is written but never exercised tends to fail without a trace.

1. **Look for a duplicate.** Read the target file. If the same event and matcher already have a hook, show it and ask with \`${ASK_USER_QUESTION_TOOL_NAME}\` whether to keep it, replace it, or add the new one alongside.
2. **Build the command for this project.**
   - Take fields out of the payload safely: \`jq -r\` into a quoted variable (\`f="$(jq -r '.tool_input.file_path')"\`, then \`"$f"\`), or a \`{ read -r f; …; }\` block. Never hand paths to an unquoted \`xargs\`, which splits them on spaces.
   - Invoke the tool the way the project does: its package scripts, its lockfile's runner, its configured binary.
   - Skip inputs the tool cannot handle, for example \`case "$f" in *.py) ruff format "$f" ;; esac\`.
   - Keep the command raw, with no error suppression, until step 3 passes.
3. **Pipe-test it.** Synthesize the payload the hook will receive, pipe it in, and check both the exit code and the side effect:
   \`echo '{"tool_name": "${FILE_EDIT_TOOL_NAME}", "tool_input": {"file_path": "<a real file>"}}' | <command>; echo "exit $?"\`
   For a \`${BASH_TOOL_NAME}\` hook send \`{"tool_name": "${BASH_TOOL_NAME}", "tool_input": {"command": "ls"}}\`; for an event that does not read stdin, \`echo '{}'\`. Only once it works, wrap it as \`{ <command>; } 2>/dev/null || true\`, unless the user wants a blocking check.
4. **Write it**, merged into the target file. If that creates \`.claudin/settings.local.json\`, add the file to \`.gitignore\`: the file tools do not.
5. **Validate syntax and shape in one query**, with your event, matcher and file:
   \`jq -e '.hooks.PostToolUse[] | select(.matcher == "${WRITE_OR_EDIT}") | .hooks[] | select(.type == "command") | .command' .claudin/settings.json\`
   Exit 0 with the command printed means it is right; 4 means the matcher does not match; 5 means malformed JSON or wrong nesting. For an event without a matcher, drop the \`select(.matcher …)\` step. A settings file that does not parse silently disables every setting in it.
6. **Prove it fires.** This applies to \`PreToolUse\` and \`PostToolUse\` on a matcher you can trigger in this turn.
   - A formatter: introduce a violation it corrects (wrong quotes or indentation; not trailing whitespace, which the edit tool strips), make that edit, and check the file came out corrected.
   - Anything else: temporarily prefix the command with \`echo fired >> "\${TMPDIR:-/tmp}/hook-fired.txt";\`, trigger the tool, and read that file.
   - Either way, undo the violation or the prefix afterwards.
7. **Explain a failed proof.** If the proof fails although steps 3 and 5 passed, the hook is right but not loaded: the settings watcher only watches directories that held a settings file when the session started. The user has to open \`/hooks\` once, or restart; you cannot do either for them.
8. **Hand off.** Say whether the hook is live or needs \`/hooks\` or a restart, and point to \`/hooks\` for reviewing or disabling it. A hook that succeeds is normally silent in the UI, so silence is not a failure.`

export const HOOKS_REFERENCE = [
  DECLARING,
  EVENTS_SECTION,
  TYPES_SECTION,
  INPUT_SECTION,
  OUTPUT_SECTION,
  PATTERNS_SECTION,
  CONSTRUCTING_SECTION,
].join('\n\n')
