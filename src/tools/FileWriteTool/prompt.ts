import { feature } from 'bun:bundle'
import { isLeanToolPromptFamily } from 'src/constants/toolPromptTier.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'

export { FILE_WRITE_TOOL_NAME } from './constants.js'
export const DESCRIPTION = 'Write a file to the local filesystem.'

function getPreReadInstruction(): string {
  return `\n- If this is an existing file, you MUST use the ${FILE_READ_TOOL_NAME} tool first to read the file's contents — all of them, since a Write replaces the whole file. It fails if you did not read the file, or only read a range of it.`
}

export function getWriteToolDescription(): string {
  const lean = feature('LEAN_TOOL_PROMPTS') ? isLeanToolPromptFamily() : false
  return buildWriteToolDescription(lean)
}

// Pure builder so tests can render both shapes directly (the lean decision
// reads global state via getWriteToolDescription). Mirrors buildHarnessItems.
// The verbose (lean=false) output is byte-identical to the historical prompt.
export function buildWriteToolDescription(lean: boolean): string {
  // GATED: gold-plating guardrails redundant for capable families (covered by
  // the system prompt's altitude principle), kept for weak/unknown families.
  const guardrails = lean
    ? ''
    : `
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`
  return `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.${getPreReadInstruction()}
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.${guardrails}`
}
