/**
 * Public record* functions that route writes through the Project singleton.
 *
 * Extracted in Wave 3 of the 11c sessionStorage split. These wrap
 * `getProject().insert*` / `appendEntry` calls so callers don't need to know
 * about the singleton.
 */
import type { UUID } from 'crypto'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import type { AttributionSnapshotMessage } from 'src/shared/types/logs.js'
import type { Message } from 'src/shared/types/message.js'
import type { QueueOperationMessage } from 'src/shared/types/messageQueueTypes.js'
import type { FileHistorySnapshot } from 'src/shared/fs/fileHistory.js'
import { getProject } from 'src/sessions/persistence/project.js'
import {
  cleanMessagesForLogging,
} from 'src/sessions/pure/logging.js'
import { isChainParticipant } from 'src/sessions/pure/typeGuards.js'
import { getTranscriptPath } from 'src/sessions/pure/paths.js'
import { getSessionMessages } from 'src/sessions/resume/cache.js'
import { lastPromptOf } from 'src/sessions/persistence/writer/lastPrompt.js'
import { planRecording, type ChainMessage, type RecordingPlan } from 'src/sessions/persistence/writer/lines.js'

export type TeamInfo = {
  teamName?: string
  agentName?: string
}

/** What a call still has to write to the main transcript, given what is on disk or written since. */
async function planMainWrite(messages: readonly ChainMessage[], hint: UUID | null | undefined): Promise<RecordingPlan<ChainMessage>> {
  const recorded = await getSessionMessages(getSessionId() as UUID)
  return planRecording(messages, uuid => recorded.has(uuid) || getProject().holdsEntry(uuid), hint)
}

//
//
export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  const project = getProject()
  const cleaned = cleanMessagesForLogging(messages, allMessages)
  return project.runInOrder(async () => {
    const plan = await planMainWrite(cleaned, startingParentUuidHint)
    await project.insertMessageChain(plan.fresh, false, undefined, plan.parent, teamInfo)
    const lastPrompt = lastPromptOf(plan.fresh)
    if (lastPrompt !== undefined) project.currentSessionLastPrompt = lastPrompt
    return plan.last
  })
}

export async function recordSidechainTranscript(
  messages: Message[],
  agentId?: string,
  startingParentUuid?: UUID | null,
) {
  const project = getProject()
  const cleaned = cleanMessagesForLogging(messages)
  await project.runInOrder(async () => {
    // Forks share their parent's uuids, so an agent's own file takes every line again.
    if (agentId !== undefined) {
      await project.insertMessageChain(cleaned, true, agentId, startingParentUuid)
      return
    }
    const plan = await planMainWrite(cleaned, startingParentUuid)
    await project.insertMessageChain(plan.fresh, true, undefined, plan.parent)
  })
}

export async function recordQueueOperation(queueOp: QueueOperationMessage) {
  await getProject().insertQueueOperation(queueOp)
}

export async function removeTranscriptMessage(targetUuid: UUID): Promise<void> {
  await getProject().removeMessageByUuid(targetUuid)
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
) {
  await getProject().insertFileHistorySnapshot(messageId, snapshot, isSnapshotUpdate)
}

export async function recordAttributionSnapshot(
  snapshot: AttributionSnapshotMessage,
) {
  await getProject().insertAttributionSnapshot(snapshot)
}

export async function resetSessionFilePointer() {
  getProject().resetSessionFile()
}

export function adoptResumedSessionFile(): void {
  getProject().adoptSessionFile()
}

export async function recordContextCollapseCommit(commit: {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({ type: 'marble-origami-commit', sessionId, ...commit })
}

export async function recordContextCollapseSnapshot(snapshot: {
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({ type: 'marble-origami-snapshot', sessionId, ...snapshot })
}
