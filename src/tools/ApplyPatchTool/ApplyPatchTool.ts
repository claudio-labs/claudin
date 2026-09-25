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
import {
  APPLY_PATCH_TOOL_NAME,
  DESCRIPTION,
  LEGACY_APPLY_PATCH_TOOL_NAME,
} from 'src/tools/ApplyPatchTool/prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from 'src/tools/ApplyPatchTool/UI.js'
import {
  foldThenPermission,
  formatThen,
  resolveThen,
  runThen,
  takeThenSkipNote,
  thenClassifierInput,
} from 'src/tools/shared/editThen/editThen.js'
import { thenCommands, thenSchemaFields } from 'src/tools/shared/editThen/editThenShape.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    patchText: z
      .string()
      .describe(
        'The full patch envelope, from "*** Begin Patch" to "*** End Patch".',
      ),
    // CLAUDIN_EDIT_THEN (editThenShape.ts): absent with the flag off.
    ...thenSchemaFields(),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const ApplyPatchTool = buildTool({
  name: APPLY_PATCH_TOOL_NAME,
  aliases: [LEGACY_APPLY_PATCH_TOOL_NAME],
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
    return thenClassifierInput(input.patchText, input)
  },
  async resolveInput(input, context) {
    const resolved = resolveApplyPatchInput(input, context)
    if (!resolved.ok) return resolved
    // `*** Resubmit` swaps the patch text; the rest of the input is the call's.
    const withPatch = { ...input, patchText: resolved.input.patchText }
    return { ok: true, input: await resolveThen(withPatch, context) }
  },
  async validateInput(input, context) {
    return validateApplyPatchInput(input, context)
  },
  async checkPermissions(input, context) {
    return foldThenPermission(input, checkApplyPatchPermissions(input, context), context)
  },
  async call(input, context, _canUseTool, parentMessage) {
    const { output, newMessages } = await runApplyPatch(
      input,
      context,
      parentMessage.uuid,
    )
    const commands = thenCommands(input)
    const then = commands.length > 0 ? await runThen(commands, context) : undefined
    const thenNote = takeThenSkipNote(context)
    return {
      data: { ...output, ...(then && { then }), ...(thenNote && { thenNote }) },
      ...(newMessages.length > 0 && { newMessages }),
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: summarizeApplyPatch(output) + formatThen(output.then, output.thenNote),
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, ApplyPatchOutput>)
