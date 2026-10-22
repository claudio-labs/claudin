import chalk from 'chalk'
import { getSystemPrompt } from 'src/agent/prompts/prompts.js'
import { getSystemContext, getUserContext } from 'src/agent/context.js'
import { getShortcutDisplay } from 'src/terminal/keybindings/shortcutFormat.js'
import {
  buildPostCompactMessages,
  compactConversation,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
} from 'src/agent/compact/compact.js'
import { suppressCompactWarning } from 'src/agent/compact/compactWarningState.js'
import { microcompactMessages } from 'src/agent/compact/microCompact.js'
import { runPostCompactCleanup } from 'src/agent/compact/postCompactCleanup.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { LocalCommandCall } from 'src/shared/types/command.js'
import type { Message } from 'src/shared/types/message.js'
import { hasExactErrorMessage } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { getMessagesAfterCompactBoundary } from 'src/agent/messages/messages.js'
import { getUpgradeMessage } from 'src/providers/model/contextWindowUpgradeCheck.js'
import {
  buildEffectiveSystemPrompt,
  type SystemPrompt,
} from 'src/agent/systemPrompt.js'

export const call: LocalCommandCall = async (args, context) => {
  const { abortController } = context
  let { messages } = context

  // REPL keeps snipped messages for UI scrollback — project so the compact
  // model doesn't summarize content that was intentionally removed.
  messages = getMessagesAfterCompactBoundary(messages)

  if (messages.length === 0) {
    throw new Error('No messages to compact')
  }

  const customInstructions = args.trim()

  try {
    // Run microcompact first to reduce tokens before summarization
    const microcompactResult = await microcompactMessages(messages, context)
    const messagesForCompact = microcompactResult.messages

    const result = await compactConversation(
      messagesForCompact,
      context,
      await getCacheSharingParams(context, messagesForCompact),
      false,
      customInstructions,
      false,
    )

    // Suppress the "Context left until auto-compact" warning after successful compaction
    suppressCompactWarning()

    getUserContext.cache.clear?.()
    const postCompact = buildPostCompactMessages(result)
    runPostCompactCleanup(undefined, postCompact)

    return {
      type: 'compact',
      compactionResult: result,
      displayText: buildDisplayText(context, result.userDisplayMessage),
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error('Compaction canceled.')
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)) {
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_INCOMPLETE_RESPONSE)) {
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    } else {
      logError(error)
      throw new Error(`Error during compaction: ${error}`)
    }
  }
}

function buildDisplayText(
  context: ToolUseContext,
  userDisplayMessage?: string,
): string {
  const upgradeMessage = getUpgradeMessage('tip')
  const expandShortcut = getShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  const dimmed = [
    ...(context.options.verbose
      ? []
      : [`(${expandShortcut} to see full summary)`]),
    ...(userDisplayMessage ? [userDisplayMessage] : []),
    ...(upgradeMessage ? [upgradeMessage] : []),
  ]
  return chalk.dim('Compacted ' + dimmed.join('\n'))
}

async function getCacheSharingParams(
  context: ToolUseContext,
  forkContextMessages: Message[],
): Promise<{
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}> {
  const appState = context.getAppState()
  const defaultSysPrompt = await getSystemPrompt(
    context.options.tools,
    context.options.mainLoopModel,
    Array.from(
      appState.toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
    context.options.mcpClients,
  )
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt: defaultSysPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ])
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}
