// Attachment orchestration: composes every per-turn attachment producer
// into a single bounded pipeline with an early kill-switch
// (CLAUDE_CODE_DISABLE_ATTACHMENTS / CLAUDE_CODE_SIMPLE), a 1-second
// abort fence, and parallel main-thread / shared-thread fan-out.
//
// Extracted from src/services/attachments/attachments.ts as the final step of the split.
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import type { ToolUseContext } from 'src/Tool.js'
import { createAbortController } from 'src/shared/abortController.js'
import type { IDESelection } from 'src/hooks/useIdeSelection.js'
import type {
  AttachmentMessage,
  Message,
} from 'src/types/message.js'
import {
  type QueuedCommand,
  getImagePasteIds,
  isValidImagePaste,
} from 'src/types/textInputTypes.js'
import type {
  ContentBlockParam,
  ImageBlockParam,
  Base64ImageSource,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { maybeResizeAndDownsampleImageBlock } from 'src/utils/imageResizer.js'
import type { PastedContent } from 'src/services/config/config.js'
import { drainPendingMessages } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { QuerySource } from 'src/constants/querySource.js'
import { extractTextContent } from 'src/services/messages/messages.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { feature } from 'bun:bundle'
import { isAgentSwarmsEnabled } from 'src/coordinator/agentSwarmsEnabled.js'
import { isBuddyEnabled } from 'src/buddy/feature.js'
import { getCompanionIntroAttachment } from 'src/buddy/prompt.js'
import { isTodoV2Enabled } from 'src/tasks/tasks.js'
import { getTaskReconcileAttachments } from 'src/query/taskReconcile.js'
import type { Attachment } from 'src/services/attachments/types.js'
import { maybe, createAttachmentMessage } from 'src/services/attachments/shared.js'
import {
  processAtMentionedFiles,
  processMcpResourceAttachments,
  processAgentMentions,
  getSelectedLinesFromIDE,
  getOpenedFileFromIDE,
  getChangedFiles,
  getDynamicSkillAttachments,
  getDiagnosticAttachments,
  getLSPDiagnosticAttachments,
  getAsyncHookResponseAttachments,
  getTeammateMailboxAttachments,
} from 'src/services/attachments/services.js'
import {
  getDateChangeAttachments,
  getUltrathinkEffortAttachment,
  getDeferredToolsDeltaAttachment,
  getAgentListingDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
  getClaudeMdDeltaAttachment,
  getGitStatusDeltaAttachment,
  getCriticalSystemReminderAttachment,
  getOutputStyleAttachment,
  getTeamContextAttachment,
  getTokenUsageAttachment,
  getOutputTokenUsageAttachment,
  getMaxBudgetUsdAttachment,
  getContextEfficiencyAttachment,
} from 'src/services/attachments/injections.js'
import {
  getPlanModeAttachments,
  getPlanModeExitAttachment,
  getAutoModeAttachments,
  getAutoModeExitAttachment,
  getTodoReminderAttachments,
  getTaskReminderAttachments,
  getUnifiedTaskAttachments,
  getActiveBackgroundTaskReminders,
  getVerifyPlanReminderAttachment,
  getCompactionReminderAttachment,
} from 'src/services/attachments/lifecycle.js'
import { getNestedMemoryAttachments } from 'src/services/attachments/memory.js'
import {
  getSkillListingAttachments,
  getBashGitInstructionsAttachment,
} from 'src/services/attachments/skill-bash-gates.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const skillSearchModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      prefetch:
        require('../skillSearch/prefetch.js') as typeof import('../skillSearch/prefetch.js'),
    }
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * This is janky
 * TODO: Generate attachments when we create messages
 */
