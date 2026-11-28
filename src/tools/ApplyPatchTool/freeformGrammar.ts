/**
 * Patch as an OpenAI custom ("freeform") tool: the model writes the patch as
 * raw text, constrained by a Lark grammar, instead of a JSON string inside
 * `patchText`. This is how the Codex CLI 0.172 ships apply_patch to gpt-5.5
 * and later (`"apply_patch_tool_type": "freeform"` in its model catalog); the
 * grammar below is the one its binary embeds, less the `*** Environment ID:`
 * line Claudin has no use for. opencode ships the same text.
 *
 * Off by default: CLAUDIN_FREEFORM_PATCH=1 turns it on for the Responses
 * requests that may carry it (codexShim.ts), pending an A/B against the JSON
 * tool. The input comes back as `{ patchText }`, so the tool itself does not
 * change; `then` has no place in raw text and is not offered.
 */
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'

export const PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

const PATCH_TEXT_SENTENCE = 'The whole patch goes in the single `patchText` parameter.'
const FREEFORM_SENTENCE =
  'This is a FREEFORM tool: the patch itself is the input, raw text, not wrapped in JSON. ' +
  'Every unchanged context line starts with a space, a blank one included.'

/** The tools that go out as custom tools, and the input field their raw text fills. */
export const FREEFORM_TOOLS: ReadonlyMap<string, { field: string; grammar: string }> = new Map([
  [APPLY_PATCH_TOOL_NAME, { field: 'patchText', grammar: PATCH_LARK_GRAMMAR }],
])

// The models the Codex CLI's catalog marks freeform: gpt-5.5, the 5.6 family
// and every 6 or later.
const FREEFORM_MODEL_RE = /^gpt-(?:5\.5|5\.6|(?:[6-9]|[1-9]\d+))(?:[.-]|$)/

export function isFreeformPatchEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_FREEFORM_PATCH)
}

export function modelTakesFreeformTools(model: string): boolean {
  return FREEFORM_MODEL_RE.test(model.trim().toLowerCase())
}

/** A freeform tool's description: the JSON one, with its input sentence for raw text. */
export function freeformDescription(description: string): string {
  return description.includes(PATCH_TEXT_SENTENCE)
    ? description.replace(PATCH_TEXT_SENTENCE, FREEFORM_SENTENCE)
    : `${description}\n\n${FREEFORM_SENTENCE}`
}
