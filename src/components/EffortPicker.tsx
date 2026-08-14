import { useState } from 'react'
import { Box, Text, useAnimationFrame, useInput } from 'src/ink.js'
import { useMainLoopModel } from 'src/hooks/useMainLoopModel.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { useAppState, useSetAppState } from 'src/state/AppState.js'
import type { Theme } from 'src/utils/theme.js'
import {
  type EffortValue,
  getAvailableEffortLevels,
  getDisplayedEffortLabel,
  getEffortValueDescription,
  isAdaptiveEffort,
  modelSupportsEffort,
  modelUsesOpenAIEffort,
} from 'src/utils/effort.js'
import { getReasoningEffortForModel } from 'src/services/api/providerConfig.js'
import { getRainbowColor } from 'src/services/context/thinking.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Byline } from './design-system/Byline.js'
import {
  fitSliderLayout,
  SLIDER_MARKER,
} from './EffortPicker.layout.js'

type SliderOption = {
  /** Effort value to apply on select. `'adaptive'` is the sentinel. */
  value: EffortValue
  /** Label drawn on the slider (lowercase, matches the wire value). */
  label: string
  description: string
}

type Props = {
  onSelect: (effort: EffortValue | undefined) => void
  onCancel?: () => void
}

const ANIMATION_INTERVAL_MS = 50
// Leave room for the picker's left padding / box chrome so the slider never
// hugs the right edge or wraps.
const SLIDER_WIDTH_MARGIN = 4

export function EffortPicker({ onSelect, onCancel }: Props) {
  const model = useMainLoopModel()
  const { columns } = useTerminalSize()
  const appStateEffort = useAppState((s: { effortValue?: EffortValue }) => s.effortValue)
  const setAppState = useSetAppState()
  const usesOpenAIEffort = modelUsesOpenAIEffort(model)
  const supportsEffort = modelSupportsEffort(model)
  const availableLevels = getAvailableEffortLevels(model)

  const options: SliderOption[] = availableLevels.map(level => {
    // OpenAI/Codex 'xhigh' is surfaced as 'max' (matches the rest of the UI),
    // but the applied value stays the raw level.
    const label = usesOpenAIEffort && level === 'xhigh' ? 'max' : level
    return {
      value: level as EffortValue,
      label,
      description: getEffortValueDescription(level as EffortValue),
    }
  })

  const [focusedIndex, setFocusedIndex] = useState(() =>
    initialFocusIndex(options, appStateEffort, usesOpenAIEffort, model),
  )

  const [animRef, time] = useAnimationFrame(
    supportsEffort ? ANIMATION_INTERVAL_MS : null,
  )
  const timeOffset = Math.floor(time / ANIMATION_INTERVAL_MS)

  useInput((_input, key) => {
    if (key.leftArrow) {
      setFocusedIndex(i => Math.max(0, i - 1))
    } else if (key.rightArrow) {
      setFocusedIndex(i => Math.min(options.length - 1, i + 1))
    } else if (key.return) {
      const selected = options[focusedIndex]
      if (!selected) return
      setAppState(prev => ({ ...prev, effortValue: selected.value }))
      onSelect(selected.value)
    } else if (key.escape) {
      onCancel?.()
    }
  })

  const focused = options[focusedIndex]
  const labels = options.map(o => o.label)
  const layout = fitSliderLayout(
    labels,
    focusedIndex,
    Math.max(1, columns - SLIDER_WIDTH_MARGIN),
  )

  return (
    <Box ref={animRef} flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold={true}>Effort</Text>
        {!supportsEffort && (
          <Text dimColor={true}>Effort not supported for this model</Text>
        )}
      </Box>

      {supportsEffort && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor={true}>{layout.headerLine}</Text>
          <RuleLine
            ruleLine={layout.ruleLine}
            markerColumn={layout.markerColumn}
          />
          <LabelsLine
            options={options}
            focusedIndex={focusedIndex}
            timeOffset={timeOffset}
            gap={layout.gap}
          />
        </Box>
      )}

      {focused && (
        <Box marginBottom={1}>
          <Text dimColor={true}>{focused.description}</Text>
        </Box>
      )}

      <Box>
        <Text dimColor={true} italic={true}>
          <Byline>
            <KeyboardShortcutHint shortcut="←/→" action="adjust" />
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <KeyboardShortcutHint shortcut="Esc" action="cancel" />
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}

