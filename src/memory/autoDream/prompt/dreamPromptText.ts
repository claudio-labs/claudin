/**
 * The prose of the dream prompt, one function per part, each returning its
 * lines. Facts the model must get exactly (file names, limits, sections) come
 * from the memory directory's own constants.
 */
import {
  DIR_EXISTS_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/memdir.js'
import { renderTeamCategoriesXml, TEAM_CATEGORIES } from 'src/memory/memdir/memoryTypes.js'

/** The first line, which the bench's wire proxy matches to tell this fork from the main loop. */
const DREAM_PROMPT_OPENING = '# Memory dream: consolidate what recent sessions taught you'

const INDEX_ENTRY_MAX_CHARS = 150
const OVERLONG_INDEX_LINE_CHARS = 200
const INDEX_ENTRY_FORMAT = '`- [Title](file.md) — one-line hook`'

export type DreamPromptPlaces = {
  readonly memoryRoot: string
  readonly transcriptDir: string
  /** The team directory without trailing separators, or null when the run is private only. */
  readonly teamDir: string | null
}

const indexSizeLimit = () => `~${Math.round(MAX_ENTRYPOINT_BYTES / 1000)}KB`

function opening(): string[] {
  return [
    DREAM_PROMPT_OPENING,
    '',
    'Step back from the day-to-day work and reflect. Read what recent sessions produced and turn the lessons into durable, well-organized memories, so that the next session can get its bearings quickly instead of rediscovering them.',
  ]
}

function whereThingsAre({ memoryRoot, transcriptDir, teamDir }: DreamPromptPlaces): string[] {
  const lines = ['', `Memory directory: \`${memoryRoot}\``, DIR_EXISTS_GUIDANCE]
  if (teamDir !== null) {
    lines.push(`Team directory: \`${teamDir}\`, with its own index \`${teamDir}/${ENTRYPOINT_NAME}\`.`)
  }
  lines.push(
    '',
    `Session transcripts: \`${transcriptDir}\`. They are large JSONL files: grep them for something specific, and never open one to read it whole.`,
    '',
    'Work through the four phases below, in order.',
  )
  return lines
}

function orient({ teamDir }: DreamPromptPlaces): string[] {
  const indexes =
    teamDir === null
      ? `the index, \`${ENTRYPOINT_NAME}\``
      : `both indexes, \`${ENTRYPOINT_NAME}\` and \`${teamDir}/${ENTRYPOINT_NAME}\``
  return [
    '',
    '## Phase 1 — Orient',
    '',
    '- List the memory directory to see what it already holds.',
    `- Read ${indexes}.`,
    '- Skim the topic files, so that you improve an existing file rather than write a second one on the same subject.',
    '- If `logs/` or `sessions/` exist, look over their most recent entries.',
  ]
}

function gather({ transcriptDir }: DreamPromptPlaces): string[] {
  return [
    '',
    '## Phase 2 — Gather',
    '',
    'Look for what deserves to be remembered, in these sources, best first:',
    '',
    '1. **What was decided.** The digest under "Additional context" at the end of this prompt lists the decision sources of the period: plans, with their `## Context`, their `## Agreed Decisions` and their blast radius; the prompts of each session; and the commits with impact (`feat`, `refactor`, breaking changes). Open a plan in full only when its entry points to a decision that clears the bar for a memory.',
    '2. **Daily logs**, at `logs/YYYY/MM/YYYY-MM-DD.md`, when there are any.',
    '3. **Memories that drifted:** facts the codebase no longer bears out.',
    '4. **A narrow transcript search**, for a term you already have a reason to look for:',
    `   \`grep -rn "<term>" ${transcriptDir}/ --include="*.jsonl" | tail -50\``,
    '',
    'Do not comb through the transcripts; search them for what you need and stop there.',
  ]
}

function whereToWrite({ memoryRoot, teamDir }: DreamPromptPlaces): string[] {
  if (teamDir === null) {
    return ['Every memory goes at the top level of the memory directory.', '']
  }
  const sections = TEAM_CATEGORIES.map(category => `\`## ${category.section}\``).join(' / ')
  return [
    'Decide where each memory belongs:',
    '',
    `- A private fact, one that only matters to this user, goes at the top level of \`${memoryRoot}\`.`,
    `- A team decision, a known defect or a pointer to documentation goes into the matching category subdirectory of \`${teamDir}\`, and its index line goes under that category's section of \`${teamDir}/${ENTRYPOINT_NAME}\`: ${sections}. The link names the subdirectory, as in \`(decisions/file.md)\`. Team context that fits no category goes at the team root.`,
    `- The team directory is tracked by git. Whatever you write there appears in the user's \`git status\` and reaches every teammate once committed, and that commit is the only review it gets. So write there only what clears the bar, and never a secret: no keys, tokens, passwords or credentials.`,
    '',
    // Ends with a blank line of its own.
    ...renderTeamCategoriesXml(),
  ]
}

function consolidate(places: DreamPromptPlaces): string[] {
  return [
    '',
    '## Phase 3 — Consolidate',
    '',
    ...whereToWrite(places),
    'For every memory you write or revise:',
    "- follow the memory format and the memory types that your system prompt's auto-memory section describes;",
    '- fold new information into the existing file on the subject instead of starting a near-copy;',
    '- turn relative dates ("yesterday", "last week") into absolute ones, which stay true later;',
    '- delete what newer evidence contradicts.',
  ]
}

function pruneAndIndex({ teamDir }: DreamPromptPlaces): string[] {
  const scope = teamDir === null ? 'The index' : 'Every index you touched'
  return [
    '',
    '## Phase 4 — Prune and index',
    '',
    `${scope} must stay under ${MAX_ENTRYPOINT_LINES} lines and ${indexSizeLimit()}. An index holds pointers, never the content of a memory: one line per entry, under ~${INDEX_ENTRY_MAX_CHARS} characters, shaped as ${INDEX_ENTRY_FORMAT}.`,
    '- Remove pointers to memories that are gone or no longer true.',
    `- Shorten any line longer than ~${OVERLONG_INDEX_LINE_CHARS} chars.`,
    '- Add a pointer for every new memory.',
    '- Where two entries disagree, settle it.',
  ]
}

function close({ teamDir }: DreamPromptPlaces): string[] {
  const lines = [
    '',
    '## When you are done',
    '',
    'Reply with a brief summary of what you consolidated, updated or pruned, or say plainly that nothing needed to change.',
  ]
  if (teamDir !== null) {
    lines.push('Name every team file you created, so the user knows what to review before committing.')
  }
  return lines
}

export function dreamPromptLines(places: DreamPromptPlaces): string[] {
  return [
    ...opening(),
    ...whereThingsAre(places),
    ...orient(places),
    ...gather(places),
    ...consolidate(places),
    ...pruneAndIndex(places),
    ...close(places),
  ]
}
