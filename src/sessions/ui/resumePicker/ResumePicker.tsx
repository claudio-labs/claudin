/**
 * The startup session picker behind `ResumeConversation`. It lists sessions
 * through `SessionsScreen`, acts on the choice, and ends the process through
 * the `exit` it is given.
 */
import React, { useCallback, useMemo, useState } from 'react'
import { REPL } from 'src/agent/repl/REPL.js'
import type { ResumeConversationProps } from 'src/sessions/ui/ResumeConversation.js'
import { filterLogsByPr } from 'src/sessions/ui/resumePicker/prFilter.js'
import { type ResumedSession, resumeChosenSession } from 'src/sessions/ui/resumePicker/resumeChoice.js'
import {
  FAILURE_BANNER_ROWS,
  FailureBanner,
  NothingToResume,
  ResumeElsewhere,
} from 'src/sessions/ui/resumePicker/screens.js'
import { useSessionList } from 'src/sessions/ui/resumePicker/useSessionList.js'
import { SessionsScreen } from 'src/sessions/ui/SessionsScreen.js'
import type { LogOption } from 'src/shared/types/logs.js'
import { LoadingState } from 'src/terminal/design-system/LoadingState.js'
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js'
import { Box } from 'src/terminal/ink.js'
import { setClipboard } from 'src/terminal/ink/termio/osc.js'
import { useAppStateStore } from 'src/terminal/state/AppState.js'

export type ResumePickerProps = ResumeConversationProps & {
  exit: (code: number) => void
}

type View =
  | { kind: 'choosing'; error?: string }
  | { kind: 'resuming' }
  | { kind: 'elsewhere'; command: string }
  | { kind: 'resumed'; session: ResumedSession }

/** Cancelling at startup: nothing runs yet, so the process just ends. */
const CANCELLED = 1
const HANDED_OVER = 0

export function ResumePicker(props: ResumePickerProps): React.ReactNode {
  const { worktreePaths, filterByPr, initialSearchQuery, forkSession = false, mainThreadAgentDefinition, exit } = props
  const store = useAppStateStore()
  const { rows } = useTerminalSize()
  const list = useSessionList(worktreePaths)
  const [view, setView] = useState<View>({ kind: 'choosing' })
  const listed = useMemo(() => filterLogsByPr(list.logs, filterByPr), [list.logs, filterByPr])
  const allProjects = list.scope === 'everywhere'

  const cancel = useCallback(() => exit(CANCELLED), [exit])
  const handedOver = useCallback(() => exit(HANDED_OVER), [exit])

  const choose = useCallback(
    async (log: LogOption) => {
      const outcome = await resumeChosenSession(log, {
        forkSession,
        showAllProjects: allProjects,
        worktreePaths,
        mainThreadAgentDefinition,
        getAppState: store.getState,
        setAppState: store.setState,
        onLoading: () => setView({ kind: 'resuming' }),
      })
      if (outcome.kind === 'elsewhere') {
        process.stdout.write(await setClipboard(outcome.command))
        setView({ kind: 'elsewhere', command: outcome.command })
      } else if (outcome.kind === 'failed') {
        setView({ kind: 'choosing', error: outcome.message })
      } else {
        setView({ kind: 'resumed', session: outcome.data })
      }
    },
    [forkSession, allProjects, worktreePaths, mainThreadAgentDefinition, store],
  )
  const onSelect = useCallback((log: LogOption) => void choose(log), [choose])

  if (view.kind === 'resumed') {
    const { session } = view
    return (
      <REPL
        commands={props.commands}
        initialTools={props.initialTools}
        initialMessages={session.messages}
        initialFileHistorySnapshots={session.fileHistorySnapshots}
        initialAgentName={session.agentName}
        initialAgentColor={session.agentColor}
        mainThreadAgentDefinition={session.agentDefinition}
        mcpClients={props.mcpClients}
        dynamicMcpConfig={props.dynamicMcpConfig}
        debug={props.debug}
        autoConnectIdeFlag={props.autoConnectIdeFlag}
        strictMcpConfig={props.strictMcpConfig ?? false}
        systemPrompt={props.systemPrompt}
        appendSystemPrompt={props.appendSystemPrompt}
        disableSlashCommands={props.disableSlashCommands ?? false}
        taskListId={props.taskListId}
        thinkingConfig={props.thinkingConfig}
        onTurnComplete={props.onTurnComplete}
      />
    )
  }
  if (view.kind === 'elsewhere') return <ResumeElsewhere command={view.command} onShown={handedOver} />
  if (view.kind === 'resuming') return <LoadingState message="Resuming conversation…" />
  if (list.loading && listed.length === 0) return <LoadingState message="Loading conversations…" />

  const banner = view.error === undefined ? null : <FailureBanner message={view.error} />
  if (listed.length === 0) {
    return (
      <Box flexDirection="column">
        {banner}
        <NothingToResume allProjects={allProjects} onToggleScope={list.toggleScope} onInterrupt={cancel} />
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {banner}
      <SessionsScreen
        logs={listed}
        loading={list.loading}
        onSelect={onSelect}
        onCancel={cancel}
        onLoadMore={list.loadMore}
        onLogsChanged={list.reload}
        showAllProjects={allProjects}
        onToggleAllProjects={list.toggleScope}
        initialSearchQuery={initialSearchQuery}
        maxHeight={banner ? rows - FAILURE_BANNER_ROWS : rows}
      />
    </Box>
  )
}
