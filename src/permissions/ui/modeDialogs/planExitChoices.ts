/**
 * The answers "Ready to code?" offers, as data. No React and no build-flag
 * reads: whether auto and bypass are on offer comes in from the caller.
 */

/** How far an approval opens the session up once the plan is accepted. */
type Elevation = 'auto' | 'bypass' | 'edits'

/** One answer to the plan-exit dialog. */
export type PlanAnswer =
  | { kind: 'keep'; elevation: Elevation }
  | { kind: 'clear'; elevation: Elevation }
  | { kind: 'manual' }
  | { kind: 'feedback' }
  | { kind: 'cancel' }
  /** The "Yes" of the short dialog an empty plan gets. */
  | { kind: 'plainExit' }

/**
 * The wire values of the answers. Callers and tests read these, so they
 * outlive the union above. The keep-context slot has one value for both its
 * bypass and its edits label; which one it means depends on what is offered.
 */
export type ResponseValue =
  | 'yes-auto-clear-context'
  | 'yes-bypass-permissions'
  | 'yes-accept-edits'
  | 'yes-resume-auto-mode'
  | 'yes-accept-edits-keep-context'
  | 'yes-default-keep-context'
  | 'no'

export type PlanOffer = {
  showClearContext: boolean
  usedPercent: number | null
  autoOffered: boolean
  bypassOffered: boolean
}

export type PlanChoice = { label: string; value: ResponseValue }

/** Auto outranks bypass, and bypass outranks plain edit acceptance. */
function strongestElevation(offer: PlanOffer): Elevation {
  if (offer.autoOffered) return 'auto'
  if (offer.bypassOffered) return 'bypass'
  return 'edits'
}

const CLEAR_SUFFIX: Record<Elevation, string> = {
  auto: 'use auto mode',
  bypass: 'bypass permissions',
  edits: 'auto-accept edits',
}

const CLEAR_VALUE: Record<Elevation, ResponseValue> = {
  auto: 'yes-auto-clear-context',
  bypass: 'yes-bypass-permissions',
  edits: 'yes-accept-edits',
}

const KEEP_LABEL: Record<Elevation, string> = {
  auto: 'Yes, and use auto mode',
  bypass: 'Yes, and bypass permissions',
  edits: 'Yes, auto-accept edits',
}

function clearChoice(offer: PlanOffer): PlanChoice {
  const elevation = strongestElevation(offer)
  const usage = offer.usedPercent === null ? '' : ` (${offer.usedPercent}% used)`
  return { label: `Yes, clear context${usage} and ${CLEAR_SUFFIX[elevation]}`, value: CLEAR_VALUE[elevation] }
}

function keepChoice(offer: PlanOffer): PlanChoice {
  const elevation = strongestElevation(offer)
  return {
    label: KEEP_LABEL[elevation],
    value: elevation === 'auto' ? 'yes-resume-auto-mode' : 'yes-accept-edits-keep-context',
  }
}

/** The approving answers, in screen order. The feedback field comes after them. */
export function planApprovalChoices(offer: PlanOffer): PlanChoice[] {
  const choices: PlanChoice[] = []
  if (offer.showClearContext) choices.push(clearChoice(offer))
  choices.push(keepChoice(offer), { label: 'Yes, manually approve edits', value: 'yes-default-keep-context' })
  return choices
}

/** Turns a chosen value back into the answer it stands for. */
export function answerFor(value: ResponseValue, offer: Pick<PlanOffer, 'bypassOffered'>): PlanAnswer {
  switch (value) {
    case 'yes-auto-clear-context':
      return { kind: 'clear', elevation: 'auto' }
    case 'yes-bypass-permissions':
      return { kind: 'clear', elevation: 'bypass' }
    case 'yes-accept-edits':
      return { kind: 'clear', elevation: 'edits' }
    case 'yes-resume-auto-mode':
      return { kind: 'keep', elevation: 'auto' }
    case 'yes-accept-edits-keep-context':
      return { kind: 'keep', elevation: offer.bypassOffered ? 'bypass' : 'edits' }
    case 'yes-default-keep-context':
      return { kind: 'manual' }
    case 'no':
      return { kind: 'feedback' }
  }
}

/**
 * The shift+tab shortcut. With clear-context on it always clears into
 * accept-edits; otherwise it is the keep-context answer, which means bypass
 * whenever bypass is offered (finding 4, kept), and never auto.
 */
export function shortcutAnswer(offer: Pick<PlanOffer, 'showClearContext' | 'bypassOffered'>): PlanAnswer {
  if (offer.showClearContext) return { kind: 'clear', elevation: 'edits' }
  return { kind: 'keep', elevation: offer.bypassOffered ? 'bypass' : 'edits' }
}
