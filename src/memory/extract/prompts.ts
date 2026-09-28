/**
 * The prompt a memory-extraction fork receives, in two variants that share
 * one opening, and the hint an extraction forced by a repeated failure adds.
 *
 * The auto-only variant knows a single memory directory. The combined one,
 * which the shipped build sends because team memory follows auto memory,
 * adds the team taxonomy, its categories and the rule against secrets. The
 * taxonomy and exclusion sections come from memoryTypes.ts unchanged, since
 * the main agent's system prompt quotes the same ones.
 */
import { feature } from 'bun:bundle'
import {
  renderTeamCategoriesXml,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from 'src/memory/memdir/memoryTypes.js'
import {
  existingMemoryFiles,
  explicitRequests,
  howToSavePrivately,
  howToSaveWithTeamMemory,
  noSecretsInTeamMemory,
  repeatedFailure,
  roleAndScope,
  toolsAndTurnBudget,
} from 'src/memory/extract/prompts/sections.js'

function hasText(text: string | undefined): text is string {
  return text !== undefined && text.trim() !== ''
}

/** What both variants say first, up to the point where they part. */
function opening(newMessageCount: number, existingMemories: string, extraHint: string | undefined): string[] {
  return [
    ...roleAndScope(newMessageCount),
    ...toolsAndTurnBudget(),
    ...explicitRequests(),
    ...(hasText(existingMemories) ? existingMemoryFiles(existingMemories) : []),
    ...(hasText(extraHint) ? [extraHint, ''] : []),
  ]
}

export function buildExtractAutoOnlyPrompt(
  newMessageCount: number,
  existingMemories: string,
  extraHint?: string,
): string {
  return [
    ...opening(newMessageCount, existingMemories, extraHint),
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSavePrivately(),
  ].join('\n')
}

/** Without the TEAMMEM build flag there is no team memory, and this is the auto-only prompt. */
export function buildExtractCombinedPrompt(
  newMessageCount: number,
  existingMemories: string,
  extraHint?: string,
): string {
  if (!feature('TEAMMEM')) {
    return buildExtractAutoOnlyPrompt(newMessageCount, existingMemories, extraHint)
  }
  return [
    ...opening(newMessageCount, existingMemories, extraHint),
    ...TYPES_SECTION_COMBINED,
    ...renderTeamCategoriesXml(),
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...noSecretsInTeamMemory(),
    ...howToSaveWithTeamMemory(),
  ].join('\n')
}

export function buildLoopHint(toolName: string, repeatCount: number): string {
  return repeatedFailure(toolName, repeatCount).join('\n')
}
