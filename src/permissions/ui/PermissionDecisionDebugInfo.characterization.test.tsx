/**
 * The ctrl+d debug panel of the shell permission dialogs: the decision's
 * behaviour, message and reason, the suggested updates, and the allow rules
 * that can never fire.
 *
 * Each case mounts the panel in the app's providers with real permission
 * rules in the app state; nothing is replaced.
 */
import { describe, expect, test } from 'bun:test'
import figures from 'figures'
import * as React from 'react'
import { Text } from 'src/terminal/ink.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { PermissionDecisionDebugInfo } from 'src/permissions/ui/PermissionDecisionDebugInfo.js'
import * as rig from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import type { PermissionDecision, PermissionDecisionReason, PermissionResult } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

rig.isolatedWorld()
rig.withTruecolor()

type Result = React.ComponentProps<typeof PermissionDecisionDebugInfo>['permissionResult']
type ToolPermissionContext = AppState['toolPermissionContext']
type Rules = { [source: string]: string[] }

const BOLD = '\u001B[1m'
const B = figures.bullet

function contextWith(rules: { allow?: Rules; deny?: Rules; ask?: Rules } = {}): ToolPermissionContext {
  return {
    ...getDefaultAppState().toolPermissionContext,
    alwaysAllowRules: rules.allow ?? {},
    alwaysDenyRules: rules.deny ?? {},
    alwaysAskRules: rules.ask ?? {},
  }
}

async function show(result: Result, options: { toolName?: string; context?: ToolPermissionContext } = {}) {
  const screen = await rig.mount(<PermissionDecisionDebugInfo permissionResult={result} toolName={options.toolName} />, {
    columns: 120,
    appState: { toolPermissionContext: options.context ?? contextWith() },
  })
  await Bun.sleep(50)
  return screen
}

const lines = (frame: string) => rig.linesOf(frame).filter(line => line !== '')

const ask = (extra: Partial<Extract<PermissionDecision, { behavior: 'ask' }>> = {}): Result => ({
  behavior: 'ask',
  message: 'Claudin wants to run this',
  ...extra,
})

const addRules = (...rules: string[]): PermissionUpdate => ({
  type: 'addRules',
  destination: 'localSettings',
  behavior: 'allow',
  rules: rules.map(rule => {
    const open = rule.indexOf('(')
    return open < 0 ? { toolName: rule } : { toolName: rule.slice(0, open), ruleContent: rule.slice(open + 1, -1) }
  }),
})

describe('the decision rows', () => {
  test('labels sit right-aligned in a ten-column gutter', async () => {
    const screen = await show(ask({ decisionReason: { type: 'other', reason: 'needs a look' } }))
    expect(lines(screen.text())).toEqual([
      ' Behavior ask',
      '  Message Claudin wants to run this',
      '   Reason needs a look',
      'Suggestions None',
    ])
  }, rig.SLOW)

  const behaviours: Array<[string, Result, string[]]> = [
    ['allow has no message row, and a missing reason reads "undefined"', { behavior: 'allow', updatedInput: {} }, [' Behavior allow', '   Reason undefined']],
    [
      'deny shows its message',
      { behavior: 'deny', message: 'Blocked outright', decisionReason: { type: 'asyncAgent', reason: 'agent said no' } },
      [' Behavior deny', '  Message Blocked outright', '   Reason agent said no'],
    ],
  ]
  for (const [label, result, expected] of behaviours) {
    test(label, async () => {
      const screen = await show(result)
      const shown = lines(screen.text())
      expect(shown.slice(0, expected.length)).toEqual(expected)
      if (result.behavior === 'allow') expect(screen.text()).not.toContain('Message')
    }, rig.SLOW)
  }
})

