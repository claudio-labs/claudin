import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { isGrepBodiesEnabled } from 'src/tools/GrepTool/grepBodies.js'

export const GREP_TOOL_NAME = 'Grep'

// CLAUDIN_GREP_BODIES (grepBodies.ts), off by default. Read once, so each
// description stays one static string per process.
const BODIES_RULE = isGrepBodiesEnabled()
  ? 'To read what you search for, add `bodies: true` to a "symbols" search: each matched function or class comes back whole in the same call, and counts as read.'
  : ''

export function getDescription(): string {
  return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows per-file match counts sorted largest-first (totals in the footer are search-wide, not just the shown page), "symbols" maps each match to the enclosing function/class signature
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
  - Broad "content" searches (matches spread across many files) come back as the "symbols" map instead of the matching lines; pass \`head_limit\` explicitly, or narrow with \`path\`/\`glob\`, to get the lines.
  - Case: a lowercase pattern matches any case, a pattern containing an uppercase letter is matched case-sensitively (ripgrep smart-case). Pass \`-i: true\` to force insensitive, \`-i: false\` to force sensitive.
  - Files excluded by \`.gitignore\` are not searched. When a search finds nothing they are searched automatically and reported separately, so "no matches" means no matches anywhere; pass \`no_ignore: true\` to include them from the start.
  - Binary files and text that is not UTF-8 are skipped. Pass \`binary: true\` to search binary files as text, or \`encoding\` (e.g. "utf-16le", "shift_jis", "windows-1252") for a known non-UTF-8 encoding.
${BODIES_RULE ? `  - ${BODIES_RULE}\n` : ''}`
}

/** The v2 description (isCompactToolPromptsEnabled): the same rules, fewer words. */
export function getCompactDescription(): string {
  return `Search file contents with ripgrep. Use it instead of \`grep\` or \`rg\` in ${BASH_TOOL_NAME}.

- Full regex syntax; literal braces need escaping (\`interface\\{\\}\`), and \`multiline: true\` lets a pattern span lines.
- Filter with \`glob\` ("*.js", "**/*.tsx") or \`type\` ("js", "py", "rust").
- output_mode: "files_with_matches" (default), "content" (matching lines), "count" (per-file counts, largest first; footer totals are search-wide), "symbols" (the function or class signature enclosing each match). A broad "content" search comes back as the "symbols" map; pass \`head_limit\`, or narrow \`path\`/\`glob\`, to get the lines.
- smart-case: a lowercase pattern matches any case, one with an uppercase letter is case-sensitive; \`-i\` forces either.
- Files excluded by \`.gitignore\` are searched when nothing else matches, and reported separately; \`no_ignore: true\` includes them from the start. Binary and non-UTF-8 files are skipped unless you pass \`binary: true\` or an \`encoding\` ("utf-16le", "shift_jis").
- For an open-ended search that takes several rounds, use the ${AGENT_TOOL_NAME} tool.${BODIES_RULE ? `\n- ${BODIES_RULE}` : ''}`
}
