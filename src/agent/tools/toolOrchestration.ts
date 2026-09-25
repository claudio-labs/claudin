import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { isResponseChainsEnabled } from 'src/agent/prompts/steeringToggles.js'
import {
  type ChainCall,
  createResponseChain,
  describeCall,
} from 'src/agent/tools/responseChain.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import { findToolByName, type ToolUseContext } from 'src/tools/Tool.js'
import type { AssistantMessage, Message } from 'src/shared/types/message.js'
import { all } from 'src/shared/generators.js'
import { type MessageUpdateLazy, runToolUse } from 'src/agent/tools/toolExecution.js'

function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDIN_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}

export type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext
}

export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  // CLAUDIN_RESPONSE_CHAINS: once a call fails, the calls after it that would
  // run or ship code are skipped (responseChain.ts). Off, there is no chain
  // and every call runs as before.
  const chain = isResponseChainsEnabled() ? createResponseChain() : null
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(
    toolUseMessages,
    currentContext,
  )) {
    if (isConcurrencySafe) {
      const queuedContextModifiers: Record<
        string,
        ((context: ToolUseContext) => ToolUseContext)[]
      > = {}
      // Run read-only batch concurrently
      for await (const update of runToolsConcurrently(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (update.contextModifier) {
          const { toolUseID, modifyContext } = update.contextModifier
          if (!queuedContextModifiers[toolUseID]) {
            queuedContextModifiers[toolUseID] = []
          }
          queuedContextModifiers[toolUseID].push(modifyContext)
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
      for (const block of blocks) {
        const modifiers = queuedContextModifiers[block.id]
        if (!modifiers) {
          continue
        }
        for (const modifier of modifiers) {
          currentContext = modifier(currentContext)
        }
      }
      yield { newContext: currentContext }
    } else {
      // partitionToolCalls gives every unsafe call a batch of its own.
      const block = blocks[0]!
      const call = chain ? chainCallOf(block, currentContext) : null
      const skip = chain && call ? chain.skipText(call) : null
      if (skip !== null) {
        yield {
          message: skippedCallMessage(block, skip, assistantMessages),
          newContext: currentContext,
        }
        continue
      }
      // Run non-read-only batch serially
      for await (const update of runToolsSerially(
        blocks,
        assistantMessages,
        canUseTool,
        currentContext,
      )) {
        if (chain && call) chain.observe(call, update.message)
        if (update.newContext) {
          currentContext = update.newContext
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
    }
  }
}

type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] }

/** What the response chain needs to know about one unsafe call. */
function chainCallOf(
  toolUse: ToolUseBlock,
  toolUseContext: ToolUseContext,
): ChainCall {
  const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
  const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
  let readOnly = false
  if (tool && parsedInput?.success) {
    try {
      readOnly = Boolean(tool.isReadOnly(parsedInput.data))
    } catch {
      // Fail closed, like isConcurrencySafe in partitionToolCalls: a call
      // that cannot be shown read-only is treated as one that writes.
      readOnly = false
    }
  }
  return {
    id: toolUse.id,
    name: tool?.name ?? toolUse.name,
    readOnly,
    description: describeCall(toolUse.name, toolUse.input),
  }
}

function skippedCallMessage(
  toolUse: ToolUseBlock,
  text: string,
  assistantMessages: AssistantMessage[],
): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        content: `<tool_use_error>${text}</tool_use_error>`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ],
    toolUseResult: text,
    sourceToolAssistantUUID: assistantMessages.find(_ =>
      _.message.content.some(_ => _.type === 'tool_use' && _.id === toolUse.id),
    )?.uuid,
  })
}

/**
 * Partition tool calls into batches where each batch is either:
 * 1. A single non-read-only tool, or
 * 2. Multiple consecutive read-only tools
 */
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            // If isConcurrencySafe throws (e.g., due to shell-quote parse failure),
            // treat as not concurrency-safe to be conservative
            return false
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}

async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
    toolUseContext.setInProgressToolUseIDs(prev =>
      new Set(prev).add(toolUse.id),
    )
    // finally, not a trailing call: an abandoned consumer closes this
    // generator mid-yield, and the id would otherwise stay in the set for the
    // rest of the session (nothing reconciles it). Deleting it twice is a
    // no-op, so overlapping with any other release is safe.
    try {
      for await (const update of runToolUse(
        toolUse,
        assistantMessages.find(_ =>
          _.message.content.some(
            _ => _.type === 'tool_use' && _.id === toolUse.id,
          ),
        )!,
        canUseTool,
        currentContext,
      )) {
        if (update.contextModifier) {
          currentContext = update.contextModifier.modifyContext(currentContext)
        }
        yield {
          message: update.message,
          newContext: currentContext,
        }
      }
    } finally {
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }
  }
}

async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      toolUseContext.setInProgressToolUseIDs(prev =>
        new Set(prev).add(toolUse.id),
      )
      try {
        yield* runToolUse(
          toolUse,
          assistantMessages.find(_ =>
            _.message.content.some(
              _ => _.type === 'tool_use' && _.id === toolUse.id,
            ),
          )!,
          canUseTool,
          toolUseContext,
        )
      } finally {
        markToolUseAsComplete(toolUseContext, toolUse.id)
      }
    }),
    getMaxToolUseConcurrency(),
  )
}

function markToolUseAsComplete(
  toolUseContext: ToolUseContext,
  toolUseID: string,
) {
  toolUseContext.setInProgressToolUseIDs(prev => {
    const next = new Set(prev)
    next.delete(toolUseID)
    return next
  })
}
