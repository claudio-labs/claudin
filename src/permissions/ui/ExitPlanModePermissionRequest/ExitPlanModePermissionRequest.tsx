import type { UUID } from 'crypto'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppState, useAppStateStore, useSetAppState } from 'src/terminal/state/AppState.js'
import {
  getSdkBetas,
  getSessionId,
  isSessionPersistenceDisabled,
  setHasExitedPlanMode,
  setNeedsPlanModeExitAttachment,
} from 'src/platform/bootstrap/state.js'
import { generateSessionName } from 'src/commands/rename/generateSessionName.js'
import { Box, Text, useInput } from 'src/terminal/ink.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import type { AllowedPrompt } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { isAgentSwarmsEnabled } from 'src/agent/coordinator/agentSwarmsEnabled.js'
import { calculateContextPercentages, getContextWindowForModel } from 'src/agent/context/context.js'
import { getExternalEditor } from 'src/shared/editor.js'
import { getDisplayPath } from 'src/shared/fs/file.js'
import { toIDEDisplayName } from 'src/platform/ide/ide.js'
import { logError } from 'src/shared/log.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { getMainLoopModel, getRuntimeMainLoopModel } from 'src/providers/model/model.js'
import { createPromptRuleContent, isClassifierPermissionsEnabled } from 'src/permissions/bashClassifier.js'
import { type PermissionMode, toExternalPermissionMode } from 'src/permissions/PermissionMode.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { isAutoModeGateEnabled } from 'src/permissions/permissionSetup.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'
import {
  autoModeBuiltIn,
  autoSemanticsActive,
  switchAutoOff,
  switchAutoOn,
} from 'src/permissions/permissionSetup/autoSession.js'
import { getPlan, getPlanFilePath } from 'src/agent/plans/plans.js'
import { getCurrentSessionTitle, getTranscriptPath, saveCustomTitle } from 'src/sessions/sessionStorage.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { type OptionWithDescription, Select } from 'src/terminal/custom-select/index.js'
import { Markdown } from 'src/terminal/markdown/Markdown.js'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import type { PermissionRequestProps } from 'src/permissions/ui/PermissionRequest.js'
import { PermissionRuleExplanation } from 'src/permissions/ui/PermissionRuleExplanation.js'
import {
  answerFor,
  type PlanAnswer,
  type PlanOffer,
  planApprovalChoices,
  type ResponseValue,
  shortcutAnswer,
} from 'src/permissions/ui/modeDialogs/planExitChoices.js'
import { type ApprovingAnswer, planExitOutcome } from 'src/permissions/ui/modeDialogs/planExitOutcome.js'
import { clearContextPrompt } from 'src/permissions/ui/modeDialogs/clearContextPrompt.js'
import { imageBlocksOf, usePastedImages } from 'src/permissions/ui/modeDialogs/usePastedImages.js'
import { usePlanEditor } from 'src/permissions/ui/modeDialogs/usePlanEditor.js'
import { PlanApprovalQuestion, PlanFooterFrame } from 'src/permissions/ui/modeDialogs/PlanApprovalQuestion.js'

/** The session is named from the head of the plan only. */
const NAMING_SOURCE_CHARS = 1_000

const IMAGE_ONLY_REASON = '(See attached image)'

export function buildPermissionUpdates(mode: PermissionMode, allowedPrompts?: AllowedPrompt[]): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [{ type: 'setMode', mode: toExternalPermissionMode(mode), destination: 'session' }]
  if (isClassifierPermissionsEnabled() && allowedPrompts && allowedPrompts.length > 0) {
    updates.push({
      type: 'addRules',
      rules: allowedPrompts.map(({ tool, prompt }) => ({ toolName: tool, ruleContent: createPromptRuleContent(prompt) })),
      behavior: 'allow',
      destination: 'session',
    })
  }
  return updates
}

function keepsNoTranscripts(): boolean {
  return isSessionPersistenceDisabled() || getInitialSettings().cleanupPeriodDays === 0
}