export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): Promise<Attachment[]> {
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS) ||
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
  ) {
    // query.ts:removeFromQueue dequeues these unconditionally after
    // getAttachmentMessages runs — returning [] here silently drops them.
    // Coworker runs with --bare and depends on task-notification for
    // mid-tool-call notifications from Local*Task/Remote*Task.
    return getQueuedCommandAttachments(queuedCommands)
  }

  // This will slow down submissions
  // TODO: Compute attachments as the user types, not here (though we use this
  // function for slash command prompts too)
  const abortController = createAbortController()
  const timeoutId = setTimeout(ac => ac.abort(), 1000, abortController)
  const context = { ...toolUseContext, abortController }

  const isMainThread = !toolUseContext.agentId

  // Subagents whose definition sets omitClaudeMd/omitGitStatus (Explore,
  // Plan, WebResearcher…) get those flags mirrored onto their context by
  // runAgent. The delta producers below read GLOBAL context state, so
  // without these gates they re-inject CLAUDE.md/rules/memory/gitStatus
  // that runAgent deliberately stripped from the subagent's userContext.
  const omitClaudeMd = toolUseContext.omitClaudeMdAttachments === true
  const omitGitStatus = toolUseContext.omitGitStatusAttachments === true

  // Attachments which are added in response to on user input
  const userInputAttachments = input
    ? [
        maybe('at_mentioned_files', () =>
          processAtMentionedFiles(input, context),
        ),
        maybe('mcp_resources', () =>
          processMcpResourceAttachments(input, context),
        ),
        maybe('agent_mentions', () =>
          Promise.resolve(
            processAgentMentions(
              input,
              toolUseContext.options.agentDefinitions.activeAgents,
            ),
          ),
        ),
        // Skill discovery on turn 0 (user input as signal). Inter-turn
        // discovery runs via startSkillDiscoveryPrefetch in query.ts,
        // gated on write-pivot detection — see skillSearch/prefetch.ts.
        // feature() here lets DCE drop the 'skill_discovery' string (and the
        // function it calls) from external builds.
        //
        // skipSkillDiscovery gates out the SKILL.md-expansion path
        // (getMessagesForPromptSlashCommand). When a skill is invoked, its
        // SKILL.md content is passed as `input` here to extract @-mentions —
        // but that content is NOT user intent and must not trigger discovery.
        // Without this gate, a 110KB SKILL.md fires ~3.3s of chunked AKI
        // queries on every skill invocation (session 13a9afae).
        ...(feature('EXPERIMENTAL_SKILL_SEARCH') &&
        skillSearchModules &&
        !options?.skipSkillDiscovery
          ? [
              maybe('skill_discovery', () =>
                skillSearchModules.prefetch.getTurnZeroSkillDiscovery(
                  input,
                  messages ?? [],
                  context,
                ),
              ),
            ]
          : []),
      ]
    : []

  // Process user input attachments first (includes @mentioned files)
  // This ensures files are added to nestedMemoryAttachmentTriggers before nested_memory processes them
  const userAttachmentResults = await Promise.all(userInputAttachments)

  // Thread-safe attachments available in sub-agents
  // NOTE: These must be created AFTER userInputAttachments completes to ensure
  // nestedMemoryAttachmentTriggers is populated before getNestedMemoryAttachments runs
  const allThreadAttachments = [
    // queuedCommands is already agent-scoped by the drain gate in query.ts —
    // main thread gets agentId===undefined, subagents get their own agentId.
    // Must run for all threads or subagent notifications drain into the void
    // (removed from queue by removeFromQueue but never attached).
    maybe('queued_commands', () => getQueuedCommandAttachments(queuedCommands)),
    maybe('date_change', () =>
      Promise.resolve(getDateChangeAttachments(messages)),
    ),
    maybe('ultrathink_effort', () =>
      Promise.resolve(getUltrathinkEffortAttachment(input)),
    ),
    maybe('deferred_tools_delta', () =>
      Promise.resolve(
        getDeferredToolsDeltaAttachment(
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
          {
            callSite: isMainThread
              ? 'attachments_main'
              : 'attachments_subagent',
            querySource,
          },
        ),
      ),
    ),
    maybe('agent_listing_delta', () =>
      Promise.resolve(getAgentListingDeltaAttachment(toolUseContext, messages)),
    ),
    maybe('mcp_instructions_delta', () =>
      Promise.resolve(
        getMcpInstructionsDeltaAttachment(
          toolUseContext.options.mcpClients,
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
        ),
      ),
    ),
    // Static-dedup deltas: emit only when the underlying content
    // changed since the last announcement. Replaces the always-emit
    // path that previously re-shipped CLAUDE.md / gitStatus / memory
    // every turn via prependUserContext / appendSystemContext. The
    // swap-in wiring lives in api.ts.
    ...(omitClaudeMd
      ? []
      : [maybe('claude_md_delta', () => getClaudeMdDeltaAttachment(messages))]),
    ...(omitGitStatus
      ? []
      : [
          maybe('git_status_delta', () =>
            getGitStatusDeltaAttachment(messages),
          ),
        ]),
    ...(isBuddyEnabled()
      ? [
          maybe('companion_intro', () =>
            Promise.resolve(getCompanionIntroAttachment(messages)),
          ),
        ]
      : []),
    maybe('changed_files', () => getChangedFiles(context)),
    // nested_memory carries per-directory CLAUDE.md + .claudin/rules content
    // — same class of material as claudeMd, so the same omission applies.
    ...(omitClaudeMd
      ? []
      : [maybe('nested_memory', () => getNestedMemoryAttachments(context))]),
    // relevant_memories moved to async prefetch (startRelevantMemoryPrefetch)
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    maybe('bash_git_instructions', () =>
      getBashGitInstructionsAttachment(context),
    ),
    // Inter-turn skill discovery now runs via startSkillDiscoveryPrefetch
    // (query.ts, concurrent with the main turn). The blocking call that
    // previously lived here was the assistant_turn signal — 97% of those
    // Haiku calls found nothing in prod. Prefetch + await-at-collection
    // replaces it; see src/services/skillSearch/prefetch.ts.
    maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)),
    maybe('plan_mode_exit', () => getPlanModeExitAttachment(toolUseContext)),
    ...(feature('TRANSCRIPT_CLASSIFIER')
      ? [
          maybe('auto_mode', () =>
            getAutoModeAttachments(messages, toolUseContext),
          ),
          maybe('auto_mode_exit', () =>
            getAutoModeExitAttachment(toolUseContext),
          ),
        ]
      : []),
    maybe('todo_reminders', () =>
      isTodoV2Enabled()
        ? getTaskReminderAttachments(messages, toolUseContext)
        : getTodoReminderAttachments(messages, toolUseContext),
    ),
    // Only on a real user turn. The tool loop calls this pipeline again after
    // every batch of tool results with input === null; firing there would
    // staple the reminder onto a file read mid-turn, which reads to the model
    // exactly like injected text — it flagged it as such when tried.
    ...(input !== null
      ? [
          maybe('task_reconcile', () =>
            getTaskReconcileAttachments(messages, toolUseContext),
          ),
        ]
      : []),
    ...(isAgentSwarmsEnabled()
      ? [
          // Skip teammate mailbox for the session_memory forked agent.
          // It shares AppState.teamContext with the leader, so isTeamLead resolves
          // true and it reads+marks-as-read the leader's DMs as ephemeral attachments,
          // silently stealing messages that should be delivered as permanent turns.
          ...(querySource === 'session_memory'
            ? []
            : [
                maybe('teammate_mailbox', async () =>
                  getTeammateMailboxAttachments(toolUseContext),
                ),
              ]),
          maybe('team_context', async () =>
            getTeamContextAttachment(messages ?? []),
          ),
        ]
      : []),
    maybe('agent_pending_messages', async () =>
      getAgentPendingMessageAttachments(toolUseContext),
    ),
    maybe('critical_system_reminder', () =>
      Promise.resolve(getCriticalSystemReminderAttachment(toolUseContext)),
    ),
    ...(feature('COMPACTION_REMINDERS')
      ? [
          maybe('compaction_reminder', () =>
            Promise.resolve(
              getCompactionReminderAttachment(
                messages ?? [],
                toolUseContext.options.mainLoopModel,
              ),
            ),
          ),
        ]
      : []),
    ...(feature('HISTORY_SNIP')
      ? [
          maybe('context_efficiency', () =>
            Promise.resolve(getContextEfficiencyAttachment(messages ?? [])),
          ),
        ]
      : []),
  ]

  // Attachments which are semantically only for the main conversation or don't have concurrency-safe implementations
  const mainThreadAttachments = isMainThread
    ? [
        maybe('ide_selection', async () =>
          getSelectedLinesFromIDE(ideSelection, toolUseContext),
        ),
        maybe('ide_opened_file', async () =>
          getOpenedFileFromIDE(ideSelection, toolUseContext),
        ),
        maybe('output_style', async () =>
          Promise.resolve(getOutputStyleAttachment()),
        ),
        maybe('diagnostics', async () =>
          getDiagnosticAttachments(toolUseContext),
        ),
        maybe('lsp_diagnostics', async () =>
          getLSPDiagnosticAttachments(toolUseContext),
        ),
        maybe('unified_tasks', async () =>
          getUnifiedTaskAttachments(toolUseContext),
        ),
        maybe('active_task_reminders', async () =>
          getActiveBackgroundTaskReminders(toolUseContext, messages),
        ),
        maybe('async_hook_responses', async () =>
          getAsyncHookResponseAttachments(),
        ),
        maybe('token_usage', async () =>
          Promise.resolve(
            getTokenUsageAttachment(
              messages ?? [],
              toolUseContext.options.mainLoopModel,
            ),
          ),
        ),
        maybe('budget_usd', async () =>
          Promise.resolve(
            getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd),
          ),
        ),
        maybe('output_token_usage', async () =>
          Promise.resolve(getOutputTokenUsageAttachment()),
        ),
        maybe('verify_plan_reminder', async () =>
          getVerifyPlanReminderAttachment(messages, toolUseContext),
        ),
      ]
    : []

  // Process thread and main thread attachments in parallel (no dependencies between them)
  const [threadAttachmentResults, mainThreadAttachmentResults] =
    await Promise.all([
      Promise.all(allThreadAttachments),
      Promise.all(mainThreadAttachments),
    ])

  clearTimeout(timeoutId)
  // Defensive: a getter leaking [undefined] crashes .map(a => a.type) below.
  const merged = [
    ...userAttachmentResults.flat(),
    ...threadAttachmentResults.flat(),
    ...mainThreadAttachmentResults.flat(),
  ].filter((a): a is Attachment => a !== undefined && a !== null)

  // Dedup task_status by taskId — getUnifiedTaskAttachments and the per-turn
  // reminder may both emit for the same taskId; the unified one wins because
  // it carries fresh Progress: data. Order in `merged` is preserved by
  // Promise.all + flat(), so first-seen is the right one to keep.
  const seenTaskStatusIds = new Set<string>()
  return merged.filter(a => {
    if (a.type !== 'task_status') return true
    if (seenTaskStatusIds.has(a.taskId)) return false
    seenTaskStatusIds.add(a.taskId)
    return true
  })
}

