import { randomBytes } from 'crypto'
import { basename } from 'path'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { callIdeRpc } from 'src/mcp/client/ide.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import type { PermissionOption } from 'src/permissions/ui/FilePermissionDialog/permissionOptions.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { getConnectedIdeClient, getConnectedIdeName } from 'src/platform/ide/ide.js'
import { AbortError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import type { FileEdit } from 'src/tools/FileEditTool/types.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { regionEdits, wholeTextEdit } from 'src/vcs/diff/hooks/ideDiff/editRebuild.js'
import { isIdeDiffAvailable } from 'src/vcs/diff/hooks/ideDiff/gate.js'
import { pathForIde, proposeEdits } from 'src/vcs/diff/hooks/ideDiff/proposal.js'

type Props = {
  onChange(
    option: PermissionOption,
    input: {
      file_path: string
      edits: FileEdit[]
    },
  ): void
  toolUseContext: ToolUseContext
  filePath: string
  edits: FileEdit[]
  editMode: 'single' | 'multiple'
}

/** The diff this mount opened: cancelling it closes its tab, once. */
type OpenDiff = {
  cancel: AbortController
  /** Settles once the diff is over, its tab closed. Never rejects. */
  finished: Promise<void>
}

export function useDiffInIDE({
  onChange,
  toolUseContext,
  filePath,
  edits,
  editMode,
}: Props): {
  closeTabInIDE: () => void
  showingDiffInIDE: boolean
  ideName: string
  hasError: boolean
} {
  const mcpClients = toolUseContext.options.mcpClients
  const [tabName] = useState(() => `✻ [Claudin] ${basename(filePath)} (${randomBytes(3).toString('hex')}) ⧉`)
  const [sentToIde] = useState(() =>
    isIdeDiffAvailable({ mcpClients, diffTool: getGlobalConfig().diffTool, filePath }),
  )
  const [hasError, setHasError] = useState(false)
  const ideName = useMemo(() => getConnectedIdeName(mcpClients) ?? 'IDE', [mcpClients])

  // The dialog hands a fresh callback on every render; the answer goes to the latest.
  const decide = useRef(onChange)
  decide.current = onChange
  const openDiff = useRef<OpenDiff | null>(null)

  // Once per mount: later props never reopen the diff.
  useEffect(() => {
    if (!sentToIde) return
    const cancel = new AbortController()
    const stop = (): void => cancel.abort()
    const toolSignal = toolUseContext.abortController.signal
    toolSignal.addEventListener('abort', stop)
    process.on('beforeExit', stop)
    const detach = (): void => {
      toolSignal.removeEventListener('abort', stop)
      process.off('beforeExit', stop)
    }

    const scoped: ToolUseContext = { ...toolUseContext, abortController: cancel }
    const finished = showDiffInIDE(filePath, edits, scoped, tabName)
      .then(({ oldContent, newContent }) => {
        if (cancel.signal.aborted) return
        const input =
          oldContent === newContent
            ? { file_path: filePath, edits }
            : { file_path: filePath, edits: computeEditsFromContents(filePath, oldContent, newContent, editMode) }
        decide.current({ type: oldContent === newContent ? 'reject' : 'accept-once' }, input)
      })
      .catch((error: unknown) => {
        if (cancel.signal.aborted) return
        logError(error)
        setHasError(true)
      })
      .finally(detach)
    openDiff.current = { cancel, finished }

    return () => {
      cancel.abort()
      detach()
    }
  }, [])

  const closeTab = useCallback(async (): Promise<void> => {
    const current = openDiff.current
    if (!current) return
    current.cancel.abort()
    await current.finished
  }, [])

  return {
    closeTabInIDE: closeTab,
    showingDiffInIDE: sentToIde && !hasError,
    ideName,
    hasError,
  }
}

export function computeEditsFromContents(
  filePath: string,
  oldContent: string,
  newContent: string,
  editMode: 'single' | 'multiple',
): FileEdit[] {
  return editMode === 'single'
    ? wholeTextEdit(oldContent, newContent)
    : regionEdits(filePath, oldContent, newContent)
}

/**
 * Opens the diff tab and waits for the user's action in the editor. The
 * answer comes back as a text pair: equal texts mean a rejection. Cancelling
 * `toolUseContext.abortController` closes the tab and rejects with AbortError.
 * The tab is closed exactly once, and only if it was opened.
 */
async function showDiffInIDE(
  file_path: string,
  edits: FileEdit[],
  toolUseContext: ToolUseContext,
  tabName: string,
): Promise<{ oldContent: string; newContent: string }> {
  const ide = getConnectedIdeClient(toolUseContext.options.mcpClients)
  if (!ide) throw new Error('No connected IDE to show the diff in')
  const proposal = proposeEdits(file_path, edits)
  const cancelled = toolUseContext.abortController.signal
  if (cancelled.aborted) throw new AbortError('The IDE diff was cancelled before it opened')

  const idePath = pathForIde(proposal.absolutePath, ide)
  const reply = callIdeRpc(
    'openDiff',
    {
      old_file_path: idePath,
      new_file_path: idePath,
      new_file_contents: proposal.newContent,
      tab_name: tabName,
    },
    ide,
  )

  let answer: unknown
  try {
    answer = await settledOrCancelled(reply, cancelled)
  } catch (error) {
    await closeTabInIDE(tabName, ide)
    throw error
  }
  void closeTabInIDE(tabName, ide)

  const blocks: unknown[] = Array.isArray(answer) ? answer : []
  if (isSaveMessage(blocks)) return { oldContent: proposal.oldContent, newContent: blocks[1].text }
  if (isClosedMessage(blocks[0])) return { oldContent: proposal.oldContent, newContent: proposal.newContent }
  if (isRejectedMessage(blocks[0])) return { oldContent: proposal.oldContent, newContent: proposal.oldContent }
  throw new Error(`The IDE answered the diff of ${file_path} with something unrecognised`)
}

async function closeTabInIDE(
  tabName: string,
  ideClient?: MCPServerConnection | undefined,
): Promise<void> {
  if (ideClient?.type !== 'connected') return
  try {
    await callIdeRpc('close_tab', { tab_name: tabName }, ideClient)
  } catch (error) {
    // The tab may already be gone with the editor; the decision stands either way.
    logError(error)
  }
}

function isClosedMessage(data: unknown): data is { text: 'TAB_CLOSED' } {
  return textOf(data) === 'TAB_CLOSED'
}

function isRejectedMessage(data: unknown): data is { text: 'DIFF_REJECTED' } {
  return textOf(data) === 'DIFF_REJECTED'
}

function isSaveMessage(
  data: unknown,
): data is [{ text: 'FILE_SAVED' }, { text: string }] {
  if (!Array.isArray(data)) return false
  return textOf(data[0]) === 'FILE_SAVED' && textOf(data[1]) !== undefined
}

function textOf(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null || !('text' in block)) return undefined
  return typeof block.text === 'string' ? block.text : undefined
}

/** The IDE's reply, unless the signal fires first. */
function settledOrCancelled<T>(reply: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortError('The IDE diff was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    reply.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
