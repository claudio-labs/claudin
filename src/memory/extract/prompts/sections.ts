/**
 * The prose of the memory-extraction prompts, one function per section, each
 * returning its lines. `../prompts.ts` decides which sections a variant
 * carries and in what order; nothing here branches on the variant.
 *
 * Tool names, the index file and its limits come from the constants that
 * define them, so renaming a tool or moving a limit cannot leave the prompt
 * describing the old one.
 */
import { ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES } from 'src/memory/memdir/memdir.js'
import { MEMORY_FRONTMATTER_EXAMPLE } from 'src/memory/memdir/memoryTypes.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/constants.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'

/**
 * The words every extraction prompt starts with. scripts/bench/ab/wire-proxy.ts
 * tells an extraction fork's requests from the main loop's by them (its
 * FORK_PROMPTS list), so a change here has to be made there too.
 */
const EXTRACTION_PROMPT_OPENING = 'From here on you are the memory-extraction agent'

/** Past this, an index entry is no longer a one-line hook. */
const INDEX_ENTRY_MAX_CHARS = 150

const INSPECTION_COMMANDS = ['ls', 'find', 'cat', 'stat', 'wc', 'head', 'tail']

function code(text: string): string {
  return `\`${text}\``
}

/** Who the model is now, and which messages it works from. */
export function roleAndScope(newMessageCount: number): string[] {
  return [
    `${EXTRACTION_PROMPT_OPENING}, working over the conversation above. Go through its most recent ~${newMessageCount} messages and keep whatever in them deserves to outlive this session, by saving it to the memory directory.`,
    '',
    'Take those messages at their word. Do not spend turns investigating or verifying what they say: no searching the codebase, no reading source files to confirm a claim, no git commands.',
    '',
  ]
}

/** The tools the fork's permission policy lets through, and how to spend its few turns. */
export function toolsAndTurnBudget(): string[] {
  return [
    'What you may use:',
    `- ${code(FILE_READ_TOOL_NAME)}, ${code(GREP_TOOL_NAME)} and ${code(GLOB_TOOL_NAME)}, on any path.`,
    `- ${code(BASH_TOOL_NAME)}, read-only: ${INSPECTION_COMMANDS.map(command => code(command)).join(', ')} and commands like them.`,
    `- ${code(FILE_EDIT_TOOL_NAME)} and ${code(FILE_WRITE_TOOL_NAME)}, on files inside the memory directory and nowhere else.`,
    '',
    `${code('rm')} is not allowed, and any other tool (an MCP tool, ${code(AGENT_TOOL_NAME)}, a ${code(BASH_TOOL_NAME)} command that writes) will be denied.`,
    '',
    `You have only a few turns, and ${code(FILE_EDIT_TOOL_NAME)} refuses a file you have not opened with ${code(FILE_READ_TOOL_NAME)} first. So spend one turn reading, in parallel, every file you might change, and the next one writing. Do not alternate between the two.`,
    '',
    'Writing nothing is the right outcome when nothing here clears the bar set out below. Do not lower the bar to have something to show: a memory that is noise is paid for in tokens by every session that follows.',
    '',
  ]
}

/** The memory files already on disk, so the model extends one instead of duplicating it. */
export function existingMemoryFiles(manifest: string): string[] {
  return [
    'These memory files exist already:',
    '',
    manifest,
    '',
    'When one of them covers the subject at hand, update that file instead of writing a second one about the same thing.',
    '',
  ]
}

export function explicitRequests(): string[] {
  return [
    'If the user explicitly asked you to remember something, save it right away, as whichever type fits it best. If they asked you to forget something, find that entry and remove it.',
    '',
  ]
}

export function noSecretsInTeamMemory(): string[] {
  return [
    '## Nothing secret in team memory',
    '',
    'Team memory is shared with everyone who works on this project. Never put sensitive data into it: no API keys, no user credentials, no tokens or passwords.',
    '',
  ]
}

/** Saving with a single memory directory and a single index. */
export function howToSavePrivately(): string[] {
  return [
    '## How to save a memory',
    '',
    'Saving is two steps.',
    '',
    'First, write the memory to a file of its own, opening with frontmatter in this form:',
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    `Then add a pointer to that file in ${code(ENTRYPOINT_NAME)}. ${indexEntryRules()}`,
    '',
    `- ${code(ENTRYPOINT_NAME)} is loaded into the system prompt of every session, and whatever comes after line ${MAX_ENTRYPOINT_LINES} is cut off, so keep it short.`,
    pathScopedMemories(),
    topicHygiene(),
  ]
}

/** Saving when private and team memory sit side by side, each with its own index. */
export function howToSaveWithTeamMemory(): string[] {
  return [
    '## How to save a memory',
    '',
    'Saving is two steps.',
    '',
    "First, write the memory to a file of its own, in the directory its scope calls for: a private memory at the top of the memory directory, a team memory at the root of the team directory, and a memory that belongs to a team category in that category's subdirectory. Open the file with frontmatter in this form:",
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    `Then add a pointer to it in the right index: the private ${code(ENTRYPOINT_NAME)} for a private memory, the team ${code(ENTRYPOINT_NAME)} for any team memory, categorized ones included. ${indexEntryRules()}`,
    '',
    `- Both indexes are loaded into the system prompt of every session, and whatever comes after line ${MAX_ENTRYPOINT_LINES} of either one is cut off, so keep them short.`,
    `${pathScopedMemories()} It is the recommended way to tie a bug or doc memory to the files it is about.`,
    topicHygiene(),
  ]
}

/** The hint an extraction forced by a repeated failure carries. */
export function repeatedFailure(toolName: string, repeatCount: number): string[] {
  return [
    '## A repeated failure',
    '',
    `Earlier in this conversation, ${code(toolName)} was called ${repeatCount}× with the same input, and it failed each time. If that failure teaches a durable, non-obvious lesson about how to approach this kind of work, save the lesson as a ${code('feedback')} memory: the rule first, then a **Why:** line and a **How to apply:** line. If it was a one-off slip whose fix is already in the code, save nothing, and do not write the incident down as a fix recipe.`,
    '',
    'This is a deliberate exception to the exclusion of fix recipes below: a lesson about approach may be kept, a recipe for one bug may not.',
  ]
}

function indexEntryRules(): string {
  return `An index is not a memory: it has no frontmatter, and no memory content goes into it. Each entry is a single line under ${INDEX_ENTRY_MAX_CHARS} characters, in the form ${code('- [Title](file.md) — one-line hook')}.`
}

function pathScopedMemories(): string {
  return `- A memory whose frontmatter lists ${code('paths:')} (glob patterns relative to the project root, written the way a rule under ${code('.claudin/rules/')} writes them) is attached automatically the first time a ${code(FILE_READ_TOOL_NAME)} touches a matching file.`
}

function topicHygiene(): string {
  return '- Keep memories organized by topic. Correct or delete a memory that turns out to be wrong, and never save the same thing twice.'
}
