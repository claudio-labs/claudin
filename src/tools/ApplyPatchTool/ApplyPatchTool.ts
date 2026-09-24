import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/tools/Tool.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import {
  type ApplyPatchOutput,
  checkApplyPatchPermissions,
  resolveApplyPatchInput,
  runApplyPatch,
  summarizeApplyPatch,
  validateApplyPatchInput,
} from 'src/tools/ApplyPatchTool/applyPatch.js'
import { APPLY_PATCH_TOOL_NAME, DESCRIPTION } from 'src/tools/ApplyPatchTool/prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from 'src/tools/ApplyPatchTool/UI.js'

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
  userFacingName: () => 'Patch',
  searchHint: 'multi-file patch add update delete rename atomic',
  maxResultSizeChars: 100_000,
  clearableInputFields: ['patchText'],
  async description() {
    return 'Apply a multi-file patch (Codex apply_patch envelope).'
  },
  getActivityDescription() {
    return 'Applying patch'
  },
  async prompt() {
    // No compact variant: the one the v2 switch shipped (2026-09-24) led to
    // 6 malformed patches in 5 sessions against 0 in 10 on this text — hunks
    // out of order, a file in two sections, an Update with no "@@" — each one
    // re-sent whole. Team memory `prompts-v2-2026-09`.
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
  resolveInput(input, context) {
    return resolveApplyPatchInput(input, context)
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
