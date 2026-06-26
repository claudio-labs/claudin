import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  type ApplyPatchOutput,
  checkApplyPatchPermissions,
  runApplyPatch,
  summarizeApplyPatch,
  validateApplyPatchInput,
} from './applyPatch.js'
import { APPLY_PATCH_TOOL_NAME, DESCRIPTION } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    patchText: z
      .string()
      .describe(
        'The full apply_patch envelope, from "*** Begin Patch" to "*** End Patch".',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const ApplyPatchTool = buildTool({
  name: APPLY_PATCH_TOOL_NAME,
  userFacingName: () => 'ApplyPatch',
  searchHint: 'multi-file patch add update delete rename atomic',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Apply a multi-file patch (Codex apply_patch envelope).'
  },
  getActivityDescription() {
    return 'Applying patch'
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
    return input.patchText
  },
  async validateInput(input, context) {
    return validateApplyPatchInput(input, context)
  },
  async checkPermissions(input, context) {
    return checkApplyPatchPermissions(input, context)
  },
  async call(input, context, _canUseTool, parentMessage) {
    const { output, newMessages } = await runApplyPatch(
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
      content: summarizeApplyPatch(output),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, ApplyPatchOutput>)