describe('the reason, by kind', () => {
  const rule = (source: 'userSettings' | 'localSettings', toolName: string, ruleContent?: string) => ({
    type: 'rule' as const,
    rule: { source, ruleBehavior: 'ask' as const, ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent } },
  })
  // [kind, reason, the text after "Reason ", the part shown in bold]
  const kinds: Array<[string, PermissionDecisionReason, string, string | null]> = [
    ['a rule with content', rule('userSettings', 'Bash', 'npm publish:*'), 'Bash(npm publish:*) rule from user settings', 'Bash(npm publish:*)'],
    ['a tool-wide rule', rule('localSettings', 'WebFetch'), 'WebFetch rule from project local settings', 'WebFetch'],
    ['a mode', { type: 'mode', mode: 'acceptEdits' }, 'Accept edits mode', null],
    ['the plan mode', { type: 'mode', mode: 'plan' }, 'Plan Mode mode', null],
    ['a sandbox override', { type: 'sandboxOverride', reason: 'dangerouslyDisableSandbox' }, 'Requires permission to bypass sandbox', null],
    ['a working directory', { type: 'workingDir', reason: 'Path is outside the allowed folders' }, 'Path is outside the allowed folders', null],
    ['a safety check', { type: 'safetyCheck', reason: 'Touches .git/config', classifierApprovable: false }, 'Touches .git/config', null],
    ['something else', { type: 'other', reason: 'Plain other reason' }, 'Plain other reason', null],
    [
      'a permission prompt tool',
      { type: 'permissionPromptTool', permissionPromptToolName: 'mcp__gate__approve', toolResult: {} },
      'mcp__gate__approve permission prompt tool',
      'mcp__gate__approve',
    ],
    ['a hook with a reason', { type: 'hook', hookName: 'PreToolUse:guard', reason: 'too wide' }, 'PreToolUse:guard hook: too wide', 'PreToolUse:guard'],
    ['a hook without one', { type: 'hook', hookName: 'PreToolUse:quiet' }, 'PreToolUse:quiet hook', 'PreToolUse:quiet'],
    ['an async agent', { type: 'asyncAgent', reason: 'Background agent cannot prompt' }, 'Background agent cannot prompt', null],
  ]
  for (const [kind, decisionReason, text, bold] of kinds) {
    test(`${kind}: "${text}"`, async () => {
      const screen = await show(ask({ decisionReason }))
      expect(lines(screen.text())[2]).toBe(`   Reason ${text}`)
      if (bold) expect(rig.styleBefore(screen.styled(), bold)).toContain(BOLD)
      const after = text.slice((bold ?? '').length).trim().split(' ')[0]!
      if (bold && after) expect(rig.styleBefore(screen.styled(), ` ${after}`)).not.toContain(BOLD)
    }, rig.SLOW)
  }

  test('a classifier reason shows nothing without the classifier build flags', async () => {
    const screen = await show(ask({ decisionReason: { type: 'classifier', classifier: 'bash_allow', reason: 'looks fine' } }))
    expect(lines(screen.text())[2]).toBe('   Reason')
    expect(screen.text()).not.toContain('looks fine')
  }, rig.SLOW)
})

