import { HOOK_EVENTS } from 'src/platform/entrypoints/agentSdkTypes.js'
import {
  getHookEventMetadata,
  type MatcherMetadata,
} from 'src/platform/lifecycleHooks/hooksConfigManager.js'

/**
 * The hook reference shared by `/update-config` (settings.json hooks, and the
 * `[hooks-only]` mode `/init` loads) and `/create hook`. One copy, so the two
 * skills cannot drift apart.
 */

// The events the table explains by hand. Every other event the schema accepts
// is appended from the /hooks menu's metadata, so a new event cannot go
// missing from the table the way 17 of 27 once did.
const HAND_WRITTEN_EVENT_ROWS = `| PermissionRequest | Tool name | Run before permission prompt |
| PreToolUse | Tool name | Run before tool, can block |
| PostToolUse | Tool name | Run after successful tool |
| PostToolUseFailure | Tool name | Run after tool fails |
| Notification | Notification type | Run on notifications |
| Stop | - | Run when Claude stops (including clear, resume, compact) |
| PreCompact | "manual"/"auto" | Before compaction |
| PostCompact | "manual"/"auto" | After compaction (receives summary) |
| UserPromptSubmit | - | When user submits |
| SessionStart | "startup"/"resume"/"clear"/"compact" | When session starts |`

function matcherCell(matcher: MatcherMetadata | undefined): string {
  if (!matcher) return '-'
  if (matcher.fieldToMatch === 'tool_name') return 'Tool name'
  if (matcher.values.length > 0) {
    return matcher.values.map(value => `"${value}"`).join('/')
  }
  return `\`${matcher.fieldToMatch}\``
}

function eventRows(): string {
  const metadata = getHookEventMetadata([])
  const generated = HOOK_EVENTS.filter(
    event => !HAND_WRITTEN_EVENT_ROWS.includes(`| ${event} |`),
  ).map(
    event =>
      `| ${event} | ${matcherCell(metadata[event].matcherMetadata)} | ${metadata[event].summary} |`,
  )
  return [HAND_WRITTEN_EVENT_ROWS, ...generated].join('\n')
}

export const HOOKS_DOCS = `## Hooks Configuration

Hooks run commands at specific points in Claudin's lifecycle.

### Hook Structure
\`\`\`json
{
  "hooks": {
    "EVENT_NAME": [
      {
        "matcher": "ToolName|OtherTool",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here",
            "timeout": 60,
            "statusMessage": "Running..."
          }
        ]
      }
    ]
  }
}
\`\`\`

### Hook Events

| Event | Matcher | Purpose |
|-------|---------|---------|
${eventRows()}

**Common tool matchers:** \`Bash\`, \`Write\`, \`Edit\`, \`Read\`, \`Glob\`, \`Grep\`

### Hook Types

**1. Command Hook** - Runs a shell command:
\`\`\`json
{ "type": "command", "command": "prettier --write $FILE", "timeout": 30 }
\`\`\`

**2. Prompt Hook** - Evaluates a condition with LLM:
\`\`\`json
{ "type": "prompt", "prompt": "Is this safe? $ARGUMENTS" }
\`\`\`
Only available for tool events: PreToolUse, PostToolUse, PermissionRequest.

**3. Agent Hook** - Runs an agent with tools:
\`\`\`json
{ "type": "agent", "prompt": "Verify tests pass: $ARGUMENTS" }
\`\`\`
Only available for tool events: PreToolUse, PostToolUse, PermissionRequest.

**4. HTTP Hook** - POSTs the hook input JSON to a URL:
\`\`\`json
{ "type": "http", "url": "https://hooks.example.com/claudin", "headers": { "Authorization": "Bearer $MY_TOKEN" }, "allowedEnvVars": ["MY_TOKEN"] }
\`\`\`
A header value interpolates only the env vars named in \`allowedEnvVars\`. The response body is read as the hook's JSON output (below); a non-2xx status is a non-blocking error. The \`allowedHttpHookUrls\` setting, when present, limits which URLs these hooks may reach (\`*\` wildcards; an empty array blocks them all).

### Hook Input (stdin JSON)
\`\`\`json
{
  "session_id": "abc123",
  "tool_name": "Write",
  "tool_input": { "file_path": "/path/to/file.txt", "content": "..." },
  "tool_response": { "success": true }  // PostToolUse only
}
\`\`\`

### Hook JSON Output

Hooks can return JSON to control behavior:

\`\`\`json
{
  "systemMessage": "Warning shown to user in UI",
  "continue": false,
  "stopReason": "Message shown when blocking",
  "suppressOutput": false,
  "decision": "block",
  "reason": "Explanation for decision",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Context injected back to model"
  }
}
\`\`\`

**Fields:**
- \`systemMessage\` - Display a message to the user (all hooks)
- \`continue\` - Set to \`false\` to block/stop (default: true)
- \`stopReason\` - Message shown when \`continue\` is false
- \`suppressOutput\` - Hide stdout from transcript (default: false)
- \`decision\` - "block" for PostToolUse/Stop/UserPromptSubmit hooks (deprecated for PreToolUse, use hookSpecificOutput.permissionDecision instead)
- \`reason\` - Explanation for decision
- \`hookSpecificOutput\` - Event-specific output (must include \`hookEventName\`):
  - \`additionalContext\` - Text injected into model context
  - \`permissionDecision\` - "allow", "deny", or "ask" (PreToolUse only)
  - \`permissionDecisionReason\` - Reason for the permission decision (PreToolUse only)
  - \`updatedInput\` - Modified tool input (PreToolUse only)

### Common Patterns

**Auto-format after writes:**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_response.filePath // .tool_input.file_path' | { read -r f; prettier --write \\"$f\\"; } 2>/dev/null || true"
      }]
    }]
  }
}
\`\`\`

**Log all bash commands:**
\`\`\`json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.command' >> ~/.claudin/bash-log.txt"
      }]
    }]
  }
}
\`\`\`

**Stop hook that displays message to user:**

Command must output JSON with \`systemMessage\` field:
\`\`\`bash
# Example command that outputs: {"systemMessage": "Session complete!"}
echo '{"systemMessage": "Session complete!"}'
\`\`\`

**Run tests after code changes:**
\`\`\`json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "jq -r '.tool_input.file_path // .tool_response.filePath' | grep -E '\\\\.(ts|js)$' && npm test || true"
      }]
    }]
  }
}
\`\`\`
`

