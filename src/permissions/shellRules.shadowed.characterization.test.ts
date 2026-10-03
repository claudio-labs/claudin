/**
 * Characterization of unreachable-rule detection: which specific allow rules
 * can never take effect because a tool-wide deny or ask rule for the same tool
 * wins first, and the reason and fix text that /doctor and the permission UI
 * show for each.
 */
import { describe, expect, test } from 'bun:test'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import {
  detectUnreachableRules,
  isSharedSettingSource,
} from 'src/permissions/shadowedRuleDetection.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

type Lists = Partial<Record<PermissionRuleSource, string[]>>

function context(lists: { allow?: Lists; deny?: Lists; ask?: Lists }): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: lists.allow ?? {},
    alwaysDenyRules: lists.deny ?? {},
    alwaysAskRules: lists.ask ?? {},
    isBypassPermissionsModeAvailable: false,
  }
}

const off = { sandboxAutoAllowEnabled: false }
const on = { sandboxAutoAllowEnabled: true }

/** The allow rules reported, each as "source:Tool(content)<-shadowType". */
function summary(ctx: ToolPermissionContext, opts = off): string[] {
  return detectUnreachableRules(ctx, opts).map(
    u =>
      `${u.rule.source}:${u.rule.ruleValue.toolName}(${u.rule.ruleValue.ruleContent ?? ''})<-${u.shadowType}`,
  )
}

describe('which sources count as shared', () => {
  const rows: Array<[PermissionRuleSource, boolean]> = [
    ['projectSettings', true],
    ['policySettings', true],
    ['command', true],
    ['userSettings', false],
    ['localSettings', false],
    ['flagSettings', false],
    ['cliArg', false],
    ['session', false],
  ]
  for (const [source, shared] of rows) {
    test(`${source}: ${shared}`, () => {
      expect(isSharedSettingSource(source)).toBe(shared)
    })
  }
})

describe('what is reported', () => {
  test('nothing when there are no rules', () => {
    expect(detectUnreachableRules(context({}), off)).toEqual([])
  })

  test('a specific allow under a tool-wide deny is blocked', () => {
    const ctx = context({
      allow: { localSettings: ['Bash(ls:*)'] },
      deny: { userSettings: ['Bash'] },
    })
    const [only, ...rest] = detectUnreachableRules(ctx, off)
    expect(rest).toEqual([])
    expect(only!.rule).toEqual({
      source: 'localSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash', ruleContent: 'ls:*' },
    })
    expect(only!.shadowedBy).toEqual({
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'Bash' },
    })
    expect(only!.shadowType).toBe('deny')
  })

  test('a specific allow under a tool-wide ask is shadowed', () => {
    const ctx = context({
      allow: { userSettings: ['WebFetch(domain:example.com)'] },
      ask: { session: ['WebFetch'] },
    })
    const [only] = detectUnreachableRules(ctx, off)
    expect(only!.shadowType).toBe('ask')
    expect(only!.shadowedBy).toEqual({
      source: 'session',
      ruleBehavior: 'ask',
      ruleValue: { toolName: 'WebFetch' },
    })
  })

  test('deny wins over ask, and the rule is reported once', () => {
    const ctx = context({
      allow: { session: ['Bash(git *)'] },
      deny: { projectSettings: ['Bash'] },
      ask: { projectSettings: ['Bash'] },
    })
    expect(summary(ctx)).toEqual(['session:Bash(git *)<-deny'])
  })

  test('"Tool(*)" and "Tool()" count as tool-wide', () => {
    expect(
      summary(context({ allow: { session: ['Bash(ls)'] }, deny: { session: ['Bash(*)'] } })),
    ).toEqual(['session:Bash(ls)<-deny'])
    expect(
      summary(context({ allow: { session: ['Bash(ls)'] }, ask: { session: ['Bash()'] } })),
    ).toEqual(['session:Bash(ls)<-ask'])
  })

  test('legacy tool names are compared after normalization', () => {
    expect(
      summary(context({ allow: { session: ['Task(Explore)'] }, ask: { session: ['Agent'] } })),
    ).toEqual(['session:Agent(Explore)<-ask'])
  })

  test('every shadowed allow rule is listed, in source order then list order', () => {
    const ctx = context({
      allow: {
        session: ['Bash(z)'],
        cliArg: ['Bash(y)'],
        localSettings: ['Bash(b)', 'Bash(a)'],
        userSettings: ['Bash(u)'],
      },
      deny: { policySettings: ['Bash'] },
    })
    expect(summary(ctx)).toEqual([
      'userSettings:Bash(u)<-deny',
      'localSettings:Bash(b)<-deny',
      'localSettings:Bash(a)<-deny',
      'cliArg:Bash(y)<-deny',
      'session:Bash(z)<-deny',
    ])
  })
})

