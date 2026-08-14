import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(): string {
  return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts, "symbols" maps each match to the enclosing function/class signature (TS/JS, Python, Go, Java, Kotlin, C#, Rust, C/C++, PHP, Swift, Scala, Ruby, Lua, Bash, SQL, CSS/SCSS, HTML, Markdown, YAML, XML, .properties, .env, TOML, Dockerfile, Makefile, GraphQL, Terraform)
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
  - Broad "content" searches (matches spread across many files) come back as the "symbols" map instead of the matching lines; pass \`head_limit\` explicitly, or narrow with \`path\`/\`glob\`, to get the lines.
  - Case: a lowercase pattern matches any case, a pattern containing an uppercase letter is matched case-sensitively (ripgrep smart-case). Pass \`-i: true\` to force insensitive, \`-i: false\` to force sensitive.
  - Files excluded by \`.gitignore\` are not searched. When a search finds nothing they are searched automatically and reported separately, so "no matches" means no matches anywhere; pass \`no_ignore: true\` to include them from the start.
  - Binary files and text that is not UTF-8 are skipped. Pass \`binary: true\` to search binary files as text, or \`encoding\` (e.g. "utf-16le", "shift_jis", "windows-1252") for a known non-UTF-8 encoding.
`
}