export const HOOK_VERIFICATION_FLOW = `## Constructing a Hook (with verification)

Given an event, matcher, target file, and desired behavior, follow this flow. Each step catches a different failure class — a hook that silently does nothing is worse than no hook.

1. **Dedup check.** Read the target file. If a hook already exists on the same event+matcher, show the existing command and ask: keep it, replace it, or add alongside.

2. **Construct the command for THIS project — don't assume.** The hook receives JSON on stdin. Build a command that:
   - Extracts any needed payload safely — use \`jq -r\` into a quoted variable or \`{ read -r f; ... "$f"; }\`, NOT unquoted \`| xargs\` (splits on spaces)
   - Invokes the underlying tool the way this project runs it (npx/bunx/yarn/pnpm? Makefile target? globally-installed?)
   - Skips inputs the tool doesn't handle (formatters often have \`--ignore-unknown\`; if not, guard by extension)
   - Stays RAW for now — no \`|| true\`, no stderr suppression. You'll wrap it after the pipe-test passes.

3. **Pipe-test the raw command.** Synthesize the stdin payload the hook will receive and pipe it directly:
   - \`Pre|PostToolUse\` on \`Write|Edit\`: \`echo '{"tool_name":"Edit","tool_input":{"file_path":"<a real file from this repo>"}}' | <cmd>\`
   - \`Pre|PostToolUse\` on \`Bash\`: \`echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | <cmd>\`
   - \`Stop\`/\`UserPromptSubmit\`/\`SessionStart\`: most commands don't read stdin, so \`echo '{}' | <cmd>\` suffices

   Check exit code AND side effect (file actually formatted, test actually ran). If it fails you get a real error — fix (wrong package manager? tool not installed? jq path wrong?) and retest. Once it works, wrap with \`2>/dev/null || true\` (unless the user wants a blocking check).

4. **Write the JSON.** Merge into the target file (schema shape in the "Hook Structure" section above). If this creates \`.claudin/settings.local.json\` for the first time, add it to .gitignore — the Write tool doesn't auto-gitignore it.

5. **Validate syntax + schema in one shot:**

   \`jq -e '.hooks.<event>[] | select(.matcher == "<matcher>") | .hooks[] | select(.type == "command") | .command' <target-file>\`

   Exit 0 + prints your command = correct. Exit 4 = matcher doesn't match. Exit 5 = malformed JSON or wrong nesting. A broken settings.json silently disables ALL settings from that file — fix any pre-existing malformation too.

6. **Prove the hook fires** — only for \`Pre|PostToolUse\` on a matcher you can trigger in-turn (\`Write|Edit\` via Edit, \`Bash\` via Bash). \`Stop\`/\`UserPromptSubmit\`/\`SessionStart\` fire outside this turn — skip to step 7.

   For a **formatter** on \`PostToolUse\`/\`Write|Edit\`: introduce a detectable violation via Edit (two consecutive blank lines, bad indentation, missing semicolon — something this formatter corrects; NOT trailing whitespace, Edit strips that before writing), re-read, confirm the hook **fixed** it. For **anything else**: temporarily prefix the command in settings.json with \`echo "$(date) hook fired" >> /tmp/claude-hook-check.txt; \`, trigger the matching tool (Edit for \`Write|Edit\`, a harmless \`true\` for \`Bash\`), read the sentinel file.

   **Always clean up** — revert the violation, strip the sentinel prefix — whether the proof passed or failed.

   **If proof fails but pipe-test passed and \`jq -e\` passed**: the settings watcher isn't watching \`.claudin/\` — it only watches directories that had a settings file when this session started. The hook is written correctly. Tell the user to open \`/hooks\` once (reloads config) or restart — you can't do this yourself; \`/hooks\` is a user UI menu and opening it ends this turn.

7. **Handoff.** Tell the user the hook is live (or needs \`/hooks\`/restart per the watcher caveat). Point them at \`/hooks\` to review, edit, or disable it later. The UI only shows "Ran N hooks" if a hook errors or is slow — silent success is invisible by design.
`