describe('what is NOT reported', () => {
  const rows: Array<[why: string, lists: Parameters<typeof context>[0]]> = [
    [
      'a tool-wide allow under a tool-wide deny',
      { allow: { session: ['Bash'] }, deny: { session: ['Bash'] } },
    ],
    [
      'a tool-wide allow under a tool-wide ask',
      { allow: { session: ['Bash'] }, ask: { session: ['Bash'] } },
    ],
    [
      'a specific deny, even one covering the allow',
      { allow: { session: ['Bash(rm -rf:*)'] }, deny: { session: ['Bash(rm:*)'] } },
    ],
    [
      'a specific ask, even an identical one',
      { allow: { session: ['Bash(ls)'] }, ask: { session: ['Bash(ls)'] } },
    ],
    [
      'a tool-wide deny for another tool',
      { allow: { session: ['Bash(ls)'] }, deny: { session: ['PowerShell'] } },
    ],
    [
      'a tool-wide ask for another tool',
      { allow: { session: ['Read(/x)'] }, ask: { session: ['Edit'] } },
    ],
    [
      'tool names that differ only in case',
      { allow: { session: ['Bash(ls)'] }, deny: { session: ['bash'] } },
    ],
  ]
  for (const [why, lists] of rows) {
    test(why, () => {
      expect(detectUnreachableRules(context(lists), off)).toEqual([])
      expect(detectUnreachableRules(context(lists), on)).toEqual([])
    })
  }
})

describe('the sandbox auto-allow exception', () => {
  const personal: PermissionRuleSource[] = ['userSettings', 'localSettings', 'flagSettings', 'cliArg', 'session']
  const shared: PermissionRuleSource[] = ['projectSettings', 'policySettings', 'command']

  for (const source of personal) {
    test(`a tool-wide Bash ask from ${source} does not shadow while the sandbox auto-allows`, () => {
      const ctx = context({ allow: { projectSettings: ['Bash(ls)'] }, ask: { [source]: ['Bash'] } })
      expect(summary(ctx, on)).toEqual([])
      expect(summary(ctx, off)).toEqual(['projectSettings:Bash(ls)<-ask'])
    })
  }

  for (const source of shared) {
    test(`a tool-wide Bash ask from ${source} still shadows while the sandbox auto-allows`, () => {
      const ctx = context({ allow: { localSettings: ['Bash(ls)'] }, ask: { [source]: ['Bash'] } })
      expect(summary(ctx, on)).toEqual(['localSettings:Bash(ls)<-ask'])
    })
  }

  test('only Bash gets the exception', () => {
    const ctx = context({ allow: { session: ['PowerShell(ls)'] }, ask: { session: ['PowerShell'] } })
    expect(summary(ctx, on)).toEqual(['session:PowerShell(ls)<-ask'])
  })

  test('the exception never applies to deny', () => {
    const ctx = context({ allow: { session: ['Bash(ls)'] }, deny: { session: ['Bash'] } })
    expect(summary(ctx, on)).toEqual(['session:Bash(ls)<-deny'])
  })

  test('the first tool-wide ask decides: a personal one listed first hides a shared one', () => {
    const ctx = context({
      allow: { session: ['Bash(ls)'] },
      ask: { userSettings: ['Bash'], projectSettings: ['Bash'] },
    })
    expect(summary(ctx, on)).toEqual([])
  })
})

describe('reason and fix text', () => {
  test('deny: names the tool and both sources in their display form', () => {
    const [u] = detectUnreachableRules(
      context({ allow: { localSettings: ['Bash(ls:*)'] }, deny: { policySettings: ['Bash'] } }),
      off,
    )
    expect(u!.reason).toBe('Blocked by "Bash" deny rule (from enterprise managed settings)')
    expect(u!.fix).toBe(
      'Remove the "Bash" deny rule from enterprise managed settings, or remove the specific allow rule from project local settings',
    )
  })

  test('ask: names the tool and both sources in their display form', () => {
    const [u] = detectUnreachableRules(
      context({ allow: { userSettings: ['Read(/a)'] }, ask: { projectSettings: ['Read'] } }),
      off,
    )
    expect(u!.reason).toBe('Shadowed by "Read" ask rule (from shared project settings)')
    expect(u!.fix).toBe(
      'Remove the "Read" ask rule from shared project settings, or remove the specific allow rule from user settings',
    )
  })

  const sourceNames: Array<[PermissionRuleSource, string]> = [
    ['userSettings', 'user settings'],
    ['projectSettings', 'shared project settings'],
    ['localSettings', 'project local settings'],
    ['flagSettings', 'command line arguments'],
    ['policySettings', 'enterprise managed settings'],
    ['cliArg', 'CLI argument'],
    ['command', 'command configuration'],
    ['session', 'current session'],
  ]
  for (const [source, shown] of sourceNames) {
    test(`a ${source} source is shown as "${shown}"`, () => {
      const [u] = detectUnreachableRules(
        context({ allow: { [source]: ['Glob(x)'] }, deny: { [source]: ['Glob'] } }),
        off,
      )
      expect(u!.reason).toContain(`(from ${shown})`)
      expect(u!.fix).toContain(`deny rule from ${shown}, `)
      expect(u!.fix.endsWith(`allow rule from ${shown}`)).toBe(true)
    })
  }

  test('the tool named in the text is the canonical one', () => {
    const [u] = detectUnreachableRules(
      context({ allow: { session: ['Agent(x)'] }, deny: { session: ['Task'] } }),
      off,
    )
    expect(u!.reason).toContain('"Agent" deny rule')
    expect(u!.fix).toContain('the "Agent" deny rule')
  })
})
