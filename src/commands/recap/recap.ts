// /recap: the recap the "while you were away" card shows, on demand. It runs
// whether or not the card is on (CLAUDIN_AWAY_SUMMARY), as in Claude Code.

import { generateAwaySummary } from 'src/agent/awaySummary.js'
import type { LocalJSXCommandContext } from 'src/commands/commands.js'
import type { LocalCommandResult } from 'src/shared/types/command.js'
import type { Message } from 'src/shared/types/message.js'

export async function recapText(
  messages: readonly Message[],
  signal: AbortSignal,
  generate: typeof generateAwaySummary = generateAwaySummary,
): Promise<string> {
  const result = await generate(messages, signal)
  switch (result.kind) {
    case 'ok':
    case 'api-error':
      return result.text
    case 'no-turn':
      return 'Nothing to recap yet — send a message first.'
    case 'aborted':
      return 'Recap cancelled.'
    case 'failed':
      return "Couldn't generate a recap. Run with --debug for details."
  }
}

export async function call(
  _args: string,
  context: LocalJSXCommandContext,
): Promise<LocalCommandResult> {
  return {
    type: 'text',
    value: await recapText(context.messages, context.abortController.signal),
  }
}