describe('a compound command', () => {
  const allowed: PermissionResult = {
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'git status' } } },
  }
  const asking: PermissionResult = {
    behavior: 'ask',
    message: 'm',
    decisionReason: { type: 'other', reason: 'Deletes files' },
    suggestions: [addRules('Bash(rm -rf build)', 'Bash(rm:*)'), { type: 'addDirectories', destination: 'session', directories: ['/tmp/x'] }],
  }
  const nested: PermissionResult = {
    behavior: 'deny',
    message: 'n',
    decisionReason: { type: 'subcommandResults', reasons: new Map() },
  }
  const bare: PermissionResult = { behavior: 'ask', message: 'b' }
  const reasons = new Map<string, PermissionResult>([
    ['git status', allowed],
    ['rm -rf build', asking],
    ['eval "$x"', nested],
    ['curl example.com', bare],
  ])

  test('lists every subcommand with a tick or a cross, its reason and its suggested rules', async () => {
    const screen = await show(ask({ decisionReason: { type: 'subcommandResults', reasons } }))
    const shown = lines(screen.text())
    const from = shown.findIndex(line => line.includes('git status'))
    // The first subcommand shares the row of the "Reason" label.
    expect(shown[from]).toBe(`   Reason ${figures.tick} git status`)
    expect(shown.slice(from, from + 7).map((line, i) => (i === 0 ? line.slice('   Reason '.length) : line.trim()))).toEqual([
      `${figures.tick} git status`,
      '⎿  Bash(git status) rule from user settings',
      `${figures.cross} rm -rf build`,
      '⎿  Deletes files',
      '⎿  Suggested rules: Bash(rm -rf build), Bash(rm:*)',
      `${figures.cross} eval "$x"`,
      `${figures.cross} curl example.com`,
    ])
    expect(rig.styleBefore(screen.styled(), 'Bash(rm:*)')).toContain(BOLD)
  }, rig.SLOW)

  test('the tick is in the success colour and the cross in the error colour', async () => {
    const codes = async (colour: 'success' | 'error') => {
      const probe = await rig.mount(<Text color={colour}>probe-{colour}</Text>)
      await probe.until(f => f.includes(`probe-${colour}`), colour)
      const found = rig.styleBefore(probe.styled(), `probe-${colour}`)
      await probe.close()
      return found
    }
    const success = await codes('success')
    const error = await codes('error')
    const screen = await show(ask({ decisionReason: { type: 'subcommandResults', reasons } }))
    const styled = screen.styled()
    expect(styled).toContain(`${success}${figures.tick}`)
    expect(styled).toContain(`${error}${figures.cross}`)
  }, rig.SLOW)

  test('an ask subcommand with no rule to suggest has no suggestion line', async () => {
    const onlyDirs: PermissionResult = { behavior: 'ask', message: 'd', suggestions: [{ type: 'addDirectories', destination: 'session', directories: ['/srv'] }] }
    const screen = await show(ask({ decisionReason: { type: 'subcommandResults', reasons: new Map([['ls /srv', onlyDirs]]) } }))
    expect(screen.text()).toContain(`${figures.cross} ls /srv`)
    expect(screen.text()).not.toContain('Suggested rules')
  }, rig.SLOW)
})

describe('the suggestions', () => {
  // Rows are compared without their gutter padding: the "Directories" label is
  // wider than the gutter, and its overflow is a finding the rewrite fixes.
  const suggestionRows: Array<[string, PermissionUpdate[] | undefined, string[]]> = [
    ['none given', undefined, ['Suggestions None']],
    ['an empty list', [], ['Suggestions None']],
    [
      'rules, from every addRules update',
      [addRules('Bash(npm test:*)'), addRules('Read')],
      ['Suggestions', `Rules ${B} Bash(npm test:*)`, `${B} Read`],
    ],
    [
      'directories',
      [{ type: 'addDirectories', destination: 'session', directories: ['/srv/data', '/opt/tools'] }],
      ['Suggestions', `Directories ${B} /srv/data`, `${B} /opt/tools`],
    ],
    [
      'a mode, the last one winning',
      [
        { type: 'setMode', destination: 'session', mode: 'plan' },
        { type: 'setMode', destination: 'session', mode: 'acceptEdits' },
      ],
      ['Suggestions', 'Mode Accept edits'],
    ],
    [
      'all three, in the order rules, directories, mode',
      [{ type: 'setMode', destination: 'session', mode: 'plan' }, { type: 'addDirectories', destination: 'session', directories: ['/d'] }, addRules('Bash(make)')],
      ['Suggestions', `Rules ${B} Bash(make)`, `Directories ${B} /d`, 'Mode Plan Mode'],
    ],
  ]
  for (const [label, suggestions, expected] of suggestionRows) {
    test(`${label}`, async () => {
      const screen = await show(ask({ decisionReason: { type: 'other', reason: 'r' }, suggestions }))
      const shown = lines(screen.text())
      expect(shown.slice(3).map(line => line.trim())).toEqual(expected)
    }, rig.SLOW)
  }

  test('rule and mode values start in the same column as the decision values', async () => {
    const screen = await show(ask({ decisionReason: { type: 'other', reason: 'r' }, suggestions: [addRules('Bash(make)'), { type: 'setMode', destination: 'session', mode: 'plan' }] }))
    const shown = lines(screen.text())
    const column = (start: string) => {
      const line = shown.find(l => l.trimStart().startsWith(start))!
      return line.indexOf(start) + start.length + 1
    }
    expect(column('Behavior')).toBe(10)
    expect(column('Rules')).toBe(10)
    expect(column('Mode')).toBe(10)
  }, rig.SLOW)

  test('updates it cannot list read as none', async () => {
    const screen = await show(
      ask({ decisionReason: { type: 'other', reason: 'r' }, suggestions: [{ type: 'removeRules', destination: 'userSettings', behavior: 'deny', rules: [{ toolName: 'Bash' }] }] }),
    )
    const rows = lines(screen.text()).slice(3)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/^Suggestions? None$/)
  }, rig.SLOW)

  test('a deny decision has no suggestions to read', async () => {
    const screen = await show({ behavior: 'deny', message: 'no', decisionReason: { type: 'other', reason: 'r' } })
    expect(lines(screen.text()).at(-1)).toBe('Suggestions None')
  }, rig.SLOW)
})