export function autoNameSessionFromPlan(plan: string, isClearContext: boolean): void {
  if (keepsNoTranscripts()) return
  // Clearing context starts the session over, so an old title does not stop the request.
  if (!isClearContext && getCurrentSessionTitle(getSessionId())) return
  const head = createUserMessage({ content: plan.slice(0, NAMING_SOURCE_CHARS) })
  generateSessionName([head], new AbortController().signal)
    .then(async name => {
      const sessionId = getSessionId()
      // A title that arrived while the model was thinking is never overwritten.
      if (!name || getCurrentSessionTitle(sessionId)) return
      await saveCustomTitle(sessionId as UUID, name)
    })
    .catch(logError)
}

type AnswerFacts = {
  plan: string
  /** The approval input: `{}`, or the plan when it was edited in this dialog. */
  input: Record<string, unknown>
  /** Trimmed; empty when nothing was typed. */
  feedback: string
}

type PlanExitActions = {
  approve: (answer: ApprovingAnswer, facts: AnswerFacts) => void
  refuse: (reason: string, images: Awaited<ReturnType<typeof imageBlocksOf>>) => void
  cancel: () => void
}

/** How each answer reaches the request, the caller and the session. */
function usePlanExitActions({
  toolUseConfirm,
  onDone,
  onReject,
}: Pick<PermissionRequestProps, 'toolUseConfirm' | 'onDone' | 'onReject'>): PlanExitActions {
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const allowedPrompts = (toolUseConfirm.input as { allowedPrompts?: AllowedPrompt[] }).allowedPrompts

  const setContext = (next: AppState['toolPermissionContext']) =>
    setAppState(previous => ({ ...previous, toolPermissionContext: next }))

  const approve = (answer: ApprovingAnswer, { plan, input, feedback }: AnswerFacts) => {
    const builtIn = autoModeBuiltIn()
    const outcome = planExitOutcome(answer, {
      autoBuiltIn: builtIn,
      gateOpen: builtIn && isAutoModeGateEnabled(),
      autoActive: autoSemanticsActive(),
    })
    const context = store.getState().toolPermissionContext
    switch (outcome.auto) {
      case 'leave':
        setContext({ ...switchAutoOff(context), prePlanMode: undefined })
        break
      case 'enterContext':
        setContext({ ...switchAutoOn(context), mode: 'auto', prePlanMode: undefined })
        break
      case 'enterFlag':
        autoModeStateModule?.setAutoModeActive(true)
        break
      case 'untouched':
        break
    }
    setHasExitedPlanMode(true)
    if (outcome.planExitNotice) setNeedsPlanModeExitAttachment(true)

    const restart = outcome.route === 'restart'
    if (restart) {
      const content = clearContextPrompt({
        plan,
        transcriptPath: getTranscriptPath(),
        teamsEnabled: isAgentSwarmsEnabled(),
        feedback,
      })
      const message = Object.assign(createUserMessage({ content }), { planContent: plan })
      setAppState(previous => ({
        ...previous,
        initialMessage: { message, clearContext: true, mode: outcome.mode, allowedPrompts },
      }))
      // The tool call is turned down to free the loop; the next turn starts from the message.
      onDone()
      onReject()
      toolUseConfirm.onReject()
    } else {
      const updates = outcome.auto === 'enterContext' ? [] : buildPermissionUpdates(outcome.mode, allowedPrompts)
      onDone()
      toolUseConfirm.onAllow(input, updates, feedback || undefined)
    }
    if (outcome.nameSession) autoNameSessionFromPlan(plan, restart)
  }

  const refuse: PlanExitActions['refuse'] = (reason, images) => {
    onDone()
    onReject()
    toolUseConfirm.onReject(reason, images)
  }

  const cancel = () => {
    onDone()
    onReject()
    toolUseConfirm.onReject()
  }

  return { approve, refuse, cancel }
}

