import { feature } from 'bun:bundle'
import { isLeanToolPromptFamily } from 'src/agent/prompts/toolPromptTier.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isCompactLinePrefixEnabled } from 'src/shared/fs/file.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { isEditThenEnabled } from 'src/tools/shared/editThen/editThenShape.js'

// CLAUDIN_BASH_READ_CREDIT (off by default): a file a Bash `cat` printed whole
// counts as read (BashTool/creditShownFiles.ts), and the contract says so.
// Read once at module load, like the credit itself.
const READ_CREDIT = isEnvTruthy(process.env.CLAUDIN_BASH_READ_CREDIT)
// CLAUDIN_EDIT_THEN (editThenShape.ts), on unless `=0`, read once the same way.
const THEN_LINE = isEditThenEnabled()
  ? '\n- To check the change, put its test, typecheck or build command in `then`: it runs as soon as the edit applies, in this same call, and its output comes back with the result.'
  : ''

function getPreReadInstruction(): string {
  const mustRead = READ_CREDIT
    ? `You must read the file first — with \`${FILE_READ_TOOL_NAME}\`, or a Bash \`cat\` that printed it whole.`
    : `You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once in the conversation before editing.`
  return `\n- ${mustRead} This tool will error if you attempt an edit without reading the file. `
}

export function getEditToolDescription(): string {
  const lean = feature('LEAN_TOOL_PROMPTS') ? isLeanToolPromptFamily() : false
  return buildEditToolDescription(lean)
}

// Pure builder so tests can render both shapes directly (the lean decision
// reads global state via getEditToolDescription). Mirrors buildHarnessItems.
// The verbose (lean=false) output is byte-identical to the historical prompt.
export function buildEditToolDescription(lean: boolean): string {
  const prefixFormat = isCompactLinePrefixEnabled()
    ? 'line number + arrow'
    : 'spaces + line number + arrow'
  const minimalUniquenessHint = ''
  // GATED: gold-plating guardrails redundant for capable families (covered by
  // the system prompt's altitude principle), kept for weak/unknown families.
  const guardrails = lean
    ? ''
    : `
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.`
  return `Performs exact string replacements in files.

Usage:${getPreReadInstruction()}
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: ${prefixFormat}. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.${guardrails}
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.${minimalUniquenessHint}
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.${THEN_LINE}`
}
