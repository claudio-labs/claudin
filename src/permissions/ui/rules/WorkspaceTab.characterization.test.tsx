/**
 * Characterization of the Workspace tab of /permissions, written before the
 * clean-base rewrite of permissions/ruleEditors. The spec is
 * docs/tech/rewrite/permissions/ruleEditors.md.
 *
 * The tab lists the working directories and hands every choice to its
 * caller, which opens the add or remove dialog. It is mounted inside a real
 * `Tabs`, the way /permissions shows it, so the header focus it reports is
 * the one the tab row really has.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { isolatedWorld, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { WorkspaceTab } from 'src/permissions/ui/rules/WorkspaceTab.js'
import { Tab, Tabs } from 'src/terminal/design-system/Tabs.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'

const world = isolatedWorld()
const { enter, esc, down, up } = KEYS

type Report =
  | { to: 'exit'; args: unknown[] }
  | { to: 'add' }
  | { to: 'remove'; path: string }
  | { to: 'header'; focused: boolean }

const contextWith = (directories: string[]): ToolPermissionContext => ({
  ...getEmptyToolPermissionContext(),
  additionalWorkingDirectories: new Map(directories.map(path => [path, { path, source: 'localSettings' as const }])),
})

async function open(directories: string[], options: { inTabs?: boolean; reportFocus?: boolean } = {}) {
  const reports: Report[] = []
  const tab = (
    <WorkspaceTab
      toolPermissionContext={contextWith(directories)}
      onExit={(...args) => reports.push({ to: 'exit', args })}
      onRequestAddDirectory={() => reports.push({ to: 'add' })}
      onRequestRemoveDirectory={path => reports.push({ to: 'remove', path })}
      onHeaderFocusChange={options.reportFocus === false ? undefined : focused => reports.push({ to: 'header', focused })}
    />
  )
  const node = options.inTabs ? (
    <Tabs title="Permissions:" defaultTab="workspace">
      <Tab id="rules" title="Rules">
        <></>
      </Tab>
      <Tab id="workspace" title="Workspace">
        {tab}
      </Tab>
    </Tabs>
  ) : (
    tab
  )
  const screen = await mount(node, { ready: frame => frame.includes('1. ') })
  return { screen, reports }
}

const rows = (frame: string) =>
  frame
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')

/** The reports that are not about the header focus. */
const choices = (reports: Report[]) => reports.filter(report => report.to !== 'header')

describe('WorkspaceTab: what it lists', () => {
  test(
    'the original working directory as a plain line, then each added directory in order, then "Add directory…"',
    async () => {
      const { screen } = await open(['/srv/zeta', '/srv/alpha'])
      expect(rows(screen.text())).toEqual([
        `  -  ${world().project} (Original working directory)`,
        '❯ 1. /srv/zeta',
        '  2. /srv/alpha',
        '  3. Add directory…',
      ])
    },
    SLOW,
  )

  test(
    'with no added directory, only "Add directory…" can be chosen',
    async () => {
      const { screen, reports } = await open([])
      expect(rows(screen.text()).slice(1)).toEqual(['❯ 1. Add directory…'])
      await screen.press(enter)
      expect(choices(reports)).toEqual([{ to: 'add' }])
    },
    SLOW,
  )

  test(
    'at most ten rows show at once; the rest scroll into view',
    async () => {
      const many = Array.from({ length: 12 }, (_, at) => `/srv/d${String(at).padStart(2, '0')}`)
      const { screen } = await open(many)
      const listed = rows(screen.text()).filter(row => /\d+\. /.test(row))
      expect(listed).toHaveLength(10)
      expect(listed[0]).toContain('1.  /srv/d00')
      expect(listed[9]).toContain('10. /srv/d09')
      expect(screen.text()).not.toContain('Add directory…')
      await screen.press(...Array<string>(12).fill(down))
      await screen.until(frame => frame.includes('❯ 13. Add directory…'), 'the last row')
      expect(rows(screen.text()).filter(row => /\d+\. /.test(row))).toHaveLength(10)
    },
    SLOW,
  )
})

describe('WorkspaceTab: what a choice reports', () => {
  const table: Array<[string, string[], Report[]]> = [
    ['Enter on an added directory asks to remove it', [enter], [{ to: 'remove', path: '/srv/one' }]],
    ['Enter on the second asks to remove that one', [down, enter], [{ to: 'remove', path: '/srv/two' }]],
    ['Enter on "Add directory…" asks to add one', [down, down, enter], [{ to: 'add' }]],
    ['Esc leaves the dialog with a system note', [esc], [{ to: 'exit', args: ['Workspace dialog dismissed', { display: 'system' }] }]],
    ['moving the pointer reports nothing', [down, down], []],
  ]
  for (const [name, keys, expected] of table) {
    test(
      name,
      async () => {
        const { screen, reports } = await open(['/srv/one', '/srv/two'])
        await screen.press(...keys)
        expect(choices(reports) as unknown).toEqual(expected)
      },
      SLOW,
    )
  }

  test(
    'without a focus listener it still mounts and answers',
    async () => {
      const { screen, reports } = await open(['/srv/one'], { reportFocus: false })
      await screen.press(enter)
      expect(reports).toEqual([{ to: 'remove', path: '/srv/one' }])
    },
    SLOW,
  )
})

describe('WorkspaceTab inside the tabs', () => {
  test(
    'outside any tabs the content has the focus, and that is reported once on mount',
    async () => {
      const { reports } = await open(['/srv/one'])
      expect(reports).toEqual([{ to: 'header', focused: false }])
    },
    SLOW,
  )

  test(
    'the header starts focused and the list ignores Enter; down gives the list the focus',
    async () => {
      const { screen, reports } = await open(['/srv/one'], { inTabs: true })
      expect(reports).toEqual([{ to: 'header', focused: true }])
      await screen.press(enter)
      expect(choices(reports)).toEqual([])
      await screen.press(down)
      expect(reports.at(-1)).toEqual({ to: 'header', focused: false })
      await screen.press(enter)
      expect(choices(reports)).toEqual([{ to: 'remove', path: '/srv/one' }])
    },
    SLOW,
  )

  test(
    'up from the first row hands the focus back to the header, and the list stops answering',
    async () => {
      const { screen, reports } = await open(['/srv/one', '/srv/two'], { inTabs: true })
      await screen.press(down)
      await screen.press(up)
      expect(reports.map(report => (report.to === 'header' ? report.focused : report.to))).toEqual([true, false, true])
      await screen.press(enter)
      expect(choices(reports)).toEqual([])
    },
    SLOW,
  )
})
