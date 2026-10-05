/**
 * permissions/ruleList: the /permissions screen, `PermissionRuleList`.
 *
 * Every test opens the screen over a session that already holds rules, the
 * way the command does, and drives it with real keys. Deleting reaches the
 * real settings files of a throwaway config home and project; what a test
 * reads back is the session's rules, those files, and what the screen told
 * its caller on the way out.
 *
 * The "Recently denied" tab with denials in it only exists in the shipped
 * build; PermissionRuleList.denials.characterization.test.tsx covers it.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { isolatedWorld, KEYS, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import {
  focused,
  heldNow,
  listed,
  MOVE,
  openRules,
  plainExits,
  readSettings,
  sessionHolding,
  writeSettings,
  type FileSource,
  type Held,
  type Opened,
} from 'src/permissions/ui/__testutils__/ruleListRig.js'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'

const world = isolatedWorld()
withTruecolor()

const BOLD = (text: string) => `\u001B[1m${text}\u001B[22m`

/** From a freshly opened screen (tab row focused): into the list, onto rule `n` (1-based), open it. */
async function openNth({ screen }: Opened, n: number): Promise<string> {
  await screen.press(KEYS.down, ...Array<string>(n).fill(KEYS.down), KEYS.enter)
  return screen.until(frame => frame.includes('Delete') || frame.includes('Rule details'), 'the rule details')
}

const backAtList = ({ screen }: Opened) => screen.until(frame => frame.includes('Permissions:'), 'the rule list')

describe('the tabs and what each one lists', () => {
  test('opens on Allow with the tab row focused when nothing was denied', async () => {
    world()
    const { screen } = await openRules(sessionHolding({ allow: { userSettings: ['Read'] } }))
    const frame = screen.text()
    expect(frame).toMatch(/Permissions:\s+Recently denied\s+Allow\s+Ask\s+Deny\s+Workspace/)
    expect(frame).toContain("Claudin won't ask before using allowed tools.")
    expect(frame).toContain('⌕ Search…')
    expect(listed(frame)).toEqual(['Add a new rule…', 'Read'])
    expect(focused(frame)).toBeUndefined()
    expect(frame).toContain('←/→ tab switch · ↓ return · Esc cancel')
  }, SLOW)

  const TABS: { tab: 'allow' | 'ask' | 'deny'; rights: number; subtitle: string }[] = [
    { tab: 'allow', rights: 0, subtitle: "Claudin won't ask before using allowed tools." },
    { tab: 'ask', rights: 1, subtitle: 'Claudin will always ask for confirmation before using these tools.' },
    { tab: 'deny', rights: 2, subtitle: 'Claudin will always reject requests to use denied tools.' },
  ]
  const MIXED = sessionHolding({
    allow: { userSettings: ['Read'] },
    ask: { projectSettings: ['Edit'] },
    deny: { localSettings: ['WebFetch'] },
  })
  const ONLY: Record<string, string> = { allow: 'Read', ask: 'Edit', deny: 'WebFetch' }

  for (const row of TABS) {
    test(`the ${row.tab} tab, reached with → from the tab row, lists the ${row.tab} rules only`, async () => {
      world()
      const { screen } = await openRules(MIXED)
      await screen.press(...Array<string>(row.rights).fill(MOVE.right))
      const frame = await screen.until(f => f.includes(row.subtitle), `the ${row.tab} subtitle`)
      expect(listed(frame)).toEqual(['Add a new rule…', ONLY[row.tab]!])
    }, SLOW)

    test(`initialTab '${row.tab}' opens on that tab`, async () => {
      world()
      const { screen } = await openRules(MIXED, { initialTab: row.tab })
      expect(screen.text()).toContain(row.subtitle)
      expect(listed(screen.text())).toEqual(['Add a new rule…', ONLY[row.tab]!])
    }, SLOW)
  }

  test('rules from every source share one list, sorted by their text without regard to case', async () => {
    world()
    const { screen } = await openRules(
      sessionHolding({
        allow: {
          userSettings: ['WebFetch', 'Read'],
          projectSettings: ['mcp__srv__tool'],
          localSettings: ['Glob'],
          policySettings: ['Bash(ls)'],
          session: ['Grep'],
          cliArg: ['Agent'],
        },
      }),
    )
    expect(listed(screen.text())).toEqual(['Add a new rule…', 'Agent', 'Bash(ls)', 'Glob', 'Grep', 'mcp__srv__tool', 'Read', 'WebFetch'])
  }, SLOW)

  test('texts that differ only in case count as equal and keep the order they are held in', async () => {
    world()
    const rows = (held: string[]) => openRules(sessionHolding({ allow: { userSettings: held } })).then(({ screen }) => listed(screen.text()))
    expect(await rows(['Read', 'read', 'READ'])).toEqual(['Add a new rule…', 'Read', 'read', 'READ'])
    expect(await rows(['read', 'READ', 'Read'])).toEqual(['Add a new rule…', 'read', 'READ', 'Read'])
  }, SLOW)

  test('the same rule held by two sources is listed twice', async () => {
    world()
    const { screen } = await openRules(sessionHolding({ deny: { userSettings: ['Bash(rm:*)'], projectSettings: ['Bash(rm:*)'] } }), { initialTab: 'deny' })
    expect(listed(screen.text())).toEqual(['Add a new rule…', 'Bash(rm:*)', 'Bash(rm:*)'])
  }, SLOW)

  test('an allow rule and a deny rule with the same text stay on their own tabs', async () => {
    world()
    const { screen } = await openRules(sessionHolding({ allow: { userSettings: ['Bash(git push)'] }, deny: { userSettings: ['Bash(git push)', 'Write'] } }))
    expect(listed(screen.text())).toEqual(['Add a new rule…', 'Bash(git push)'])
  }, SLOW)

  test('the list shows ten rows at a time, and marks that more follow', async () => {
    world()
    const many = Array.from({ length: 12 }, (_, at) => `mcp__srv__tool${String(at).padStart(2, '0')}`)
    const { screen } = await openRules(sessionHolding({ allow: { userSettings: many } }), { columns: 100 })
    expect(listed(screen.text())).toEqual(['Add a new rule…', ...many.slice(0, 9)])
    expect(screen.text()).toMatch(/↓ 10\.\s+mcp__srv__tool08/)
  }, SLOW)

  test('an empty tab still offers to add a rule', async () => {
    world()
    const { screen } = await openRules(sessionHolding({}), { initialTab: 'ask' })
    expect(listed(screen.text())).toEqual(['Add a new rule…'])
  }, SLOW)

  test('the Workspace tab explains the workspace and lists the directories', async () => {
    const { project } = world()
    const directories = new Map([['/srv/data', { path: '/srv/data', source: 'session' as const }]])
    const { screen } = await openRules(sessionHolding({}, { additionalWorkingDirectories: directories }), { initialTab: 'workspace' })
    const frame = screen.text()
    expect(frame).toContain('Claudin can read files in the workspace, and make edits when auto-accept edits is on.')
    expect(frame).toContain(project)
    expect(listed(frame)).toEqual(['/srv/data', 'Add directory…'])
  }, SLOW)

  test('with nothing denied, the Recently denied tab says so', async () => {
    world()
    const { screen } = await openRules(sessionHolding({}), { initialTab: 'recent' })
    expect(screen.text()).toContain('No recent denials.')
  }, SLOW)
})

