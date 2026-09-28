/**
 * The session-memory template, the check for a file that still holds nothing
 * but the template, and the per-section cap applied before the file goes into
 * a compaction summary.
 */
import { readFile } from 'fs/promises'
import { join } from 'path'
import { capSectionBodies, type SectionCapResult } from 'src/memory/session/sectionCap.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { getActiveModelBytesPerToken } from 'src/shared/tokenEstimation.js'

/** Each section's header, and the one italic line saying what belongs under it. */
const TEMPLATE_SECTIONS: ReadonlyArray<readonly [header: string, guidance: string]> = [
  ['Session Title', 'A short, distinctive title for this session: 5-10 information-dense words'],
  ['Current State', 'What is being worked on right now, the tasks still pending, and the next steps'],
  ['Task specification', 'What the user asked to build, the design decisions taken, and the context behind them'],
  ['Files and Functions', 'The files that matter, what each one holds, and why it is relevant'],
  ['Workflow', 'The shell commands usually run, in what order, and how to read their output'],
  ['Errors & Corrections', 'Errors hit and how they were fixed, what the user corrected, and approaches not to try again'],
  ['Codebase and System Documentation', 'The important components of the system and how they fit together'],
  ['Learnings', 'What worked, what did not, and what to avoid, without repeating the other sections'],
  ['Key results', 'Any exact output the user asked for (an answer, a table, a document), repeated here in full'],
  ['Worklog', 'A terse, step-by-step record of what was tried and what was done'],
]

export const DEFAULT_SESSION_MEMORY_TEMPLATE = `\n${TEMPLATE_SECTIONS.map(
  ([header, guidance]) => `# ${header}\n_${guidance}_\n`,
).join('\n')}`

/** How many tokens one section may take in a compaction summary. */
const SECTION_TOKEN_BUDGET = 2_000

function customTemplatePath(): string {
  return join(getClaudinConfigHomeDir(), 'session-memory', 'config', 'template.md')
}

/** A user's own template replaces the default; one that cannot be read does not. */
async function sessionMemoryTemplate(): Promise<string> {
  try {
    return await readFile(customTemplatePath(), 'utf8')
  } catch (error) {
    if (!isENOENT(error)) logError(error)
    return DEFAULT_SESSION_MEMORY_TEMPLATE
  }
}

/** True while the content is the template and nothing else, surrounding whitespace aside. */
export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  const template = await sessionMemoryTemplate()
  return content.trim() === template.trim()
}

/** Caps each section at the characters its token budget buys with the active model's tokenizer. */
export function truncateSessionMemoryForCompact(content: string): SectionCapResult {
  return capSectionBodies(content, Math.floor(SECTION_TOKEN_BUDGET * getActiveModelBytesPerToken()))
}
