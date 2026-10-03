export type SwitchKey = 'autoMemory' | 'autoDream'

/** Either the list or one of the switches above it holds the keys. */
export type PickerFocus = 'list' | SwitchKey

/**
 * One arrow press. Up from the list lands on the switch nearest it; Up on the
 * top switch stays; Down from the bottom switch hands the keys back to the list.
 */
export function stepFocus(focus: PickerFocus, direction: 'up' | 'down', switches: readonly SwitchKey[]): PickerFocus {
  if (focus === 'list') return direction === 'up' ? (switches.at(-1) ?? 'list') : 'list'
  const at = switches.indexOf(focus)
  if (direction === 'up') return switches[Math.max(0, at - 1)] ?? 'list'
  return switches[at + 1] ?? 'list'
}