const INLINE_NOTIFICATION_MODES = new Set(['prompt', 'task-notification'])

export async function getQueuedCommandAttachments(
  queuedCommands: QueuedCommand[],
): Promise<Attachment[]> {
  if (!queuedCommands) {
    return []
  }
  // Include both 'prompt' and 'task-notification' commands as attachments.
  // During proactive agentic loops, task-notification commands would otherwise
  // stay in the queue permanently (useQueueProcessor can't run while a query
  // is active), causing hasCommandsInQueue() to return true and Sleep to
  // wake immediately with 0ms duration in an infinite loop.
  const filtered = queuedCommands.filter(_ =>
    INLINE_NOTIFICATION_MODES.has(_.mode),
  )
  return Promise.all(
    filtered.map(async _ => {
      const imageBlocks = await buildImageContentBlocks(_.pastedContents)
      let prompt: string | Array<ContentBlockParam> = _.value
      if (imageBlocks.length > 0) {
        // Build content block array with text + images so the model sees them
        const textValue =
          typeof _.value === 'string'
            ? _.value
            : extractTextContent(_.value, '\n')
        prompt = [{ type: 'text' as const, text: textValue }, ...imageBlocks]
      }
      return {
        type: 'queued_command' as const,
        prompt,
        source_uuid: _.uuid,
        imagePasteIds: getImagePasteIds(_.pastedContents),
        commandMode: _.mode,
        origin: _.origin,
        isMeta: _.isMeta,
      }
    }),
  )
}