function RuleLine({
  ruleLine,
  markerColumn,
}: {
  ruleLine: string
  markerColumn: number
}) {
  const before = ruleLine.slice(0, markerColumn)
  const after = ruleLine.slice(markerColumn + 1)
  return (
    <Text>
      <Text dimColor={true}>{before}</Text>
      <Text color="remember" bold={true}>{SLIDER_MARKER}</Text>
      <Text dimColor={true}>{after}</Text>
    </Text>
  )
}

// Color only ever shows on the FOCUSED label — un-focused levels stay neutral
// and dim so the cursor's position is the single source of color. Each level
// has its own focused identity: the "smartness" tiers (max/xhigh) sweep a live
// rainbow, the faster tiers get distinct solids (medium = selection color, low
// = fast-mode orange), and adaptive runs a white light-sweep.
//
// `shimmer` picks the lighter `rainbow_*_shimmer` palette and `speed` scales how
// fast the rainbow sweeps, so xhigh reads as a softer, slower "lesser" rainbow
// than max — it's literally a notch below in capability. Do NOT use Ink
// `dimColor` here: faint (SGR 2) + bold (SGR 1) cancel out in Ghostty and wash
// the custom RGB to near-white (see team memory ghostty glyph/render quirks) —
// the shimmer palette is the correct way to get a lighter tone without losing
// the hue.
const FOCUSED_RAINBOW: Record<string, { shimmer: boolean; bold: boolean; speed: number }> = {
  max: { shimmer: false, bold: true, speed: 1 },
  xhigh: { shimmer: true, bold: false, speed: 0.5 },
}
const FOCUSED_SOLID: Record<string, keyof Theme> = {
  high: 'text',
  medium: 'remember',
  low: 'fastMode',
}

function LabelsLine({
  options,
  focusedIndex,
  timeOffset,
  gap,
}: {
  options: SliderOption[]
  focusedIndex: number
  timeOffset: number
  gap: number
}) {
  const gapSpaces = ' '.repeat(gap)
  return (
    <Text>
      {options.map((opt, posIndex) => {
        const isFocused = posIndex === focusedIndex
        return (
          <Text key={opt.label + posIndex}>
            {posIndex > 0 && gapSpaces}
            {isFocused
              ? renderFocusedLabel(opt, timeOffset)
              : <Text color="subtle" dimColor={true}>{opt.label}</Text>}
          </Text>
        )
      })}
    </Text>
  )
}

function renderFocusedLabel(opt: SliderOption, timeOffset: number) {
  const key = String(opt.value)
  const rainbow = FOCUSED_RAINBOW[key]
  if (rainbow) {
    const sweep = Math.floor(timeOffset * rainbow.speed)
    return [...opt.label].map((char, charIndex) => (
      <Text
        key={charIndex}
        bold={rainbow.bold}
        color={getRainbowColor(charIndex + sweep, rainbow.shimmer)}
      >
        {char}
      </Text>
    ))
  }
  return (
    <Text color={FOCUSED_SOLID[key] ?? 'text'} bold={true}>
      {opt.label}
    </Text>
  )
}

/**
 * Focus the saved effort when set; otherwise (never configured, or legacy
 * 'adaptive' value) focus the model's default level, falling back to the
 * leftmost option. Opening the picker never mutates state — the value only
 * changes on Enter.
 */
function initialFocusIndex(
  options: SliderOption[],
  appStateEffort: EffortValue | undefined,
  usesOpenAIEffort: boolean,
  model: string,
): number {
  if (appStateEffort === undefined || isAdaptiveEffort(appStateEffort)) {
    // OpenAI/Codex: focus the model's default reasoning effort if any.
    if (usesOpenAIEffort) {
      const reasoning = getReasoningEffortForModel(model)
      if (reasoning) {
        const idx = options.findIndex(o => o.value === reasoning)
        if (idx >= 0) return idx
      }
    }
    return 0
  }
  const label = getDisplayedEffortLabel(model, appStateEffort)
  const idx = options.findIndex(o => o.value === label || o.label === label)
  return idx >= 0 ? idx : 0
}
