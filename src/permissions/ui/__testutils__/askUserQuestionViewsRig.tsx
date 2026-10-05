/**
 * Rig for the permissions/askUserQuestionViews suites (the single-question
 * screen and its side-by-side preview variant).
 *
 * The views are driven the way the AskUserQuestion dialog drives them: a
 * stand-in parent keeps the per-question state the views ask it to record,
 * merging each update into what it already held, and hands it back on the
 * next render. Every callback a view makes is appended to one ordered log.
 *
 * Mounting, keys and the isolated config home come from the promptFrame rig.
 */
import * as React from 'react'
import type { QuestionState } from 'src/permissions/ui/AskUserQuestionPermissionRequest/use-multiple-choice-state.js'
import { QuestionView } from 'src/permissions/ui/AskUserQuestionPermissionRequest/QuestionView.js'
import { PreviewQuestionView } from 'src/permissions/ui/AskUserQuestionPermissionRequest/PreviewQuestionView.js'
import { mount, type Screen } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { renderToAnsiString, renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { type AppState, getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import type { Question } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js'

/** What a view told its parent, in order. */
export type Told =
  | { to: 'record'; question: string; updates: Partial<QuestionState>; multi: boolean }
  | { to: 'answer'; question: string; picked: string | string[]; typed?: string; advance?: boolean; argc: number }
  | { to: 'typing'; on: boolean }
  | { to: 'cancel' }
  | { to: 'submit' }
  | { to: 'tabPrev' }
  | { to: 'tabNext' }
  | { to: 'chat' }
  | { to: 'skipInterview' }

export type Log = Told[]

/** A question as the tool's schema shapes it, with sensible fillers. */
export function questionOf(text: string, options: Array<{ label: string; description?: string; preview?: string }>, extra: Partial<Question> = {}): Question {
  return {
    question: text,
    header: extra.header ?? text.split(' ')[0]!,
    multiSelect: extra.multiSelect ?? false,
    options: options.map(o => ({ description: '', ...o })),
    ...extra,
  } as Question
}

export type ViewSpec = {
  questions: Question[]
  index?: number
  answers?: Record<string, string>
  states?: Record<string, QuestionState>
  hideSubmitTab?: boolean
  planFilePath?: string
  minContentHeight?: number
  minContentWidth?: number
  /** Leave out the two tab callbacks, as an older caller might. */
  noTabCallbacks?: boolean
}

type Which = 'question' | 'preview'

function Parent({ spec, log, which }: { spec: ViewSpec; log: Log; which: Which }) {
  const [states, setStates] = React.useState<Record<string, QuestionState>>(spec.states ?? {})
  const index = spec.index ?? 0
  const props = {
    question: spec.questions[index]!,
    questions: spec.questions,
    currentQuestionIndex: index,
    answers: spec.answers ?? {},
    questionStates: states,
    hideSubmitTab: spec.hideSubmitTab,
    minContentHeight: spec.minContentHeight,
    minContentWidth: spec.minContentWidth,
    onUpdateQuestionState: (question: string, updates: Partial<QuestionState>, multi: boolean) => {
      log.push({ to: 'record', question, updates, multi })
      setStates(prev => ({
        ...prev,
        [question]: {
          selectedValue: updates.selectedValue ?? prev[question]?.selectedValue ?? (multi ? [] : undefined),
          textInputValue: updates.textInputValue ?? prev[question]?.textInputValue ?? '',
        },
      }))
    },
    onAnswer: (...args: [string, string | string[], string?, boolean?]) => {
      const [question, picked, typed, advance] = args
      log.push({ to: 'answer', question, picked, typed, advance, argc: args.length })
    },
    onTextInputFocus: (on: boolean) => log.push({ to: 'typing', on }),
    onCancel: () => log.push({ to: 'cancel' }),
    onTabPrev: spec.noTabCallbacks ? undefined : () => log.push({ to: 'tabPrev' }),
    onTabNext: spec.noTabCallbacks ? undefined : () => log.push({ to: 'tabNext' }),
    onRespondToClaude: () => log.push({ to: 'chat' }),
    onFinishPlanInterview: () => log.push({ to: 'skipInterview' }),
  }
  if (which === 'preview') return <PreviewQuestionView {...props} />
  return <QuestionView {...props} planFilePath={spec.planFilePath} onSubmit={() => log.push({ to: 'submit' })} />
}

/** The app state with the permission mode set, for plan-mode screens. */
export function inMode(mode: 'default' | 'plan'): Partial<AppState> {
  const base = getDefaultAppState()
  return { toolPermissionContext: { ...base.toolPermissionContext, mode } }
}

export type Shown = { screen: Screen; log: Log }

type Where = { columns?: number; mode?: 'default' | 'plan' }

/** Mounts one of the two views under a recording parent and waits for its first paint. */
export async function show(which: Which, spec: ViewSpec, where: Where = {}): Promise<Shown> {
  const log: Log = []
  const screen = await mount(<Parent spec={spec} log={log} which={which} />, {
    columns: where.columns ?? 100,
    appState: inMode(where.mode ?? 'default'),
    ready: frame => frame.includes('Esc to cancel'),
  })
  return { screen, log }
}

/** Re-renders the same parent with another spec, its recorded state kept. */
export async function respec(shown: Shown, which: Which, spec: ViewSpec): Promise<void> {
  await shown.screen.replace(<Parent spec={spec} log={shown.log} which={which} />)
}

// No key-binding provider here: the views draw the same without one, and with
// one the static renderer waits out its three-second guard on every frame.
function provided(node: React.ReactNode, mode: 'default' | 'plan', state: Partial<AppState>) {
  return <AppStateProvider initialState={{ ...getDefaultAppState(), ...inMode(mode), ...state }}>{node}</AppStateProvider>
}

/** One static frame of `node` at `columns`, under the app state, as plain text. */
export function still(node: React.ReactNode, columns: number, mode: 'default' | 'plan' = 'default', state: Partial<AppState> = {}): Promise<string> {
  return renderToString(provided(node, mode, state), columns)
}

/** The same frame with its escape codes kept. */
export function stillStyled(node: React.ReactNode, columns: number, state: Partial<AppState> = {}): Promise<string> {
  return renderToAnsiString(provided(node, 'default', state), columns)
}

/** A static frame of one of the two views, with every callback ignored. */
export function stillView(which: Which, spec: ViewSpec, columns: number, mode: 'default' | 'plan' = 'default'): Promise<string> {
  return still(<Parent spec={spec} log={[]} which={which} />, columns, mode)
}

/** The frame's lines with the right padding gone and blank lines dropped. */
export const rows = (frame: string): string[] =>
  frame
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '')