/** Keeps a callback's identity across renders while it always runs the latest closure. */
function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(callback)
  useLayoutEffect(() => {
    latest.current = callback
  })
  return useCallback((...args: Args) => latest.current(...args), [])
}

export function ExitPlanModePermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
  setStickyFooter
}: PermissionRequestProps): React.ReactNode {
  const [initialPlan] = useState(() => getPlan() ?? '')
  const actions = usePlanExitActions({ toolUseConfirm, onDone, onReject })
  if (initialPlan.trim() === '') return <EmptyPlanExit actions={actions} workerBadge={workerBadge} />
  return (
    <PlanApproval
      initialPlan={initialPlan}
      actions={actions}
      toolUseConfirm={toolUseConfirm}
      workerBadge={workerBadge}
      setStickyFooter={setStickyFooter}
    />
  )
}

/** No plan to show: a short yes/no that always leaves plan mode for the default mode (finding 6, kept). */
function EmptyPlanExit({ actions, workerBadge }: { actions: PlanExitActions; workerBadge: PermissionRequestProps['workerBadge'] }) {
  const answer = (value: 'yes' | 'no') =>
    value === 'yes' ? actions.approve({ kind: 'plainExit' }, { plan: '', input: {}, feedback: '' }) : actions.cancel()
  return (
    <PermissionDialog color="planMode" title="Exit plan mode?" workerBadge={workerBadge}>
      <Box flexDirection="column" marginTop={1}>
        <Text>Claude wants to exit plan mode</Text>
        <Box marginTop={1}>
          <Select
            options={[
              { label: 'Yes', value: 'yes' as const },
              { label: 'No', value: 'no' as const },
            ]}
            onChange={answer}
            onCancel={actions.cancel}
          />
        </Box>
      </Box>
    </PermissionDialog>
  )
}

type PlanApprovalProps = Pick<PermissionRequestProps, 'toolUseConfirm' | 'workerBadge' | 'setStickyFooter'> & {
  initialPlan: string
  actions: PlanExitActions
}

