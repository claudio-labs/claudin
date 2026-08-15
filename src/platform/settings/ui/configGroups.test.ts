import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  buildDisplayRows,
  countSettingRows,
  firstSelectableIndex,
  groupedSettingIds,
  lastSelectableIndex,
  nextSelectableIndex,
  SETTING_GROUPS,
  sectionJumpIndex,
  type DisplayRow,
} from 'src/platform/settings/ui/configGroups.js'

type FakeSetting = { id: string }

const s = (id: string): FakeSetting => ({ id })

/** Compact shape for assertions: 'H:label' | '-' | id */
function sketch(rows: DisplayRow<FakeSetting>[]): string[] {
  return rows.map(row => {
    switch (row.kind) {
      case 'header':
        return `H:${row.label}`
      case 'spacer':
        return '-'
      case 'setting':
        return row.item.id
    }
  })
}

describe('buildDisplayRows — grouping', () => {
  test('orders by group, not by input order', () => {
    const rows = buildDisplayRows([s('theme'), s('model'), s('respectGitignore')])
    expect(sketch(rows)).toEqual([
      'H:Model & thinking',
      'model',
      '-',
      'H:Tools & permissions',
      'respectGitignore',
      '-',
      'H:Interface',
      'theme',
    ])
  })

  test('drops the header of a group whose settings are all hidden', () => {
    const rows = buildDisplayRows([s('model'), s('notifChannel')])
    expect(sketch(rows).filter(r => r.startsWith('H:'))).toEqual([
      'H:Model & thinking',
      'H:Notifications',
    ])
  })

  test('never emits a leading spacer, and one spacer between sections', () => {
    const rows = buildDisplayRows([s('model'), s('theme'), s('notifChannel')])
    expect(rows[0]?.kind).toBe('header')
    expect(rows.filter(r => r.kind === 'spacer')).toHaveLength(2)
  })

  test('an unmapped id lands in a trailing Other section instead of vanishing', () => {
    const rows = buildDisplayRows([s('brandNewSetting'), s('model')])
    expect(sketch(rows)).toEqual([
      'H:Model & thinking',
      'model',
      '-',
      'H:Other',
      'brandNewSetting',
    ])
  })

  test('keeps duplicate ids (autoUpdatesChannel has two mutually exclusive rows)', () => {
    const rows = buildDisplayRows([s('autoUpdatesChannel'), s('autoUpdatesChannel')])
    expect(sketch(rows)).toEqual([
      'H:Updates & account',
      'autoUpdatesChannel',
      'autoUpdatesChannel',
    ])
  })

  test('grouped: false is the flat search path — input order, no headers', () => {
    const rows = buildDisplayRows([s('theme'), s('model')], { grouped: false })
    expect(sketch(rows)).toEqual(['theme', 'model'])
  })

  test('every row is height 1 so the slice stays an honest height budget', () => {
    const rows = buildDisplayRows([s('model'), s('theme')])
    expect(countSettingRows(rows)).toBe(2)
    expect(rows).toHaveLength(5) // 2 headers + 1 spacer + 2 settings
  })
})

describe('navigation over non-selectable rows', () => {
  const rows = buildDisplayRows([s('model'), s('thinkingEnabled'), s('theme')])
  // H:Model, model, thinkingEnabled, -, H:Interface, theme
  const firstIdx = firstSelectableIndex(rows)
  const lastIdx = lastSelectableIndex(rows)

  test('first/last selectable skip header and spacer rows', () => {
    expect(firstIdx).toBe(1)
    expect(lastIdx).toBe(rows.length - 1)
  })

  test('stepping down jumps over the spacer and the next header', () => {
    expect(nextSelectableIndex(rows, 2, 1)).toBe(lastIdx)
  })

  test('stepping up jumps back over them too', () => {
    expect(nextSelectableIndex(rows, lastIdx, -1)).toBe(2)
  })

  test('clamps at both ends instead of landing on chrome', () => {
    expect(nextSelectableIndex(rows, lastIdx, 1)).toBe(lastIdx)
    expect(nextSelectableIndex(rows, firstIdx, -1)).toBe(firstIdx)
  })

  test('a cursor sitting on a header snaps forward to a real setting', () => {
    expect(nextSelectableIndex(rows, 0, 1)).toBe(1)
    expect(nextSelectableIndex(rows, 0, -1)).toBe(1)
  })

  test('an empty list yields no selectable index', () => {
    const empty = buildDisplayRows<FakeSetting>([])
    expect(firstSelectableIndex(empty)).toBe(-1)
    expect(lastSelectableIndex(empty)).toBe(-1)
  })
})

describe('sectionJumpIndex — PgUp/PgDn', () => {
  const rows = buildDisplayRows([
    s('model'),
    s('thinkingEnabled'),
    s('theme'),
    s('verbose'),
    s('notifChannel'),
  ])
  // 0 H:Model, 1 model, 2 thinkingEnabled, 3 -, 4 H:Interface, 5 theme,
  // 6 verbose, 7 -, 8 H:Notifications, 9 notifChannel
  test('down goes to the first setting of the next section', () => {
    expect(sectionJumpIndex(rows, 1, 1)).toBe(5)
    expect(sectionJumpIndex(rows, 6, 1)).toBe(9)
  })

  test('up goes to the first setting of the previous section', () => {
    expect(sectionJumpIndex(rows, 6, -1)).toBe(1)
    expect(sectionJumpIndex(rows, 9, -1)).toBe(5)
  })

  test('clamps to the first/last setting at the ends', () => {
    expect(sectionJumpIndex(rows, 9, 1)).toBe(9)
    expect(sectionJumpIndex(rows, 1, -1)).toBe(1)
  })

  test('with no headers (search results) it degrades to first/last', () => {
    const flat = buildDisplayRows([s('model'), s('theme')], { grouped: false })
    expect(sectionJumpIndex(flat, 0, 1)).toBe(1)
    expect(sectionJumpIndex(flat, 1, -1)).toBe(0)
  })
})

describe('group map stays in sync with Config.tsx', () => {
  const SETTING_ID_RE = /^\s*id: '([^']+)',$/gm

  test('every setting rendered by Config.tsx has a group', () => {
    const source = readFileSync(join(import.meta.dir, 'Config.tsx'), 'utf8')
    const ids = [...source.matchAll(SETTING_ID_RE)].map(m => m[1]!)
    // Guard the regex itself: if Config.tsx's formatting changes so no ids are
    // found, this test must fail loudly rather than pass on an empty set.
    expect(ids.length).toBeGreaterThan(40)
    const mapped = groupedSettingIds()
    const unmapped = [...new Set(ids)].filter(id => !mapped.has(id))
    expect(unmapped).toEqual([])
  })

  test('no id is claimed by two groups', () => {
    const all = SETTING_GROUPS.flatMap(group => [...group.settingIds])
    expect(all).toHaveLength(new Set(all).size)
  })
})
