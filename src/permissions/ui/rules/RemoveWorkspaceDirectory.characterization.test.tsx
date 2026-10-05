/**
 * Characterization of the "remove a directory from the workspace?" question
 * of /permissions, written before the clean-base rewrite of
 * permissions/ruleEditors. The spec is docs/tech/rewrite/permissions/ruleEditors.md.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { isolatedWorld, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { RemoveWorkspaceDirectory } from 'src/permissions/ui/rules/RemoveWorkspaceDirectory.js'
import type { WorkingDirectorySource } from 'src/permissions/PermissionUpdate.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'

isolatedWorld()
const { enter, esc, down, up } = KEYS

type Report = { to: 'context'; context: ToolPermissionContext } | { to: 'removed' } | { to: 'cancel' }

const DIRECTORIES: Array<[string, WorkingDirectorySource]> = [
  ['/srv/alpha', 'session'],
  ['/srv/beta', 'localSettings'],
  ['/srv/gamma', 'userSettings'],
]

function startingContext(): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    mode: 'plan',
    alwaysAllowRules: { localSettings: ['Read'] },
    additionalWorkingDirectories: new Map(DIRECTORIES.map(([path, source]) => [path, { path, source }])),
  }
}

async function open(directoryPath: string, permissionContext = startingContext()) {
  const reports: Report[] = []
  const screen = await mount(
    <RemoveWorkspaceDirectory
      directoryPath={directoryPath}
      permissionContext={permissionContext}
      setPermissionContext={context => reports.push({ to: 'context', context })}
      onRemove={() => reports.push({ to: 'removed' })}
      onCancel={() => reports.push({ to: 'cancel' })}
    />,
    { ready: frame => frame.includes('Esc to cancel') },
  )
  return { screen, reports }
}

describe('RemoveWorkspaceDirectory', () => {
  test(
    'asks about the path, says what removing it means, and offers Yes then No',
    async () => {
      const { screen } = await open('/srv/beta')
      const lines = screen
        .text()
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
      expect(lines).toEqual([
        '─'.repeat(80),
        'Remove directory from workspace?',
        '/srv/beta',
        'Claudin will no longer have access to files in this directory.',
        '❯ 1. Yes',
        '2. No',
        'Enter to confirm · Esc to cancel',
      ])
    },
    SLOW,
  )

  for (const [path] of DIRECTORIES) {
    test(
      `Yes on ${path}: a context without that directory, everything else kept, then the removal is reported`,
      async () => {
        const before = startingContext()
        const { screen, reports } = await open(path, before)
        await screen.press(enter)
        const kept = new Map([...before.additionalWorkingDirectories].filter(([key]) => key !== path))
        expect(reports).toEqual([{ to: 'context', context: { ...before, additionalWorkingDirectories: kept } }, { to: 'removed' }])
        expect([...before.additionalWorkingDirectories.keys()]).toEqual(DIRECTORIES.map(([dir]) => dir))
      },
      SLOW,
    )
  }

  test(
    'Yes on a path that is not in the workspace: the context comes back with the same directories',
    async () => {
      const before = startingContext()
      const { screen, reports } = await open('/srv/unknown', before)
      await screen.press(enter)
      expect(reports).toEqual([{ to: 'context', context: before }, { to: 'removed' }])
    },
    SLOW,
  )

  const refusals: Array<[string, string[]]> = [
    ['No', [down, enter]],
    ['Esc', [esc]],
    ['Esc with the pointer on Yes', [down, up, esc]],
  ]
  for (const [name, keys] of refusals) {
    test(
      `${name}: only the cancel is reported`,
      async () => {
        const { screen, reports } = await open('/srv/alpha')
        await screen.press(...keys)
        expect(reports).toEqual([{ to: 'cancel' }])
      },
      SLOW,
    )
  }

  test(
    'moving the pointer reports nothing',
    async () => {
      const { screen, reports } = await open('/srv/alpha')
      await screen.press(down, up, down)
      expect(reports).toEqual([])
    },
    SLOW,
  )
})
