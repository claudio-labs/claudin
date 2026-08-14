import { z } from 'zod/v4'

import { buildTool, type ToolDef } from 'src/Tool.js'
import { lazySchema } from 'src/utils/data/lazySchema.js'
import { DESCRIPTION, RENAME_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage } from './UI.js'
import {
  checkRenamePermissions,
  type RenameOutput,
  runRename,
  summarizeRename,
  validateRenameInput,
} from './rename.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    symbol: z
      .string()
      .describe('The identifier to rename, matched as a whole word.'),
    replacement: z.string().describe('The new identifier.'),
    scope: z
      .string()
      .optional()
      .describe(
        'ripgrep glob(s) limiting the search, e.g. "src/**/*.ts". Defaults to the whole project.',
      ),
    mode: z
      .enum(['apply', 'preview'])
      .optional()
      .describe(
        'apply (default) renames every site atomically; preview writes nothing and lists the sites.',
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe('Site ids from a preview to leave untouched, e.g. ["s03"].'),
    sitesToken: z
      .string()
      .optional()
      .describe('The token from the preview those ids came from. Required with `exclude`.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const RenameTool = buildTool({
  name: RENAME_TOOL_NAME,
  searchHint: 'rename identifier symbol across files codemod',
  maxResultSizeChars: 60_000,
  async description() {
    return 'Rename an identifier across the project, whole-word and skipping strings/comments.'
  },
  getActivityDescription() {
    return 'Renaming'
  },
  async prompt() {
    return DESCRIPTION
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  toAutoClassifierInput(input) {
    return `${input.symbol} -> ${input.replacement}`
  },
  async validateInput(input) {
    return validateRenameInput(input)
  },
  async checkPermissions(input, context) {
    return checkRenamePermissions(input, context)
  },
  async call(input, context, _canUseTool, parentMessage) {
    const { output, newMessages } = await runRename(
      input,
      context,
      parentMessage.uuid,
    )
    return {
      data: output,
      ...(newMessages.length > 0 && { newMessages }),
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: summarizeRename(output),
    }
  },
  renderToolUseMessage(input) {
    const scope = input.scope ? ` in ${input.scope}` : ''
    const mode = input.mode === 'preview' ? ' (preview)' : ''
    return `${input.symbol ?? '?'} → ${input.replacement ?? '?'}${scope}${mode}`
  },
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, RenameOutput>)