export function getAgentPendingMessageAttachments(
  toolUseContext: ToolUseContext,
): Attachment[] {
  const agentId = toolUseContext.agentId
  if (!agentId) return []
  const drained = drainPendingMessages(
    agentId,
    toolUseContext.getAppState,
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState,
  )
  return drained.map(msg => ({
    type: 'queued_command' as const,
    prompt: msg,
    origin: { kind: 'coordinator' as const },
    isMeta: true,
  }))
}

async function buildImageContentBlocks(
  pastedContents: Record<number, PastedContent> | undefined,
): Promise<ImageBlockParam[]> {
  if (!pastedContents) {
    return []
  }
  const imageContents = Object.values(pastedContents).filter(isValidImagePaste)
  if (imageContents.length === 0) {
    return []
  }
  const results = await Promise.all(
    imageContents.map(async img => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (img.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: img.content,
        },
      }
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return resized.block
    }),
  )
  return results
}

export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): AsyncGenerator<AttachmentMessage, void> {
  // TODO: Compute this upstream
  const attachments = await getAttachments(
    input,
    toolUseContext,
    ideSelection,
    queuedCommands,
    messages,
    querySource,
    options,
  )

  if (attachments.length === 0) {
    return
  }

  logEvent('tengu_attachments', {
    attachment_types: attachments.map(
      _ => _.type,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}