describe('the footer', () => {
  test('changes with focus: tab row, list, search', async () => {
    world()
    const opened = await openRules(sessionHolding({ allow: { userSettings: ['Read'] } }))
    const { screen } = opened
    expect(screen.text()).toContain('←/→ tab switch · ↓ return · Esc cancel')
    await screen.press(KEYS.down)
    expect(screen.text()).toContain('↑↓ navigate · Enter select · Type to search · ←/→ switch · Esc cancel')
    expect(focused(screen.text())).toBe('Add a new rule…')
    await screen.press('/')
    expect(screen.text()).toContain('Type to filter · Enter/↓ select · ↑ tabs · Esc clear')
  }, SLOW)

  for (const [key, name] of [
    [KEYS.ctrlC, 'Ctrl-C'],
    ['\x04', 'Ctrl-D'],
  ] as const) {
    test(`one ${name} in the list asks for a second one, and does not leave`, async () => {
      world()
      const opened = await openRules(sessionHolding({ allow: { userSettings: ['Read'] } }))
      const { screen } = opened
      await screen.press(key)
      expect(screen.text()).toContain(`Press ${name} again to exit`)
      expect(screen.text()).not.toContain('tab switch')
      expect(opened.exits).toEqual([])
    }, SLOW)
  }
})

describe('a rule opened from the list', () => {
  // "<source> <- <what the details line says>", one per editable origin.
  const SOURCES = [
    'userSettings <- From user settings',
    'projectSettings <- From shared project settings',
    'localSettings <- From project local settings',
    'session <- From current session',
    'cliArg <- From CLI argument',
  ].map(row => {
    const [source, shown] = row.split(' <- ') as [PermissionRuleSource, string]
    return { source, shown }
  })
  for (const { source, shown } of SOURCES) {
    test(`a ${source} rule offers to delete it and names where it comes from`, async () => {
      world()
      const opened = await openRules(sessionHolding({ allow: { [source]: ['Bash(npm test:*)'] } }))
      const lines = (await openNth(opened, 1)).split('\n').map(line => line.replace(/│/g, '').trim())
      const at = lines.indexOf('Delete allowed tool?')
      expect(at).toBeGreaterThanOrEqual(0)
      expect(lines.slice(at).filter(Boolean).slice(0, 7)).toEqual([
        'Delete allowed tool?',
        'Bash(npm test:*)',
        'Any Bash command starting with npm test',
        shown,
        'Are you sure you want to delete this permission rule?',
        '❯ 1. Yes',
        '2. No',
      ])
      expect(opened.screen.text()).toContain('Esc to cancel')
    }, SLOW)
  }

  const KINDS = [
    { kind: 'allow', tab: 'allow', title: 'Delete allowed tool?' },
    { kind: 'ask', tab: 'ask', title: 'Delete ask tool?' },
    { kind: 'deny', tab: 'deny', title: 'Delete denied tool?' },
  ] as const
  for (const { kind, tab, title } of KINDS) {
    test(`the title names a ${kind} rule as "${title}"`, async () => {
      world()
      const opened = await openRules(sessionHolding({ [kind]: { userSettings: ['Read'] } }), { initialTab: tab })
      expect(await openNth(opened, 1)).toContain(title)
    }, SLOW)
  }

  test('the title is bold in the colour of the box, the rule bold, the source dim like the footer', async () => {
    world()
    const opened = await openRules(sessionHolding({ deny: { userSettings: ['Grep'] } }), { initialTab: 'deny' })
    await openNth(opened, 1)
    const styled = opened.screen.styled()
    const title = styleBefore(styled, 'Delete denied tool?')
    expect(title).toContain('\u001B[1m')
    expect(title).toContain(styleBefore(styled, '╭'))
    expect(styleBefore(styled, 'Grep')).toContain('\u001B[1m')
    expect(styleBefore(styled, 'From user settings')).toBe(styleBefore(styled, 'Esc to cancel'))
  }, SLOW)

  test('a rule for a whole non-Bash tool says so', async () => {
    world()
    const opened = await openRules(sessionHolding({ allow: { userSettings: ['WebSearch'] } }))
    expect(await openNth(opened, 1)).toContain('Any use of the WebSearch tool')
  }, SLOW)
})

