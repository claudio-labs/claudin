/**
 * Finding 3 of permissions/decisionExplanation: the two debug-panel labels.
 * Updates with nothing to list read `Suggestions None` like every other empty
 * case, and the directories row keeps its values in the shared value column.
 */
import { describe, expect, test } from 'bun:test'
import figures from 'figures'
import * as React from 'react'
import { PermissionDecisionDebugInfo } from 'src/permissions/ui/PermissionDecisionDebugInfo.js'
import { GUTTER_LABELS, GUTTER_WIDTH } from 'src/permissions/ui/decisionDebug/Row.js'
import * as rig from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'

rig.isolatedWorld()

type Result = React.ComponentProps<typeof PermissionDecisionDebugInfo>['permissionResult']

async function rowsOf(suggestions: PermissionUpdate[]): Promise<string[]> {
  const result: Result = { behavior: 'ask', message: 'm', decisionReason: { type: 'other', reason: 'r' }, suggestions }
  const screen = await rig.mount(<PermissionDecisionDebugInfo permissionResult={result} />, { columns: 120 })
  await Bun.sleep(50)
  return rig.linesOf(screen.text()).filter(line => line !== '')
}

/** The column where a row's value starts, counted from zero. */
const valueColumn = (rows: string[], label: string) => {
  const row = rows.find(line => line.trimStart().startsWith(`${label} `))
  if (!row) throw new Error(`no ${label} row in:\n${rows.join('\n')}`)
  return row.indexOf(label) + label.length + 1
}

describe('finding 3: the debug panel labels', () => {
  const unlistable: Array<[string, PermissionUpdate[]]> = [
    ['removeRules', [{ type: 'removeRules', destination: 'userSettings', behavior: 'deny', rules: [{ toolName: 'Bash' }] }]],
    ['replaceRules', [{ type: 'replaceRules', destination: 'userSettings', behavior: 'allow', rules: [] }]],
    ['removeDirectories', [{ type: 'removeDirectories', destination: 'session', directories: ['/x'] }]],
    ['an addRules update with no rules', [{ type: 'addRules', destination: 'session', behavior: 'allow', rules: [] }]],
  ]
  for (const [label, suggestions] of unlistable) {
    test(`${label} reads "Suggestions None", plural and alone`, async () => {
      const rows = await rowsOf(suggestions)
      expect(rows.slice(3)).toEqual(['Suggestions None'])
    }, rig.SLOW)
  }

  test('directory values start in the same column as every other value', async () => {
    const rows = await rowsOf([
      { type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 'Read' }] },
      { type: 'addDirectories', destination: 'session', directories: ['/srv/data', '/opt/tools'] },
      { type: 'setMode', destination: 'session', mode: 'plan' },
    ])
    for (const label of ['Behavior', 'Message', 'Reason', 'Rules', 'Dirs', 'Mode']) {
      expect(valueColumn(rows, label)).toBe(GUTTER_WIDTH)
    }
    const continued = rows.find(line => line.includes('/opt/tools'))!
    expect(continued.indexOf(figures.bullet)).toBe(GUTTER_WIDTH)
  }, rig.SLOW)

  test('every gutter label leaves room for the space before its value', () => {
    for (const label of GUTTER_LABELS) expect(label.length).toBeLessThan(GUTTER_WIDTH)
  })
})
