// Section grouping for the /config panel's settings list.
//
// The settings array in Config.tsx is built in historical order (whatever order
// each setting was added), which makes the flat list impossible to browse. This
// module owns the *display* order and the section headers, so Config.tsx keeps
// its array untouched: the source of truth for order is SETTING_GROUPS below.
//
// Rows are all height 1 (a header's blank separator is its own 'spacer' row) so
// that Config.tsx's slice(scrollOffset, scrollOffset + maxVisible) stays an
// honest height budget for the pane.

export type SettingGroup = {
  id: string
  label: string
  settingIds: readonly string[]
}

export type DisplayRow<T> =
  | { kind: 'header'; id: string; label: string }
  | { kind: 'spacer'; id: string }
  | { kind: 'setting'; id: string; item: T }

/** Display order of the /config list: groups top-to-bottom, ids within a group. */
export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: 'model',
    label: 'Model & thinking',
    settingIds: [
      'model',
      'thinkingEnabled',
      'fastMode',
      'outputStyle',
      'language',
      'autoCompactEnabled',
    ],
  },
  {
    id: 'agents',
    label: 'Agents & workflows',
    settingIds: [
      'autoBackgroundAgentsEnabled',
      'workflowsDefaultBackground',
      'teammateMode',
      'teammateDefaultModel',
    ],
  },
  {
    id: 'tools',
    label: 'Tools & permissions',
    settingIds: [
      'defaultPermissionMode',
      'useAutoModeDuringPlan',
      'bashOutputFilterEnabled',
      'bashOutputFilterCapEnabled',
      'toolResultSummarizerEnabled',
      'repeatedFailureHintEnabled',
      'fileCheckpointingEnabled',
      'respectGitignore',
    ],
  },
  {
    id: 'interface',
    label: 'Interface',
    settingIds: [
      'theme',
      'defaultView',
      'verbose',
      'showTurnDuration',
      'collapseFileWritesEnabled',
      'showCacheStats',
      'spinnerTipsEnabled',
      'prefersReducedMotion',
      'prStatusFooterEnabled',
      'promptSuggestionEnabled',
      'editorMode',
      'inlineImagesMode',
    ],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    settingIds: [
      'terminalRenderer',
      'frameRate',
      'terminalProgressBarEnabled',
      'showStatusInTerminalTab',
      'copyOnSelect',
      'copyFullResponse',
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    settingIds: [
      'notifChannel',
      'taskCompleteNotifEnabled',
      'inputNeededNotifEnabled',
      'agentPushNotifEnabled',
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    settingIds: [
      'diffTool',
      'autoConnectIde',
      'autoInstallIdeExtension',
      'remoteControlAtStartup',
    ],
  },
  {
    id: 'context',
    label: 'Context & privacy',
    settingIds: [
      'thinkingHistoryRedactionEnabled',
      'narrationHistoryRedactionEnabled',
      'showExternalIncludesDialog',
    ],
  },
  {
    id: 'updates',
    label: 'Updates & account',
    settingIds: ['autoUpdatesChannel', 'apiKey'],
  },
]

/** Catch-all for a setting added to Config.tsx but not mapped above. */
const FALLBACK_GROUP: SettingGroup = {
  id: 'other',
  label: 'Other',
  settingIds: [],
}

/** Every setting id that has an explicit group. */
export function groupedSettingIds(): Set<string> {
  return new Set(SETTING_GROUPS.flatMap(group => [...group.settingIds]))
}

/**
 * Turn the (already filtered) settings into renderable rows.
 *
 * `grouped: false` keeps the incoming order and emits nothing but setting rows
 * — that's the search path, where headers would break up match order.
 * Unmapped ids land in a trailing "Other" section rather than disappearing.
 */
export function buildDisplayRows<T extends { id: string }>(
  items: readonly T[],
  { grouped = true }: { grouped?: boolean } = {},
): DisplayRow<T>[] {
  if (!grouped) {
    return items.map(item => ({ kind: 'setting', id: item.id, item }))
  }
  const remaining = new Map<string, T[]>()
  for (const item of items) {
    const bucket = remaining.get(item.id)
    if (bucket) {
      bucket.push(item)
    } else {
      remaining.set(item.id, [item])
    }
  }
  const rows: DisplayRow<T>[] = []
  const pushSection = (group: SettingGroup, sectionItems: T[]): void => {
    if (sectionItems.length === 0) return
    if (rows.length > 0) rows.push({ kind: 'spacer', id: `spacer:${group.id}` })
    rows.push({ kind: 'header', id: `header:${group.id}`, label: group.label })
    for (const item of sectionItems) {
      rows.push({ kind: 'setting', id: item.id, item })
    }
  }
  for (const group of SETTING_GROUPS) {
    const sectionItems: T[] = []
    for (const id of group.settingIds) {
      const bucket = remaining.get(id)
      if (!bucket) continue
      sectionItems.push(...bucket)
      remaining.delete(id)
    }
    pushSection(group, sectionItems)
  }
  // Anything left is unmapped — keep it visible in source order.
  pushSection(FALLBACK_GROUP, [...remaining.values()].flat())
  return rows
}

export function isSelectableRow<T>(
  row: DisplayRow<T> | undefined,
): row is { kind: 'setting'; id: string; item: T } {
  return row?.kind === 'setting'
}

/** First navigable row, or -1 when the list has none. */
export function firstSelectableIndex<T>(rows: readonly DisplayRow<T>[]): number {
  return rows.findIndex(row => isSelectableRow(row))
}

/** Last navigable row, or -1 when the list has none. */
export function lastSelectableIndex<T>(rows: readonly DisplayRow<T>[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isSelectableRow(rows[i])) return i
  }
  return -1
}

/**
 * Step from `from` in `delta` direction, skipping headers/spacers. Clamps:
 * with no selectable row further in that direction the current index is kept
 * (or the first selectable one, when `from` itself isn't selectable).
 */
export function nextSelectableIndex<T>(
  rows: readonly DisplayRow<T>[],
  from: number,
  delta: 1 | -1,
): number {
  for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
    if (isSelectableRow(rows[i])) return i
  }
  return isSelectableRow(rows[from]) ? from : firstSelectableIndex(rows)
}

/**
 * PgUp/PgDn: first setting of the previous/next section. Clamps to the first /
 * last setting at the ends, and degrades to first/last when there are no
 * headers at all (the search path).
 */
export function sectionJumpIndex<T>(
  rows: readonly DisplayRow<T>[],
  from: number,
  delta: 1 | -1,
): number {
  if (delta === 1) {
    for (let i = from + 1; i < rows.length; i++) {
      if (rows[i]?.kind === 'header') return nextSelectableIndex(rows, i, 1)
    }
    return lastSelectableIndex(rows)
  }
  // Walk back past the current section's header, then to the previous one.
  let currentHeader = -1
  for (let i = from - 1; i >= 0; i--) {
    if (rows[i]?.kind === 'header') {
      currentHeader = i
      break
    }
  }
  for (let i = currentHeader - 1; i >= 0; i--) {
    if (rows[i]?.kind === 'header') return nextSelectableIndex(rows, i, 1)
  }
  return firstSelectableIndex(rows)
}

/** Count of setting rows outside the visible window, for the scroll hints. */
export function countSettingRows<T>(rows: readonly DisplayRow<T>[]): number {
  return rows.reduce((n, row) => (isSelectableRow(row) ? n + 1 : n), 0)
}
