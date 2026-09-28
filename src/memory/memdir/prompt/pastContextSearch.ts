import { hasEmbeddedSearchTools } from 'src/agent/tools/embeddedTools.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getProjectDir } from 'src/sessions/sessionStoragePortable.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { isPastContextSearchEnabled } from 'src/memory/memdir/switches/promptSwitches.js'

const SEARCH_TERM = '<search term>'

type SearchCommands = { readonly memory: string; readonly transcripts: string }

function searchCommands(autoMemDir: string): SearchCommands {
  const transcriptsDir = `${getProjectDir(getOriginalCwd())}/`
  if (hasEmbeddedSearchTools()) {
    return {
      memory: `grep -rn "${SEARCH_TERM}" ${autoMemDir} --include="*.md"`,
      transcripts: `grep -rn "${SEARCH_TERM}" ${transcriptsDir} --include="*.jsonl"`,
    }
  }
  return {
    memory: `${GREP_TOOL_NAME} with pattern="${SEARCH_TERM}" path="${autoMemDir}" glob="*.md"`,
    transcripts: `${GREP_TOOL_NAME} with pattern="${SEARCH_TERM}" path="${transcriptsDir}" glob="*.jsonl"`,
  }
}

/**
 * How to look things up in memory and, failing that, in this project's session
 * transcripts. The lean form is a single line for the lean system prompt.
 */
export function buildSearchingPastContextSection(
  autoMemDir: string,
  lean = false,
): string[] {
  if (!isPastContextSearchEnabled()) return []
  const commands = searchCommands(autoMemDir)
  if (lean) {
    return [
      `Searching past context: look in your memory first (${commands.memory}); the session transcripts (${commands.transcripts}) are a slow last resort. Search for narrow terms such as an error message, a file path or a function name.`,
    ]
  }
  return [
    '## Searching past context',
    '',
    'When earlier work could help, search the topic files in your memory directory first:',
    '```',
    commands.memory,
    '```',
    'Only as a last resort, search the session transcripts, which are large and slow to scan:',
    '```',
    commands.transcripts,
    '```',
    'Search for narrow terms, such as an error message, a file path or a function name, rather than broad words.',
    '',
  ]
}
