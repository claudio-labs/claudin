/**
 * The prompt input's side of MCP prompt-argument completion: which prompt the
 * line invokes and which of its arguments the cursor is on, the hint for the
 * rest, the server's values as suggestion rows, and what accepting one does to
 * the line. The argument reading itself is `promptArgumentInput.ts` beside it;
 * useTypeahead only debounces the fetch and discards stale answers.
 */
import {
  acceptPromptArgumentValue,
  formatPromptArgumentHint,
  locatePromptArgument,
  type PromptArgumentPosition,
} from 'src/terminal/suggestions/promptArgumentInput.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import {
  type Command,
  getCommandName,
  type PromptArgumentSpec,
  type PromptArgumentValues,
} from 'src/shared/types/command.js'
import type { SuggestionItem } from 'src/terminal/prompt-input/PromptInputFooterSuggestions.js'

// Tab on an MCP prompt inserts its user-facing name, `srv:prompt (MCP)`
const MCP_NAME_WORD = '(MCP)'
const SUGGESTION_ID_PREFIX = 'prompt-argument-'

type PromptWithArgSpecs = Extract<Command, { type: 'prompt' }> & {
  argSpecs: PromptArgumentSpec[]
}

export type PromptArgumentPlan = {
  /** Absent when the server offers no values; the hint is all there is. */
  complete?: PromptArgumentValues
  /** `start` is an offset in the whole input line. */
  position: PromptArgumentPosition
  hint: string | undefined
}

function hasArgSpecs(command: Command): command is PromptWithArgSpecs {
  return command.type === 'prompt' && (command.argSpecs?.length ?? 0) > 0
}

function splitCommandLine(value: string): { name: string; argsStart: number } | null {
  const space = value.indexOf(' ')
  if (!value.startsWith('/') || space === -1) return null
  const name = value.slice(1, space)
  if (value.startsWith(`${MCP_NAME_WORD} `, space + 1)) {
    return { name: `${name} ${MCP_NAME_WORD}`, argsStart: space + MCP_NAME_WORD.length + 2 }
  }
  return { name, argsStart: space + 1 }
}

/**
 * What to show while the cursor, at the end of `value`, is on an argument of
 * an MCP prompt that carries argument specs. Null hands the line back to the
 * typeahead's other sources: not such a prompt, the cursor elsewhere, every
 * argument typed, or an `@` token, which keeps its file completion.
 */
export function planPromptArgumentCompletion(
  value: string,
  cursor: number,
  commands: readonly Command[],
): PromptArgumentPlan | null {
  if (cursor !== value.length) return null
  const line = splitCommandLine(value)
  if (!line) return null
  const command = commands.find(
    (candidate): candidate is PromptWithArgSpecs =>
      hasArgSpecs(candidate) &&
      (candidate.name === line.name || getCommandName(candidate) === line.name),
  )
  if (!command) return null

  const args = value.slice(line.argsStart)
  const position = locatePromptArgument(
    args,
    args.length,
    command.argSpecs.map(spec => spec.name),
  )
  if (!position || position.partial.startsWith('@')) return null
  return {
    ...(command.argumentValues && { complete: command.argumentValues }),
    position: { ...position, start: line.argsStart + position.start },
    // Like every argument hint, only between arguments
    hint:
      position.start === args.length
        ? formatPromptArgumentHint(command.argSpecs, position.index)
        : undefined,
  }
}

function argumentStartOf(item: SuggestionItem): number | undefined {
  const start = (item.metadata as { argumentStart?: unknown } | undefined)?.argumentStart
  return typeof start === 'number' ? start : undefined
}

/** The server's values for the planned argument, as suggestion rows. */
export async function fetchPromptArgumentSuggestions(
  plan: PromptArgumentPlan,
): Promise<SuggestionItem[]> {
  if (!plan.complete) return []
  const { name, partial, filled, start } = plan.position
  let values: string[]
  try {
    values = await plan.complete(name, partial, filled)
  } catch (error) {
    logForDebugging(`Prompt argument completion failed: ${errorMessage(error)}`)
    return []
  }
  return values.map(value => ({
    id: `${SUGGESTION_ID_PREFIX}${value}`,
    displayText: value,
    metadata: { argumentStart: start },
  }))
}

/**
 * The rows to keep on screen while the next fetch runs: the shown ones when
 * they were fetched for the argument the cursor is still on, none otherwise.
 */
export function keepPromptArgumentSuggestions(
  shown: SuggestionItem[],
  plan: PromptArgumentPlan,
): SuggestionItem[] {
  return shown.every(item => argumentStartOf(item) === plan.position.start) ? shown : []
}

/** The line after accepting `item`, or null when it no longer fits the line. */
export function acceptPromptArgumentSuggestion(
  item: SuggestionItem,
  input: string,
  cursor: number,
): { text: string; cursor: number } | null {
  const start = argumentStartOf(item)
  if (start === undefined || start > cursor || cursor > input.length) return null
  return acceptPromptArgumentValue(input, cursor, start, item.displayText)
}
