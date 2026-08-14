import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'src/ink.js'
import type { CommandResultDisplay, LocalJSXCommandContext } from 'src/types/command.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from 'src/keybindings/useKeybinding.js'
import type { ToolUseContext } from 'src/Tool.js'
import { logError } from 'src/utils/log.js'
import { enqueuePendingNotification } from 'src/utils/messageQueueManager.js'
import { runWorkflow } from 'src/tools/AgentWorkflow/engine.js'
import type { RunState, WorkflowDef } from 'src/tools/AgentWorkflow/types.js'
import { RunningWorkflowsTab } from './RunningWorkflowsTab.js'
import { WorkflowsLibrary } from './WorkflowsLibrary.js'

type Tab = 'running' | 'library'

type Props = {
  // Opened as a slash command with the full LocalJSXCommandContext, or from the
  // footer status line with just a ToolUseContext (getToolUseContext) — the
  // menu only uses the ToolUseContext parts, so accept either.
  context: ToolUseContext & Partial<LocalJSXCommandContext>
  onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void
  /** Tab to open on (defaults to 'library'); the footer opens on 'running'. */
  initialTab?: Tab
  /** Run to pre-select on the Running tab (footer click passes the clicked run). */
  initialRunId?: string
}

const allowAllCanUseTool = (async (_tool: unknown, input: unknown) => ({
  behavior: 'allow',
  updatedInput: input,
})) as unknown as CanUseToolFn

function Footer({ hint, onExit, escActive = true }: { hint: string; onExit: () => void; escActive?: boolean }) {
  const exitState = useExitOnCtrlCDWithKeybindings()
  // In the detail view Esc means "back to list" (handled by RunningWorkflowsTab),
  // so gate the dialog-closing Esc off there. Context 'Settings', NOT
  // 'Confirmation': Confirmation also maps the *n* key to confirm:no, which
  // would close the dialog on the Library tab's "n new" shortcut — Settings
  // binds escape only (defaultBindings.ts).
  useKeybinding('confirm:no', onExit, { context: 'Settings', isActive: escActive })
  return (
    <Box marginLeft={2} marginTop={1}>
      <Text dimColor>{exitState.pending ? `Press ${exitState.keyName} again to exit` : hint}</Text>
    </Box>
  )
}

export function WorkflowsMenuWithTabs({ context, onExit, initialTab, initialRunId }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab ?? 'library')
  const [liveRun, setLiveRun] = useState<RunState | null>(null)
  // True while the Library is capturing free text (task/name); suppresses the
  // shell's Tab/arrow tab-switching so left/right edit the cursor, not the tab.
  const [inputActive, setInputActive] = useState(false)
  // True while the Running tab is showing a run's detail view — the tab bar is
  // hidden, the footer swaps, and tab-switching/Esc-close are suppressed.
  const [runningDetail, setRunningDetail] = useState(false)
  // Same, for the Library tab's structured workflow editor.
  const [libraryEditing, setLibraryEditing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  // A run is detached from the dialog: dismissing/unmounting does NOT abort it
  // (only the explicit 'x' stop or a re-run does). The board observes via
  // onProgress while mounted and via listRuns (disk) on reopen; completion fires
  // a task-notification. We only flip mountedRef so late onProgress/resolve don't
  // setState on the unmounted component.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const canUseTool: CanUseToolFn = context.canUseTool ?? allowAllCanUseTool

  const startRun = useCallback(
    (def: WorkflowDef, task: string) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setActiveTab('running')
      // Isolate the run from the REPL's live view. Workflow workers are sync
      // sub-agents that, via createSubagentContext(shareSetAppState), share THIS
      // context's setAppState — the REPL root store. On their first render they
      // would mutate REPL state that unmounts this very dialog, and the unmount
      // cleanup above then aborts the run (it surfaced as an instant "cancelled"
      // with 0 agents). The board renders from onProgress, so workers never need
      // to write to the REPL store. setAppStateForTasks still reaches the store
      // so background-task registration/cleanup keeps working (no zombies).
      const isolatedContext = {
        ...context,
        setAppState: () => {},
        setAppStateForTasks: context.setAppStateForTasks ?? context.setAppState,
      }
      runWorkflow({
        def,
        task,
        toolUseContext: isolatedContext,
        canUseTool,
        signal: controller.signal,
        onProgress: s => {
          if (mountedRef.current) setLiveRun({ ...s })
        },
      })
        .then(final => {
          if (mountedRef.current) setLiveRun({ ...final })
          // Notify on completion (mirrors the WorkflowTool background path) so a
          // run that finishes after the dialog is closed still surfaces a result.
          const result = (final.artifact || '').slice(0, 2000)
          enqueuePendingNotification({
            value: `<task-notification>\n<status>${final.status}</status>\n<summary>Workflow "${def.name}" ${final.status} (run ${final.runId})</summary>\n<result>${result}</result>\n</task-notification>`,
            mode: 'task-notification',
          })
        })
        .catch(error => logError(error))
    },
    [context, canUseTool],
  )

  const stopRun = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // eslint-disable-next-line custom-rules/prefer-use-keybindings -- tab switching is context-local
  useInput((input, key) => {
    if (key.tab || key.leftArrow) setActiveTab(t => (t === 'running' ? 'library' : 'running'))
    else if (key.rightArrow) setActiveTab('running')
  }, { isActive: !inputActive && !runningDetail && !libraryEditing })

  const tabBar = (
    <Box flexDirection="row" gap={1}>
      <Text bold color="permission">
        Workflows
      </Text>
      <Text bold={activeTab === 'running'} inverse={activeTab === 'running'}>
        {' '}Running{' '}
      </Text>
      <Text bold={activeTab === 'library'} inverse={activeTab === 'library'}>
        {' '}Library{' '}
      </Text>
    </Box>
  )

  const close = () => onExit('Workflows dialog dismissed', { display: 'system' })

  if (activeTab === 'running') {
    return (
      <Box flexDirection="column">
        {!runningDetail && tabBar}
        <RunningWorkflowsTab
          liveRun={liveRun}
          onStop={stopRun}
          initialRunId={initialRunId}
          onViewChange={setRunningDetail}
        />
        <Footer
          hint={runningDetail ? '↑↓ select · esc back · s save' : 'Tab tabs · ↑↓ select · Enter view · s save · x stop · d delete · Esc close'}
          escActive={!runningDetail}
          onExit={close}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {!libraryEditing && tabBar}
      <WorkflowsLibrary onRun={startRun} onInputActiveChange={setInputActive} onViewChange={setLibraryEditing} />
      <Footer
        hint={
          libraryEditing
            ? '↑↓ nav · Enter edit · a add · d del · K/J move · p prompt · s save · Esc back'
            : 'Tab tabs · ↑↓ select · Enter run · n new · e edit · d delete · Esc close'
        }
        escActive={!libraryEditing}
        onExit={close}
      />
    </Box>
  )
}