function PlanApproval({ initialPlan, actions, toolUseConfirm, workerBadge, setStickyFooter }: PlanApprovalProps) {
  const context = useAppState(state => state.toolPermissionContext)
  const showClearContext = useAppState(state => state.settings.showClearContextOnPlanAccept === true)
  const [planPath] = useState(getPlanFilePath)
  const editor = usePlanEditor(planPath, initialPlan)
  const images = usePastedImages()
  const [feedback, setFeedback] = useState('')
  const answered = useRef(false)

  const usage = toolUseConfirm.assistantMessage.message.usage
  const usedPercent = useMemo(() => getContextUsedPercent(usage, context.mode), [usage, context.mode])
  const offer: PlanOffer = {
    showClearContext,
    usedPercent,
    autoOffered: autoModeBuiltIn() && context.isAutoModeAvailable === true,
    bypassOffered: context.isBypassPermissionsModeAvailable === true,
  }
  const options = useMemo(
    () =>
      buildPlanApprovalOptions({
        showClearContext,
        usedPercent,
        isAutoModeAvailable: context.isAutoModeAvailable,
        isBypassPermissionsModeAvailable: context.isBypassPermissionsModeAvailable,
        onFeedbackChange: setFeedback,
      }),
    [showClearContext, usedPercent, context.isAutoModeAvailable, context.isBypassPermissionsModeAvailable],
  )

  const answerOnce = (answer: PlanAnswer) => {
    if (answered.current) return
    answered.current = true
    const typed = feedback.trim()
    switch (answer.kind) {
      case 'cancel':
        actions.cancel()
        return
      case 'feedback':
        void imageBlocksOf(images.pasted).then(blocks => actions.refuse(typed || IMAGE_ONLY_REASON, blocks))
        return
      default:
        actions.approve(answer, { plan: editor.plan, input: editor.edited ? { plan: editor.plan } : {}, feedback: typed })
    }
  }

  const onAnswer = useStableCallback((value: ResponseValue) => answerOnce(answerFor(value, offer)))
  const onCancel = useStableCallback(() => answerOnce({ kind: 'cancel' }))

  useInput((input, key) => {
    if (key.tab && key.shift) answerOnce(shortcutAnswer(offer))
    else if (key.ctrl && input === 'g') editor.openEditor()
  })

  const editorName = getExternalEditor()
  const editorHint = editorName ? `ctrl-g to edit in ${toIDEDisplayName(editorName)} · ${getDisplayPath(planPath)}` : null
  const inFooter = setStickyFooter !== undefined

  const questionProps = {
    options,
    onAnswer,
    onCancel,
    pasted: images.pasted,
    onImagePaste: images.addImage,
    onRemoveImage: images.removeImage,
    editorHint,
    savedNoteVisible: editor.savedNoteVisible,
  }

  useLayoutEffect(() => {
    setStickyFooter?.(
      <PlanFooterFrame>
        <PlanApprovalQuestion question="Would you like to proceed?" {...questionProps} />
      </PlanFooterFrame>,
    )
    // questionProps is rebuilt every render; its parts are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setStickyFooter, options, onAnswer, onCancel, images.pasted, images.addImage, images.removeImage, editorHint, editor.savedNoteVisible])
  useEffect(() => () => setStickyFooter?.(null), [setStickyFooter])

  const allowedPrompts = (toolUseConfirm.input as { allowedPrompts?: AllowedPrompt[] }).allowedPrompts ?? []

  return (
    <PermissionDialog color="planMode" title="Ready to code?" workerBadge={workerBadge}>
      <Box flexDirection="column" marginTop={1}>
        <Text>Here is Claude&apos;s plan:</Text>
        <Box flexDirection="column" borderStyle="dashed" borderColor="subtle" borderLeft={false} borderRight={false} marginY={1}>
          <Markdown>{editor.plan}</Markdown>
        </Box>
        {isClassifierPermissionsEnabled() && allowedPrompts.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Requested permissions:</Text>
            {allowedPrompts.map(({ tool, prompt }) => (
              <Text key={`${tool}:${prompt}`} dimColor>
                {'  '}· {tool}(prompt: {prompt})
              </Text>
            ))}
          </Box>
        )}
        <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="tool" />
        {!inFooter && (
          <PlanApprovalQuestion
            question="Claude has written up a plan and is ready to execute. Would you like to proceed?"
            {...questionProps}
          />
        )}
      </Box>
    </PermissionDialog>
  )
}

export function buildPlanApprovalOptions({
  showClearContext,
  usedPercent,
  isAutoModeAvailable,
  isBypassPermissionsModeAvailable,
  onFeedbackChange
}: {
  showClearContext: boolean;
  usedPercent: number | null;
  isAutoModeAvailable: boolean | undefined;
  isBypassPermissionsModeAvailable: boolean | undefined;
  onFeedbackChange: (v: string) => void;
}): OptionWithDescription<ResponseValue>[] {
  const approving = planApprovalChoices({
    showClearContext,
    usedPercent,
    // Without the build flag auto mode does not exist, whatever the context says.
    autoOffered: autoModeBuiltIn() && isAutoModeAvailable === true,
    bypassOffered: isBypassPermissionsModeAvailable === true,
  })
  return [
    ...approving,
    {
      type: 'input',
      label: 'No, keep planning',
      value: 'no',
      placeholder: 'Tell Claudin what to change',
      description: 'shift+tab to approve with this feedback',
      onChange: onFeedbackChange,
    },
  ]
}
function getContextUsedPercent(usage: {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | undefined, permissionMode: PermissionMode): number | null {
  if (!usage) return null
  const model = getRuntimeMainLoopModel({ permissionMode, mainLoopModel: getMainLoopModel() })
  const { used } = calculateContextPercentages(
    {
      input_tokens: usage.input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
    getContextWindowForModel(model, getSdkBetas()),
  )
  return used
}
