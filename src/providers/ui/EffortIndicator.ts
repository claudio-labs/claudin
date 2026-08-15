import {
  EFFORT_ADAPTIVE,
  EFFORT_HIGH,
  EFFORT_LOW,
  EFFORT_MAX,
  EFFORT_MEDIUM,
  EFFORT_XHIGH,
} from 'src/constants/figures.js'
import {
  type AdaptiveEffort,
  type EffortLevel,
  type EffortValue,
  getDisplayedEffortLabel,
  isAdaptiveEffort,
  modelSupportsEffort,
} from 'src/utils/effort.js'
import { buildEffortPill } from 'src/vcs/git/format-branch.js'
import type { Theme } from 'src/terminal/theme/theme.js'


/**
 * Resolve the traffic-light pill background for an effort level so higher
 * thinking levels read hotter (gray → amber → red), adaptive in blue.
 */
function effortLevelToBg(level: EffortLevel | AdaptiveEffort, theme: Theme): string {
  if (isAdaptiveEffort(level)) {
    return theme.suggestion
  }
  switch (level) {
    case 'low':
      return theme.inactive
    case 'medium':
      return theme.warning
    case 'high':
      return theme.claude
    case 'xhigh':
      return theme.error
    case 'max':
      return theme.merged
    default:
      // Defensive: unknown remote value renders as the high (red) bg.
      return theme.error
  }
}

/**
 * Build the Powerline effort pill (e.g. `● high`) with a per-level traffic-light
 * background. Returns the rendered `pill` string plus its `bg` color (so a
 * preceding pill can join its trailing arrow into it seamlessly), or undefined
 * if the model doesn't support effort.
 */
export function getEffortPill(
  effortValue: EffortValue | undefined,
  model: string,
  theme: Theme,
): { pill: string; bg: string } | undefined {
  if (!modelSupportsEffort(model)) return undefined
  const level = getDisplayedEffortLabel(model, effortValue)
  const bg = effortLevelToBg(level, theme)
  return { pill: buildEffortPill(`${effortLevelToSymbol(level)} ${level}`, bg, theme), bg }
}

export function effortLevelToSymbol(level: EffortLevel | AdaptiveEffort): string {
  if (isAdaptiveEffort(level)) {
    return EFFORT_ADAPTIVE
  }
  switch (level) {
    case 'low':
      return EFFORT_LOW
    case 'medium':
      return EFFORT_MEDIUM
    case 'high':
      return EFFORT_HIGH
    case 'xhigh':
      return EFFORT_XHIGH
    case 'max':
      return EFFORT_MAX
    default:
      // Defensive: level can originate from remote config. If an unknown
      // value slips through, render the high symbol rather than undefined.
      return EFFORT_HIGH
  }
}