describe('unreachable rules', () => {
  const shadowed = contextWith({
    allow: { userSettings: ['Bash(ls:*)', 'Read(/etc/**)', 'Bash(cat:*)'], localSettings: ['Bash'] },
    deny: { localSettings: ['Bash'] },
    ask: { projectSettings: ['Read'] },
  })
  const header = (n: number) => `${figures.warning} Unreachable Rules (${n})`

  test('each one is shown with why it never fires and how to fix it', async () => {
    const screen = await show(ask({ decisionReason: { type: 'other', reason: 'r' } }), { context: shadowed, toolName: 'Read' })
    const shown = lines(screen.text())
    const at = shown.indexOf(header(1))
    expect(at).toBeGreaterThan(0)
    expect(shown.slice(at + 1)).toEqual([
      '  Read(/etc/**)',
      '    Shadowed by "Read" ask rule (from shared project settings)',
      '    Fix: Remove the "Read" ask rule from shared project settings, or remove the specific allow rule from user settings',
    ])
    expect(rig.styleBefore(screen.styled(), header(1))).toBe(rig.styleBefore(screen.styled(), 'Read(/etc/**)'))
  }, rig.SLOW)

  // [label, toolName, suggestions, the rules listed]
  const filters: Array<[string, string | undefined, PermissionUpdate[] | undefined, string[]]> = [
    ['no tool name and no suggestions: all of them', undefined, undefined, ['Bash(ls:*)', 'Read(/etc/**)', 'Bash(cat:*)']],
    ['a tool name keeps that tool', 'Bash', undefined, ['Bash(ls:*)', 'Bash(cat:*)']],
    ['a tool with none of them: no section', 'Write', undefined, []],
    ['suggested rules win over the tool name', 'Read', [addRules('Bash(cat:*)')], ['Bash(cat:*)']],
    ['a suggested rule must match tool and content', 'Bash', [addRules('Bash(ls)')], []],
    ['suggestions without rules fall back to the tool name', 'Bash', [{ type: 'setMode', destination: 'session', mode: 'plan' }], ['Bash(ls:*)', 'Bash(cat:*)']],
  ]
  for (const [label, toolName, suggestions, listed] of filters) {
    test(label, async () => {
      const screen = await show(ask({ decisionReason: { type: 'other', reason: 'r' }, suggestions }), { context: shadowed, toolName })
      const shown = lines(screen.text())
      if (listed.length === 0) {
        expect(screen.text()).not.toContain('Unreachable Rules')
        return
      }
      const at = shown.indexOf(header(listed.length))
      expect(at).toBeGreaterThan(0)
      const names = shown.slice(at + 1).filter(line => /^ {2}\S/.test(line)).map(line => line.trim())
      expect(names).toEqual(listed)
    }, rig.SLOW)
  }

  test('a deny-shadowed rule names the deny rule', async () => {
    const screen = await show(ask(), { context: shadowed, toolName: 'Bash' })
    expect(screen.text()).toContain('Blocked by "Bash" deny rule (from project local settings)')
  }, rig.SLOW)

  test('no shadowing, no section', async () => {
    const screen = await show(ask(), { context: contextWith({ allow: { userSettings: ['Bash(ls:*)'] } }) })
    expect(screen.text()).not.toContain('Unreachable')
  }, rig.SLOW)
})
