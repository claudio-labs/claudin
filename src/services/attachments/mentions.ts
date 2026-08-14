import { uniq } from 'src/utils/data/array.js'

// Two patterns: quoted paths and regular paths. Hoisted to module level so the
// regexes compile once at import time instead of on every call (Claudin rule:
// "Regex at module level").
const QUOTED_AT_MENTION_RE = /(^|\s)@"([^"]+)"/g
const REGULAR_AT_MENTION_RE = /(^|\s)@([^\s]+)\b/g

// Two guards against Windows-path / quoted-file collisions (see
// `attachments.extractors.test.ts`):
//
// 1. `(?!")` right after `@` drops quoted tokens entirely. The earlier
//    form (without the lookahead and with `[^\s]` character classes)
//    backtracked past the closing `"` at the `\b` anchor and produced
//    ghost matches like `"C:\Users\...\file.txt` for any quoted file
//    mention containing a colon.
// 2. The `"` added to the character classes is belt-and-braces: even
//    if the lookahead were later removed or bypassed, the engine can
//    no longer consume a quote character mid-match.
const MCP_RESOURCE_RE = /(^|\s)@(?!")([^\s"]+:[^\s"]+)\b/g
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/

const QUOTED_AGENT_RE = /(^|\s)@"([\w:.@-]+) \(agent\)"/g
const UNQUOTED_AGENT_RE = /(^|\s)@(agent-[\w:.@-]+)/g

const PARSE_LINE_RANGE_RE = /^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/

export function extractAtMentionedFiles(content: string): string[] {
  // Extract filenames mentioned with @ symbol, including line range syntax: @file.txt#L10-20
  // Also supports quoted paths for files with spaces: @"my/file with spaces.txt"
  // Example: "foo bar @baz moo" would extract "baz"
  // Example: 'check @"my file.txt" please' would extract "my file.txt"
  const quotedMatches: string[] = []
  const regularMatches: string[] = []

  // Extract quoted mentions first (skip agent mentions like @"code-reviewer (agent)")
  // Reset lastIndex because these are global regexes shared across calls.
  QUOTED_AT_MENTION_RE.lastIndex = 0
  let match
  while ((match = QUOTED_AT_MENTION_RE.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(' (agent)')) {
      quotedMatches.push(match[2]) // The content inside quotes
    }
  }

  // Extract regular mentions
  const regularMatchArray = content.match(REGULAR_AT_MENTION_RE) || []
  regularMatchArray.forEach(match => {
    const filename = match.slice(match.indexOf('@') + 1)
    // Don't include if it starts with a quote (already handled as quoted)
    if (!filename.startsWith('"')) {
      regularMatches.push(filename)
    }
  })

  // Combine and deduplicate
  return uniq([...quotedMatches, ...regularMatches])
}

export function extractMcpResourceMentions(content: string): string[] {
  // Extract MCP resources mentioned with @ symbol in format @server:uri
  // Example: "@server1:resource/path" would extract "server1:resource/path"
  const matches = content.match(MCP_RESOURCE_RE) || []

  return uniq(
    matches
      .map(match => match.slice(match.indexOf('@') + 1))
      // Post-match filter: a single-letter "server" followed by `:\` or
      // `:/` is always a Windows drive-letter prefix, never a real MCP
      // resource. This covers the unquoted `@C:\Users\...` case that
      // the regex alone cannot disambiguate from `@server:resource`.
      .filter(m => !WINDOWS_DRIVE_RE.test(m)),
  )
}

export function extractAgentMentions(content: string): string[] {
  // Extract agent mentions in two formats:
  // 1. @agent-<agent-type> (legacy/manual typing)
  //    Example: "@agent-code-elegance-refiner" → "agent-code-elegance-refiner"
  // 2. @"<agent-type> (agent)" (from autocomplete selection)
  //    Example: '@"code-reviewer (agent)"' → "code-reviewer"
  // Supports colons, dots, and at-signs for plugin-scoped agents like "@agent-asana:project-status-updater"
  const results: string[] = []

  // Match quoted format: @"<type> (agent)"
  QUOTED_AGENT_RE.lastIndex = 0
  let match
  while ((match = QUOTED_AGENT_RE.exec(content)) !== null) {
    if (match[2]) {
      results.push(match[2])
    }
  }

  // Match unquoted format: @agent-<type>
  const unquotedMatches = content.match(UNQUOTED_AGENT_RE) || []
  for (const m of unquotedMatches) {
    results.push(m.slice(m.indexOf('@') + 1))
  }

  return uniq(results)
}

export interface AtMentionedFileLines {
  filename: string
  lineStart?: number
  lineEnd?: number
}

export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  // Parse mentions like "file.txt#L10-20", "file.txt#heading", or just "file.txt"
  // Supports line ranges (#L10, #L10-20) and strips non-line-range fragments (#heading)
  const match = mention.match(PARSE_LINE_RANGE_RE)

  if (!match) {
    return { filename: mention }
  }

  const [, filename, lineStartStr, lineEndStr] = match
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart

  return { filename: filename ?? mention, lineStart, lineEnd }
}