describe('managed rules are read-only', () => {
  test('a policy rule opens as details, with no way to delete it', async () => {
    const w = world()
    const opened = await openRules(sessionHolding({ allow: { policySettings: ['WebFetch(domain:corp.example)'] }, deny: { policySettings: ['Bash(curl:*)'] } }))
    const frame = await openNth(opened, 1)
    const text = frame.replace(/│/g, ' ')
    expect(text).toContain('Rule details')
    expect(text).toContain('WebFetch(domain:corp.example)')
    expect(text).toContain('From enterprise managed settings')
    expect(text).toContain('This rule is configured by managed settings and cannot be modified.')
    expect(text).toContain('Contact your system administrator for more information.')
    expect(text).not.toContain('Delete')
    expect(text).not.toContain('Yes')
    expect(listed(frame)).toEqual([])
    expect(opened.screen.text()).toContain('Esc to cancel')

    await opened.screen.press(KEYS.enter, '1', 'y', KEYS.down, KEYS.enter)
    expect(opened.screen.text()).toContain('Rule details')
    expect(heldNow(opened.screen, 'allow')).toEqual({ policySettings: ['WebFetch(domain:corp.example)'] })
    expect(readSettings(w, 'userSettings')).toBeUndefined()

    await opened.screen.press(KEYS.esc)
    expect(listed(await backAtList(opened))).toEqual(['Add a new rule…', 'WebFetch(domain:corp.example)'])
    await opened.screen.press(KEYS.esc)
    expect(plainExits(opened.exits)).toEqual([{ result: 'Permissions dialog dismissed', options: { display: 'system' } }])
  }, SLOW)

  test('a managed deny rule cannot be deleted either', async () => {
    world()
    const opened = await openRules(sessionHolding({ deny: { policySettings: ['Bash(curl:*)'] } }), { initialTab: 'deny' })
    const frame = await openNth(opened, 1)
    expect(frame).toContain('Rule details')
    expect(frame).toContain('Any Bash command starting with curl')
    await opened.screen.press(KEYS.enter, '1')
    expect(heldNow(opened.screen, 'deny')).toEqual({ policySettings: ['Bash(curl:*)'] })
  }, SLOW)

  test('the read-only box is drawn in the permission colour, the delete box in the error colour', async () => {
    world()
    const managed = await openRules(sessionHolding({ allow: { policySettings: ['Read'] } }))
    await openNth(managed, 1)
    const managedBorder = /(\u001B\[[0-9;]*m)+╭/.exec(managed.screen.styled())?.[0]
    await managed.screen.close()
    const editable = await openRules(sessionHolding({ allow: { userSettings: ['Read'] } }))
    await openNth(editable, 1)
    const editableBorder = /(\u001B\[[0-9;]*m)+╭/.exec(editable.screen.styled())?.[0]
    expect(managedBorder).toBeDefined()
    expect(editableBorder).toBeDefined()
    expect(managedBorder).not.toEqual(editableBorder)
  }, SLOW)

  const LOCKED: { source: PermissionRuleSource; shown: string }[] = [
    { source: 'flagSettings', shown: 'From command line arguments' },
    { source: 'command', shown: 'From command configuration' },
  ]
  for (const { source, shown } of LOCKED) {
    test(`a ${source} rule names its source, and backing out keeps it`, async () => {
      world()
      const opened = await openRules(sessionHolding({ allow: { [source]: ['Grep'] } }))
      expect(await openNth(opened, 1)).toContain(shown)
      await opened.screen.press(KEYS.esc)
      expect(listed(await backAtList(opened))).toEqual(['Add a new rule…', 'Grep'])
      expect(heldNow(opened.screen, 'allow')).toEqual({ [source]: ['Grep'] })
    }, SLOW)
  }
})

describe('deleting a rule', () => {
  const FILES: FileSource[] = ['userSettings', 'projectSettings', 'localSettings']
  for (const source of FILES) {
    test(`a ${source} deny rule leaves that file and that slot only`, async () => {
      const w = world()
      const elsewhere = FILES.filter(other => other !== source)
      for (const file of FILES) writeSettings(w, file, { permissions: { deny: ['Bash(rm:*)', 'Write'], allow: ['Bash(rm:*)'] } })
      const before = Object.fromEntries(elsewhere.map(other => [other, readSettings(w, other)]))
      const opened = await openRules(
        sessionHolding({
          deny: { userSettings: ['Bash(rm:*)', 'Write'], projectSettings: ['Bash(rm:*)', 'Write'], localSettings: ['Bash(rm:*)', 'Write'] },
          allow: { userSettings: ['Bash(rm:*)'], projectSettings: ['Bash(rm:*)'], localSettings: ['Bash(rm:*)'] },
        }),
        { initialTab: 'deny' },
      )
      // Equal texts are listed in source order: user, project, local.
      const n = FILES.indexOf(source) + 1
      expect(await openNth(opened, n)).toContain(
        { userSettings: 'From user settings', projectSettings: 'From shared project settings', localSettings: 'From project local settings' }[source],
      )
      await opened.screen.press(KEYS.enter)
      await backAtList(opened)

      expect(readSettings(w, source)).toEqual({ permissions: { deny: ['Write'], allow: ['Bash(rm:*)'] } })
      for (const other of elsewhere) expect(readSettings(w, other)).toEqual(before[other])
      const deny = heldNow(opened.screen, 'deny')
      expect(deny[source]).toEqual(['Write'])
      for (const other of elsewhere) expect(deny[other]).toEqual(['Bash(rm:*)', 'Write'])
      expect(heldNow(opened.screen, 'allow')).toEqual({ userSettings: ['Bash(rm:*)'], projectSettings: ['Bash(rm:*)'], localSettings: ['Bash(rm:*)'] })
      expect(listed(opened.screen.text())).toEqual(['Add a new rule…', 'Bash(rm:*)', 'Bash(rm:*)', 'Write', 'Write', 'Write'])
    }, SLOW)
  }

  for (const source of ['session', 'cliArg'] as const) {
    test(`a ${source} rule is dropped from the session and no file is written`, async () => {
      const w = world()
      const opened = await openRules(sessionHolding({ ask: { [source]: ['Edit', 'Bash(make:*)'], userSettings: ['Edit'] } }), { initialTab: 'ask' })
      // Sorted: Bash(make:*), Edit (user), Edit (source).
      expect(await openNth(opened, 3)).toContain(source === 'session' ? 'From current session' : 'From CLI argument')
      await opened.screen.press(KEYS.enter)
      await backAtList(opened)
      expect(heldNow(opened.screen, 'ask')).toEqual({ [source]: ['Bash(make:*)'], userSettings: ['Edit'] })
      for (const file of FILES) expect(readSettings(w, file)).toBeUndefined()
    }, SLOW)
  }

  test('a rule whose file no longer holds it is still dropped from the session', async () => {
    const w = world()
    writeSettings(w, 'userSettings', { permissions: { allow: ['Read'] } })
    const opened = await openRules(sessionHolding({ allow: { userSettings: ['Grep', 'Read'] } }))
    await openNth(opened, 1)
    await opened.screen.press(KEYS.enter)
    await backAtList(opened)
    expect(heldNow(opened.screen, 'allow')).toEqual({ userSettings: ['Read'] })
    expect(readSettings(w, 'userSettings')).toEqual({ permissions: { allow: ['Read'] } })
  }, SLOW)

  const KEEPS = [
    { how: 'No', keys: ['2'] },
    { how: 'Down then Enter (No)', keys: [KEYS.down, KEYS.enter] },
    { how: 'Esc', keys: [KEYS.esc] },
  ]
  for (const { how, keys } of KEEPS) {
    test(`${how} keeps the rule, in the session and in the file`, async () => {
      const w = world()
      writeSettings(w, 'localSettings', { permissions: { deny: ['Bash(sudo:*)'] } })
      const opened = await openRules(sessionHolding({ deny: { localSettings: ['Bash(sudo:*)'] } }), { initialTab: 'deny' })
      await openNth(opened, 1)
      await opened.screen.press(...keys)
      expect(listed(await backAtList(opened))).toEqual(['Add a new rule…', 'Bash(sudo:*)'])
      expect(heldNow(opened.screen, 'deny')).toEqual({ localSettings: ['Bash(sudo:*)'] })
      expect(readSettings(w, 'localSettings')).toEqual({ permissions: { deny: ['Bash(sudo:*)'] } })
      await opened.screen.press(KEYS.esc)
      expect(plainExits(opened.exits)).toEqual([{ result: 'Permissions dialog dismissed', options: { display: 'system' } }])
    }, SLOW)
  }

  test('y does not answer the question; n backs out like No', async () => {
    world()
    const opened = await openRules(sessionHolding({ deny: { session: ['Write'] } }), { initialTab: 'deny' })
    await openNth(opened, 1)
    await opened.screen.press('y')
    expect(opened.screen.text()).toContain('Delete denied tool?')
    expect(heldNow(opened.screen, 'deny')).toEqual({ session: ['Write'] })
    await opened.screen.press('n')
    expect(listed(await backAtList(opened))).toEqual(['Add a new rule…', 'Write'])
    expect(heldNow(opened.screen, 'deny')).toEqual({ session: ['Write'] })
  }, SLOW)

  const FOCUS = [
    { picked: 2, next: 'Read', why: 'the rule after it' },
    { picked: 3, next: 'Grep', why: 'the rule before it, when it was the last' },
  ]
  for (const { picked, next, why } of FOCUS) {
    test(`after a delete, ↓ from the tab row lands on ${why}`, async () => {
      world()
      const opened = await openRules(sessionHolding({ allow: { session: ['Glob', 'Grep', 'Read'] } }))
      expect(await openNth(opened, picked)).toContain(['Glob', 'Grep', 'Read'][picked - 1]!)
      await opened.screen.press(KEYS.enter)
      await backAtList(opened)
      await opened.screen.press(KEYS.down)
      expect(focused(opened.screen.text())).toBe(next)
    }, SLOW)
  }

  test('after deleting the only rule the cursor is back on "Add a new rule…"', async () => {
    world()
    const opened = await openRules(sessionHolding({ allow: { session: ['Read'] } }))
    await openNth(opened, 1)
    await opened.screen.press(KEYS.enter)
    await backAtList(opened)
    await opened.screen.press(KEYS.down)
    expect(focused(opened.screen.text())).toBe('Add a new rule…')
    expect(listed(opened.screen.text())).toEqual(['Add a new rule…'])
  }, SLOW)
})

describe('what the screen reports on the way out', () => {
  test('nothing changed: a system note that the dialog was dismissed', async () => {
    world()
    const opened = await openRules(sessionHolding({ allow: { userSettings: ['Read'] } }))
    await opened.screen.press(KEYS.esc)
    expect(opened.exits).toEqual([{ result: 'Permissions dialog dismissed', options: { display: 'system' } }])
    expect(opened.retries).toEqual([])
  }, SLOW)

  test('Esc from inside the list leaves too', async () => {
    world()
    const opened = await openRules(sessionHolding({ allow: { userSettings: ['Read'] } }))
    await opened.screen.press(KEYS.down, KEYS.down, KEYS.esc)
    expect(plainExits(opened.exits)).toEqual([{ result: 'Permissions dialog dismissed', options: { display: 'system' } }])
  }, SLOW)

  test('each delete is one line, in order, the rule in bold, with no options', async () => {
    world()
    const opened = await openRules(sessionHolding({ allow: { session: ['Bash(git push:*)', 'Read'] } }))
    await openNth(opened, 1)
    await opened.screen.press(KEYS.enter)
    await backAtList(opened)
    // The cursor waits on the rule after the deleted one.
    await opened.screen.press(KEYS.down, KEYS.enter)
    await opened.screen.until(frame => frame.includes('Delete allowed tool?'), 'the details')
    await opened.screen.press(KEYS.enter)
    await backAtList(opened)
    await opened.screen.press(KEYS.esc)
    expect(opened.exits).toEqual([
      { result: `Deleted allow rule ${BOLD('Bash(git push:*)')}\nDeleted allow rule ${BOLD('Read')}`, options: undefined },
    ])
  }, SLOW)

  test('a deleted deny rule is reported as a deny rule', async () => {
    world()
    const opened = await openRules(sessionHolding({ deny: { session: ['WebFetch'] } }), { initialTab: 'deny' })
    await openNth(opened, 1)
    await opened.screen.press(KEYS.enter)
    await backAtList(opened)
    await opened.screen.press(KEYS.esc)
    expect(plainExits(opened.exits)).toEqual([{ result: 'Deleted deny rule WebFetch', options: undefined }])
  }, SLOW)
})

describe('adding a rule from a tab', () => {
  const TABS = ['allow', 'ask', 'deny'] as const
  for (const tab of TABS) {
    test(`"Add a new rule…" on the ${tab} tab adds a ${tab} rule, saved where the user picks`, async () => {
      const w = world()
      const opened = await openRules(sessionHolding({}), { initialTab: tab })
      await opened.screen.press(KEYS.down, KEYS.enter)
      expect(await opened.screen.until(frame => frame.includes('Enter to submit'), 'the rule input')).toContain(`Add ${tab} permission rule`)
      for (const ch of 'Bash(make test)') await opened.screen.press(ch)
      await opened.screen.press(KEYS.enter)
      await opened.screen.until(frame => frame.includes('Where should this rule be saved?'), 'the destination question')
      await opened.screen.press('2')
      await backAtList(opened)
      expect(heldNow(opened.screen, tab)).toEqual({ projectSettings: ['Bash(make test)'] })
      for (const other of TABS.filter(kind => kind !== tab)) expect(heldNow(opened.screen, other)).toEqual({})
      expect(readSettings(w, 'projectSettings')).toEqual({ permissions: { [tab]: ['Bash(make test)'] } })
      await opened.screen.press(KEYS.esc)
      expect(opened.exits).toEqual([{ result: `Added ${tab} rule ${BOLD('Bash(make test)')}`, options: undefined }])
    }, SLOW)
  }

  test('Esc in the rule input goes back to the list and adds nothing', async () => {
    world()
    const opened = await openRules(sessionHolding({}), { initialTab: 'deny' })
    await opened.screen.press(KEYS.down, KEYS.enter)
    await opened.screen.until(frame => frame.includes('Enter to submit'), 'the rule input')
    await opened.screen.press('R', KEYS.esc)
    expect(listed(await backAtList(opened))).toEqual(['Add a new rule…'])
    await opened.screen.press(KEYS.esc)
    expect(plainExits(opened.exits)).toEqual([{ result: 'Permissions dialog dismissed', options: { display: 'system' } }])
  }, SLOW)

  test('Esc at the destination question goes back to the list and adds nothing', async () => {
    const w = world()
    const opened = await openRules(sessionHolding({}))
    await opened.screen.press(KEYS.down, KEYS.enter)
    await opened.screen.until(frame => frame.includes('Enter to submit'), 'the rule input')
    for (const ch of 'Read') await opened.screen.press(ch)
    await opened.screen.press(KEYS.enter)
    await opened.screen.until(frame => frame.includes('Where should this rule be saved?'), 'the destination question')
    await opened.screen.press(KEYS.esc)
    expect(listed(await backAtList(opened))).toEqual(['Add a new rule…'])
    expect(heldNow(opened.screen, 'allow')).toEqual({})
    expect(readSettings(w, 'localSettings')).toBeUndefined()
  }, SLOW)

  const UNREACHABLE: { why: string; held: Held; severity: string; fix: RegExp }[] = [
    { why: 'blocked', held: { deny: { userSettings: ['Bash'] } }, severity: 'blocked', fix: /Remove the "Bash" deny rule from user settings/ },
    { why: 'shadowed', held: { ask: { userSettings: ['Bash'] } }, severity: 'shadowed', fix: /Remove the "Bash" ask rule from user settings/ },
  ]
  for (const row of UNREACHABLE) {
    test(`an allow rule a wider rule makes unreachable is reported as ${row.why}, with the reason and the fix`, async () => {
      world()
      const opened = await openRules(sessionHolding(row.held))
      await opened.screen.press(KEYS.down, KEYS.enter)
      await opened.screen.until(frame => frame.includes('Enter to submit'), 'the rule input')
      for (const ch of 'Bash(ls)') await opened.screen.press(ch)
      await opened.screen.press(KEYS.enter)
      await opened.screen.until(frame => frame.includes('Where should this rule be saved?'), 'the destination question')
      await opened.screen.press('1')
      await backAtList(opened)
      await opened.screen.press(KEYS.esc)
      const [exit] = opened.exits
      const lines = exit!.result!.split('\n')
      expect(lines).toHaveLength(4)
      expect(lines[0]).toBe(`Added allow rule ${BOLD('Bash(ls)')}`)
      expect(lines[1]).toBe(`\u001B[33m⚠ Warning: Bash(ls) is ${row.severity}\u001B[39m`)
      expect(lines[2]).toMatch(/^\u001B\[2m {2}\S.*\u001B\[22m$/)
      expect(lines[3]).toMatch(/^\u001B\[2m {2}Fix: .*\u001B\[22m$/)
      expect(lines[3]).toMatch(row.fix)
    }, SLOW)
  }

  test('a rule nothing shadows gets no warning', async () => {
    world()
    const opened = await openRules(sessionHolding({ deny: { userSettings: ['Write'] } }))
    await opened.screen.press(KEYS.down, KEYS.enter)
    await opened.screen.until(frame => frame.includes('Enter to submit'), 'the rule input')
    for (const ch of 'Bash(ls)') await opened.screen.press(ch)
    await opened.screen.press(KEYS.enter)
    await opened.screen.until(frame => frame.includes('Where should this rule be saved?'), 'the destination question')
    await opened.screen.press('1')
    await backAtList(opened)
    await opened.screen.press(KEYS.esc)
    expect(plainExits(opened.exits)).toEqual([{ result: 'Added allow rule Bash(ls)', options: undefined }])
  }, SLOW)
})

describe('searching', () => {
  const RULES = sessionHolding({ allow: { userSettings: ['Read', 'Bash(git log)', 'Bash(GIT status)', 'WebFetch(domain:github.com)', 'Grep'] } })

  test('a letter typed in the list starts a search with it; matching ignores case; the add row hides', async () => {
    world()
    const opened = await openRules(RULES)
    await opened.screen.press(KEYS.down, 'g')
    expect(opened.screen.text()).toContain('⌕ g')
    expect(listed(opened.screen.text())).toEqual(['Bash(git log)', 'Bash(GIT status)', 'Grep', 'WebFetch(domain:github.com)'])
    await opened.screen.press('i', 't')
    expect(listed(opened.screen.text())).toEqual(['Bash(git log)', 'Bash(GIT status)', 'WebFetch(domain:github.com)'])
  }, SLOW)

  test('"/" starts an empty search; Enter keeps the filter and moves into the list', async () => {
    world()
    const opened = await openRules(RULES)
    await opened.screen.press(KEYS.down, '/')
    expect(opened.screen.text()).toContain('Type to filter')
    expect(listed(opened.screen.text())).toEqual(['Add a new rule…', 'Bash(git log)', 'Bash(GIT status)', 'Grep', 'Read', 'WebFetch(domain:github.com)'])
    for (const ch of 'status') await opened.screen.press(ch)
    await opened.screen.press(KEYS.enter)
    expect(opened.screen.text()).toContain('↑↓ navigate · Enter select')
    expect(listed(opened.screen.text())).toEqual(['Bash(GIT status)'])
    await opened.screen.press(KEYS.enter)
    expect(await opened.screen.until(frame => frame.includes('Delete'), 'the details')).toContain('Bash(GIT status)')
  }, SLOW)

  test('the navigation letters j k m i r and Space do not start a search', async () => {
    world()
    const opened = await openRules(RULES)
    await opened.screen.press(KEYS.down)
    for (const key of ['j', 'k', 'm', 'i', 'r', ' ']) {
      await opened.screen.press(key)
      expect(opened.screen.text()).not.toContain('Type to filter')
      expect(opened.screen.text()).toContain('⌕ Search…')
    }
  }, SLOW)

  test('a letter with Ctrl or Alt held does not start a search', async () => {
    world()
    const opened = await openRules(RULES)
    await opened.screen.press(KEYS.down)
    for (const key of ['\x19', '\x1Bw']) {
      await opened.screen.press(key)
      expect(opened.screen.text()).not.toContain('Type to filter')
      expect(opened.screen.text()).toContain('⌕ Search…')
    }
  }, SLOW)

  test('Esc clears the query, a second Esc ends the search, a third leaves', async () => {
    world()
    const opened = await openRules(RULES)
    await opened.screen.press(KEYS.down, 'w', 'e')
    expect(listed(opened.screen.text())).toEqual(['WebFetch(domain:github.com)'])
    await opened.screen.press(KEYS.esc)
    expect(opened.screen.text()).toContain('Type to filter')
    expect(listed(opened.screen.text())).toContain('Add a new rule…')
    await opened.screen.press(KEYS.esc)
    expect(opened.screen.text()).not.toContain('Type to filter')
    expect(opened.exits).toEqual([])
    await opened.screen.press(KEYS.esc)
    expect(plainExits(opened.exits)).toEqual([{ result: 'Permissions dialog dismissed', options: { display: 'system' } }])
  }, SLOW)

  test('a query nothing matches leaves an empty list', async () => {
    world()
    const opened = await openRules(RULES)
    await opened.screen.press(KEYS.down, 'z', 'z')
    expect(listed(opened.screen.text())).toEqual([])
  }, SLOW)

  test('the query filters every rule tab alike', async () => {
    world()
    const opened = await openRules(sessionHolding({ deny: { userSettings: ['Bash(rm:*)', 'Write'] } }), { initialTab: 'deny' })
    await opened.screen.press(KEYS.down, 'w')
    expect(listed(opened.screen.text())).toEqual(['Write'])
  }, SLOW)
})

describe('the workspace tab', () => {
  test('adding a directory adds it for this session only, and reports it', async () => {
    const w = world()
    const extra = join(w.home, 'shared-data')
    mkdirSync(extra)
    const opened = await openRules(sessionHolding({}), { initialTab: 'workspace' })
    await opened.screen.press(KEYS.down, KEYS.enter)
    await opened.screen.until(frame => frame.includes('Enter the path to the directory:'), 'the directory input')
    // A trailing slash, so no completion is offered and Enter submits what was typed.
    for (const ch of `${extra}/`) await opened.screen.press(ch)
    await Bun.sleep(400)
    await opened.screen.press(KEYS.enter)
    await opened.screen.until(frame => frame.includes('Permissions:'), 'the rule list')
    const added = opened.screen.state().toolPermissionContext.additionalWorkingDirectories
    expect([...added.keys()]).toEqual([extra])
    expect([...added.values()].map(entry => entry.source)).toEqual(['session'])
    expect(readSettings(w, 'localSettings')).toBeUndefined()
    await opened.screen.press(KEYS.esc)
    expect(opened.exits).toEqual([{ result: `Added directory ${BOLD(extra)} to workspace for this session`, options: undefined }])
  }, SLOW)

  test('removing a directory takes it out of the session and reports it', async () => {
    world()
    const directories = new Map([
      ['/srv/data', { path: '/srv/data', source: 'session' as const }],
      ['/srv/logs', { path: '/srv/logs', source: 'session' as const }],
    ])
    const opened = await openRules(sessionHolding({}, { additionalWorkingDirectories: directories }), { initialTab: 'workspace' })
    await opened.screen.press(KEYS.down, KEYS.enter)
    await opened.screen.until(frame => frame.includes('Remove directory from workspace?'), 'the remove question')
    await opened.screen.press(KEYS.enter)
    await opened.screen.until(frame => frame.includes('Permissions:'), 'the rule list')
    expect([...opened.screen.state().toolPermissionContext.additionalWorkingDirectories.keys()]).toEqual(['/srv/logs'])
    await opened.screen.press(KEYS.esc)
    expect(opened.exits).toEqual([{ result: `Removed directory ${BOLD('/srv/data')} from workspace`, options: undefined }])
  }, SLOW)

  test('backing out of a removal keeps the directory', async () => {
    world()
    const directories = new Map([['/srv/data', { path: '/srv/data', source: 'session' as const }]])
    const opened = await openRules(sessionHolding({}, { additionalWorkingDirectories: directories }), { initialTab: 'workspace' })
    await opened.screen.press(KEYS.down, KEYS.enter)
    await opened.screen.until(frame => frame.includes('Remove directory from workspace?'), 'the remove question')
    await opened.screen.press(KEYS.esc)
    await opened.screen.until(frame => frame.includes('Permissions:'), 'the rule list')
    expect([...opened.screen.state().toolPermissionContext.additionalWorkingDirectories.keys()]).toEqual(['/srv/data'])
    await opened.screen.press(KEYS.esc)
    expect(plainExits(opened.exits)).toEqual([{ result: 'Permissions dialog dismissed', options: { display: 'system' } }])
  }, SLOW)

  test('backing out of adding a directory adds nothing', async () => {
    world()
    const opened = await openRules(sessionHolding({}), { initialTab: 'workspace' })
    await opened.screen.press(KEYS.down, KEYS.enter)
    await opened.screen.until(frame => frame.includes('Enter the path to the directory:'), 'the directory input')
    await opened.screen.press(KEYS.esc)
    await opened.screen.until(frame => frame.includes('Permissions:'), 'the rule list')
    expect(opened.screen.state().toolPermissionContext.additionalWorkingDirectories.size).toBe(0)
  }, SLOW)

  test('rule changes and directory changes are reported together, in order', async () => {
    world()
    const directories = new Map([['/srv/data', { path: '/srv/data', source: 'session' as const }]])
    const opened = await openRules(sessionHolding({ allow: { session: ['Read'] } }, { additionalWorkingDirectories: directories }))
    await openNth(opened, 1)
    await opened.screen.press(KEYS.enter)
    await backAtList(opened)
    await opened.screen.press(MOVE.right, MOVE.right, MOVE.right)
    await opened.screen.until(frame => frame.includes('Claudin can read files in the workspace'), 'the workspace tab')
    await opened.screen.press(KEYS.down, KEYS.enter)
    await opened.screen.until(frame => frame.includes('Remove directory from workspace?'), 'the remove question')
    await opened.screen.press(KEYS.enter)
    await opened.screen.until(frame => frame.includes('Permissions:'), 'the rule list')
    await opened.screen.press(KEYS.esc)
    expect(plainExits(opened.exits)).toEqual([{ result: 'Deleted allow rule Read\nRemoved directory /srv/data from workspace', options: undefined }])
  }, SLOW)
})
