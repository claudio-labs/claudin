// The read-only codebase search agent. It was removed on 2026-08-18 (#119) and
// came back on 2026-09-25, on by default (CLAUDIN_EXPLORE_AGENT=0 turns it off,
// builtInAgents.ts), with the numbers for and against it in
// .claudin/memory/team/decisions/explore-agent-removed.md.
//
// What its report is for: the parent answers from it, or edits from it. An
// excerpt it quotes becomes the context lines of a Patch hunk or the
// old_string of an Edit, so the contract below asks for whole lines copied
// verbatim with their line range — a paraphrase or an elided line sends the
// parent back to the file. AgentTool keeps the report out of the head/tail
// summarizer (UNSUMMARIZED_AGENT_TYPES) because the excerpts in its middle are
// the payload; the budget in the prompt is what bounds it instead.

import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { hasEmbeddedSearchTools } from 'src/agent/tools/embeddedTools.js'
import type { BuiltInAgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

export const EXPLORE_AGENT_TYPE = 'Explore'

function getExploreSystemPrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find/grep via Bash instead.
  const embedded = hasEmbeddedSearchTools()
  const globGuidance = embedded
    ? `- Use \`find\` via ${BASH_TOOL_NAME} for broad file pattern matching`
    : `- Use ${GLOB_TOOL_NAME} for broad file pattern matching`
  const grepGuidance = embedded
    ? `- Use \`grep\` via ${BASH_TOOL_NAME} for searching file contents with regex`
    : `- Use ${GREP_TOOL_NAME} for searching file contents with regex`

  return `You are a file search specialist for Claudin. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Guidelines:
${globGuidance}
${grepGuidance}
- Use ${FILE_READ_TOOL_NAME} when you know the specific file path you need to read — see "Reading order" below before opening one in full
- Use ${BASH_TOOL_NAME} ONLY for read-only operations (ls, git status, git log, git diff, git show, git blame, find${embedded ? ', grep' : ''}, cat, head, tail)
- NEVER use ${BASH_TOOL_NAME} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Use ${WEB_SEARCH_TOOL_NAME} and ${WEB_FETCH_TOOL_NAME} only when the question reaches outside this repository — a library's documented behavior, an upstream issue
- Match the thoroughness the caller asked for: "quick" — the likely location, a few searches; "medium" — explore until the answer is confirmed; "very thorough" — several locations, alternative names and naming conventions, until you can also say where it is NOT
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

## Reading order

Default to targeted reads. A full-file read costs tokens in proportion to the file's size, and most of what it returns is not what you were looking for.

1. Unknown file → ${FILE_READ_TOOL_NAME} with view='outline' first. It returns every function and class signature with its line range, for a small fraction of the full-file cost.
2. Need one function or class → symbol='name' to expand just that body.
3. Need the lines around a known location → offset/limit.
4. Read a file in full only when it is small, or when the outline genuinely does not answer the question.

## Required Output

Your report is the only thing the caller sees, and the caller may edit code from it: an excerpt you quote becomes the context lines of a ${APPLY_PATCH_TOOL_NAME} hunk or the old_string of an ${FILE_EDIT_TOOL_NAME}, copied as-is. Open with the answer in one to three sentences, then give each finding as:

### <absolute/path/to/file.ts>:<start>-<end>
\`\`\`
<lines start to end of the file, copied verbatim>
\`\`\`
<one line on why this answers the question>

Rules for the report:
- Every finding carries a \`path:start-end\` anchor: the full absolute path — never shortened with \`...\`, the caller passes it to ${FILE_EDIT_TOOL_NAME} and ${APPLY_PATCH_TOOL_NAME} as-is — and the 1-based line numbers ${FILE_READ_TOOL_NAME} showed for the first and last line of the excerpt itself, not of the function or class it sits in. A relative or shortened path, or a path with no line numbers, is an incomplete finding.
- Quote code VERBATIM, never paraphrased: whole lines, with their original indentation (tabs stay tabs). Leave out the line-number prefix ${FILE_READ_TOOL_NAME} adds (\`42→\`), and never put \`...\` inside an excerpt — when the lines you need are not contiguous, make them two findings. A paraphrased or elided excerpt sends the caller back to the file, which defeats the point of delegating the search.
- Keep each excerpt to the minimum that supports the finding — the few lines that matter, not the enclosing function and not the whole file. Where the caller is likely to change code, include the line above and the line below as well, so the excerpt can anchor the edit.
- Budget the whole report: about 8,000 characters for "quick" or "medium", 20,000 for "very thorough". When you have more than fits, give full findings for the ones that answer the question, and list the rest one per line as an absolute \`path:line\` followed by that single line quoted verbatim in backticks — still exact enough to anchor an edit.
- Finish with a "## Not found / not checked" section naming what you searched for and did not find, and what you deliberately did not open. Saying nothing there reads as "it does not exist".

Complete the user's search request efficiently, then report in the format above.`
}

const EXPLORE_WHEN_TO_USE =
  'Read-only agent for searching this codebase. Use it when an answer needs several dependent searches — tracing a feature end to end, mapping a subsystem, finding every call site of something. It returns `path:start-end` anchors with the lines quoted verbatim, exact enough to serve as Patch context or an Edit old_string. For a single directed lookup (one file path, one symbol definition), search directly instead. Say how thorough it should be: "quick", "medium" or "very thorough".'

export const EXPLORE_AGENT: BuiltInAgentDefinition = {
  agentType: EXPLORE_AGENT_TYPE,
  whenToUse: EXPLORE_WHEN_TO_USE,
  // An allowlist, not Plan's denylist: every tool added since — Build,
  // Container, the cron and workflow tools, worktrees — would otherwise reach a
  // read-only agent by default. Ant-native builds drop Glob/Grep for the
  // embedded find/grep, which Bash already covers.
  tools: hasEmbeddedSearchTools()
    ? [
        BASH_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ]
    : [
        GLOB_TOOL_NAME,
        GREP_TOOL_NAME,
        FILE_READ_TOOL_NAME,
        BASH_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ],
  source: 'built-in',
  baseDir: 'built-in',
  // The caller picks per call (haiku cheaper, opus stronger, inherit its own);
  // resolution and the non-Claude fallback are in providers/model/agent.ts.
  model: 'sonnet',
  // The same context a `readOnly: true` brief gets (readOnlyAgent.ts): no
  // CLAUDE.md family, no git status, no commit/PR protocol. The parent holds
  // the conventions and interprets the report.
  omitClaudeMd: true,
  omitGitStatus: true,
  omitGitInstructions: true,
  getSystemPrompt: () => getExploreSystemPrompt(),
}
