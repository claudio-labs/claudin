/**
 * The rule side of the permission decision: reading the rules a session
 * holds, finding the one that covers a tool, wording the request a prompt
 * shows, and changing the rules in force. Plus the denial counter auto mode
 * keeps. Everything goes through the `src/permissions/permissions.js` barrel,
 * except the counter, which callers import from its own module.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'

import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from 'src/permissions/denialTracking.js'
import {
  applyPermissionRulesToPermissionContext,
  createPermissionRequestMessage,
  deletePermissionRule,
  filterDeniedAgents,
  getAllowRules,
  getAskRuleForTool,
  getAskRules,
  getDenyRuleForAgent,
  getDenyRuleForTool,
  getDenyRules,
  getRuleByContentsForTool,
  getRuleByContentsForToolName,
  permissionRuleSourceDisplayString,
  syncPermissionRulesFromDisk,
  toolAlwaysAllowedRule,
} from 'src/permissions/permissions.js'
import type { PermissionDecisionReason, PermissionResult } from 'src/permissions/PermissionResult.js'
import type { PermissionRule, PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { permissionContext, standIn, useDecisionWorld } from 'src/permissions/__testutils__/decisionWorld.js'

const world = useDecisionWorld()

const ALL_SOURCES: PermissionRuleSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
  'cliArg',
  'command',
  'session',
]

const rule = (
  source: PermissionRuleSource,
  ruleBehavior: 'allow' | 'deny' | 'ask',
  toolName: string,
  ruleContent?: string,
): PermissionRule => ({
  source,
  ruleBehavior,
  ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent },
})

// ---------------------------------------------------------------------------
// Listing the rules
// ---------------------------------------------------------------------------

describe('listing the rules a session holds', () => {
  const ctx = permissionContext({
    alwaysAllowRules: { session: ['Peek'], userSettings: ['Bash(git status)', 'Scribe'], cliArg: ['mcp__forge'] },
    alwaysDenyRules: { policySettings: ['WebFetch(domain:evil.test)'], localSettings: ['KillShell'] },
    alwaysAskRules: { command: ['Bash(npm publish:*)'], flagSettings: ['Scribe()'], projectSettings: ['Bash(echo \\(x\\))'] },
  })

  test('allow rules come in source order, then in the order written, parsed', () => {
    expect(getAllowRules(ctx)).toEqual([
      rule('userSettings', 'allow', 'Bash', 'git status'),
      rule('userSettings', 'allow', 'Scribe'),
      rule('cliArg', 'allow', 'mcp__forge'),
      rule('session', 'allow', 'Peek'),
    ])
  })

  test('deny rules, with a retired tool name brought up to date', () => {
    expect(getDenyRules(ctx)).toEqual([
      rule('localSettings', 'deny', 'TaskStop'),
      rule('policySettings', 'deny', 'WebFetch', 'domain:evil.test'),
    ])
  })

  test('ask rules, with escaped parentheses read back and a bare () read as the whole tool', () => {
    expect(getAskRules(ctx)).toEqual([
      rule('projectSettings', 'ask', 'Bash', 'echo (x)'),
      rule('flagSettings', 'ask', 'Scribe'),
      rule('command', 'ask', 'Bash', 'npm publish:*'),
    ])
  })

  test('a context with no rules lists none', () => {
    const empty = permissionContext()
    expect([getAllowRules(empty), getDenyRules(empty), getAskRules(empty)]).toEqual([[], [], []])
  })

  test('the source order is the settings order, then CLI, command and session', () => {
    const everywhere = permissionContext({
      alwaysAllowRules: Object.fromEntries([...ALL_SOURCES].reverse().map(s => [s, ['Scribe']])),
    })
    expect(getAllowRules(everywhere).map(r => r.source)).toEqual(ALL_SOURCES)
  })
})

describe('finding the rule that covers a whole tool', () => {
  const finders = [
    ['allow', toolAlwaysAllowedRule, 'alwaysAllowRules'],
    ['deny', getDenyRuleForTool, 'alwaysDenyRules'],
    ['ask', getAskRuleForTool, 'alwaysAskRules'],
  ] as const

  const cases: Array<[string, { name: string; mcp?: { serverName: string; toolName: string } }, string, boolean]> = [
    ['a built-in by name', { name: 'Scribe' }, 'Scribe', true],
    ['a built-in by a content rule', { name: 'Scribe' }, 'Scribe(x)', false],
    ['a built-in by a lower-case name', { name: 'Scribe' }, 'scribe', false],
    ['an MCP tool by full name', { name: 'mcp__forge__deploy', mcp: { serverName: 'forge', toolName: 'deploy' } }, 'mcp__forge__deploy', true],
    ['an MCP tool by server', { name: 'mcp__forge__deploy', mcp: { serverName: 'forge', toolName: 'deploy' } }, 'mcp__forge', true],
    ['an MCP tool by server wildcard', { name: 'mcp__forge__deploy', mcp: { serverName: 'forge', toolName: 'deploy' } }, 'mcp__forge__*', true],
    ['an MCP tool by a sibling', { name: 'mcp__forge__deploy', mcp: { serverName: 'forge', toolName: 'deploy' } }, 'mcp__forge__build', false],
    ['an MCP tool by another server', { name: 'mcp__forge__deploy', mcp: { serverName: 'forge', toolName: 'deploy' } }, 'mcp__other', false],
    ['an MCP tool with a display name, by that name', { name: 'Write', mcp: { serverName: 'fs', toolName: 'Write' } }, 'Write', false],
    ['an MCP tool with a display name, by full name', { name: 'Write', mcp: { serverName: 'fs', toolName: 'Write' } }, 'mcp__fs__Write', true],
    ['an MCP-named tool with no server info, by server', { name: 'mcp__forge__deploy' }, 'mcp__forge', true],
    ['a built-in, by an MCP server rule', { name: 'Scribe' }, 'mcp__Scribe', false],
    ['a server rule with an empty server', { name: 'mcp__forge__deploy', mcp: { serverName: 'forge', toolName: 'deploy' } }, 'mcp__', false],
  ]

  for (const [behavior, find, key] of finders) {
    test(`the ${behavior} finder`, () => {
      const got = cases.map(([what, tool, ruleString]) => {
        const found = find(permissionContext({ [key]: { session: [ruleString] } }), standIn(tool))
        return [what, found !== null]
      })
      expect(got).toEqual(cases.map(([what, , , matches]) => [what, matches]))
    })
  }

  test('the rule found is the first in source order, whole', () => {
    const ctx = permissionContext({ alwaysDenyRules: { session: ['Scribe'], localSettings: ['mcp__x', 'Scribe'] } })
    expect(getDenyRuleForTool(ctx, standIn({ name: 'Scribe' }))).toEqual(rule('localSettings', 'deny', 'Scribe'))
  })

  test('each finder reads only its own kind', () => {
    const ctx = permissionContext({ alwaysAllowRules: { session: ['Scribe'] } })
    const tool = standIn({ name: 'Scribe' })
    expect([toolAlwaysAllowedRule(ctx, tool) !== null, getDenyRuleForTool(ctx, tool), getAskRuleForTool(ctx, tool)]).toEqual([
      true,
      null,
      null,
    ])
  })
})

describe('agent deny rules', () => {
  const ctx = permissionContext({
    alwaysDenyRules: { userSettings: ['Agent(Plan)', 'Agent(Explore)'], session: ['Task(general-purpose)', 'Bash(Plan)'] },
    alwaysAllowRules: { session: ['Agent(Reviewer)'] },
  })

  test('getDenyRuleForAgent finds Agent(type) rules only', () => {
    expect([
      getDenyRuleForAgent(ctx, 'Agent', 'Plan'),
      getDenyRuleForAgent(ctx, 'Agent', 'general-purpose'),
      getDenyRuleForAgent(ctx, 'Agent', 'Reviewer'),
      getDenyRuleForAgent(ctx, 'Agent', 'plan'),
      getDenyRuleForAgent(ctx, 'Bash', 'Plan'),
    ]).toEqual([
      rule('userSettings', 'deny', 'Agent', 'Plan'),
      rule('session', 'deny', 'Agent', 'general-purpose'),
      null,
      null,
      rule('session', 'deny', 'Bash', 'Plan'),
    ])
  })

  test('filterDeniedAgents drops the denied types and keeps the rest in order', () => {
    const agents = ['Explore', 'Reviewer', 'Plan', 'general-purpose', 'Explorer'].map(agentType => ({ agentType, extra: agentType.length }))
    expect(filterDeniedAgents(agents, ctx, 'Agent')).toEqual([
      { agentType: 'Reviewer', extra: 8 },
      { agentType: 'Explorer', extra: 8 },
    ])
  })

  test('a whole-tool Agent deny filters no agent by type', () => {
    const whole = permissionContext({ alwaysDenyRules: { session: ['Agent'] } })
    expect(filterDeniedAgents([{ agentType: 'Plan' }], whole, 'Agent')).toEqual([{ agentType: 'Plan' }])
    expect(getDenyRuleForAgent(whole, 'Agent', 'Plan')).toBeNull()
  })
})

describe('rules by content', () => {
  const ctx = permissionContext({
    alwaysAllowRules: {
      userSettings: ['Bash(npm test)', 'Bash(git:*)', 'Bash'],
      session: ['Bash(npm test)', 'WebFetch(domain:docs.test)', 'mcp__forge__deploy(prod)'],
    },
    alwaysDenyRules: { policySettings: ['Bash(rm -rf:*)'] },
    alwaysAskRules: { projectSettings: ['Bash(npm publish:*)'] },
  })

  test('maps each content to its rule, the later source winning a tie', () => {
    const allow = getRuleByContentsForToolName(ctx, 'Bash', 'allow')
    expect([...allow.entries()]).toEqual([
      ['npm test', rule('session', 'allow', 'Bash', 'npm test')],
      ['git:*', rule('userSettings', 'allow', 'Bash', 'git:*')],
    ])
  })

  test('reads only the kind asked for', () => {
    expect([...getRuleByContentsForToolName(ctx, 'Bash', 'deny').keys()]).toEqual(['rm -rf:*'])
    expect([...getRuleByContentsForToolName(ctx, 'Bash', 'ask').keys()]).toEqual(['npm publish:*'])
    expect(getRuleByContentsForToolName(ctx, 'Grep', 'allow').size).toBe(0)
  })

  test('an MCP tool is looked up by its full name', () => {
    const tool = standIn({ name: 'deploy', mcp: { serverName: 'forge', toolName: 'deploy' } })
    expect([...getRuleByContentsForTool(ctx, tool, 'allow').keys()]).toEqual(['prod'])
    expect([...getRuleByContentsForTool(ctx, standIn({ name: 'WebFetch' }), 'allow').keys()]).toEqual(['domain:docs.test'])
  })
})

test('each rule source has the name prompts show for it', () => {
  expect(ALL_SOURCES.map(s => [s, permissionRuleSourceDisplayString(s)])).toEqual([
    ['userSettings', 'user settings'],
    ['projectSettings', 'shared project settings'],
    ['localSettings', 'project local settings'],
    ['flagSettings', 'command line arguments'],
    ['policySettings', 'enterprise managed settings'],
    ['cliArg', 'CLI argument'],
    ['command', 'command configuration'],
    ['session', 'current session'],
  ])
})

// ---------------------------------------------------------------------------
// The request message
// ---------------------------------------------------------------------------

describe('createPermissionRequestMessage', () => {
  type Case = [string, string, PermissionDecisionReason | undefined, string[]]
  const ask = (message = 'm'): PermissionResult => ({ behavior: 'ask', message })
  const cases: Case[] = [
    ['no reason', 'Scribe', undefined, ['requested permissions to use Scribe', "haven't granted it yet"]],
    ['a hook with a reason', 'Bash', { type: 'hook', hookName: 'guard', reason: 'too risky' }, ["Hook 'guard'", 'blocked this action', ': too risky']],
    ['a hook without one', 'Bash', { type: 'hook', hookName: 'guard' }, ["Hook 'guard'", 'requires approval for this Bash command']],
    [
      'a rule',
      'Bash',
      { type: 'rule', rule: rule('projectSettings', 'ask', 'Bash', 'npm publish:*') },
      ["rule 'Bash(npm publish:*)'", 'from shared project settings', 'requires approval for this Bash command'],
    ],
    [
      'a rule whose content holds parentheses',
      'Bash',
      { type: 'rule', rule: rule('session', 'ask', 'Bash', 'python -c "print(1)"') },
      ["'Bash(python -c \"print\\(1\\)\")'", 'from current session'],
    ],
    ['a whole-tool rule', 'Scribe', { type: 'rule', rule: rule('cliArg', 'ask', 'Scribe') }, ["rule 'Scribe'", 'from CLI argument', 'Scribe command']],
    [
      'a permission prompt tool',
      'Scribe',
      { type: 'permissionPromptTool', permissionPromptToolName: 'mcp__gate__approve', toolResult: {} } as never,
      ["Tool 'mcp__gate__approve'", 'requires approval for this Scribe command'],
    ],
    ['a sandbox override', 'Bash', { type: 'sandboxOverride' } as never, ['outside of the sandbox']],
    ['a mode', 'Scribe', { type: 'mode', mode: 'acceptEdits' }, ['permission mode (Accept edits)', 'requires approval for this Scribe command']],
    ['a classifier, without the classifier build', 'Bash', { type: 'classifier', classifier: 'auto-mode', reason: 'r' }, ['requested permissions to use Bash']],
  ]
  test.each(cases)('%s', (_what, toolName, reason, facts) => {
    const message = createPermissionRequestMessage(toolName, reason)
    for (const fact of facts) expect(message).toContain(fact)
  })

  const verbatim: PermissionDecisionReason[] = [
    { type: 'workingDir', reason: 'outside the allowed directories' },
    { type: 'safetyCheck', reason: 'writes to .git/config', classifierApprovable: false },
    { type: 'other', reason: 'because the tool says so' },
    { type: 'asyncAgent', reason: 'no prompts here' },
  ]
  test.each(verbatim.map(r => [r.type, r] as const))('a %s reason is shown as it is', (_type, reason) => {
    expect(createPermissionRequestMessage('Scribe', reason)).toBe((reason as { reason: string }).reason)
  })

  test('each mode is named by its title', () => {
    const titles = (['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto'] as const).map(mode =>
      /\(([^)]*)\)/.exec(createPermissionRequestMessage('X', { type: 'mode', mode }))?.[1],
    )
    expect(titles).toEqual(['Default', 'Plan Mode', 'Accept edits', 'Bypass Permissions', "Don't Ask", 'Default'])
  })

  describe('a compound command', () => {
    const results = (entries: Array<[string, PermissionResult]>): PermissionDecisionReason => ({
      type: 'subcommandResults',
      reasons: new Map(entries),
    })

    type Compound = {
      what: string
      tool: string
      parts: Array<[string, PermissionResult]>
      shows: string[]
      hides: string[]
    }
    const compounds: Compound[] = [
      {
        what: 'only the parts still to approve are listed, redirections cut off',
        tool: 'Bash',
        parts: [
          ['ls', { behavior: 'allow', updatedInput: {} }],
          ['echo hi > out.txt', ask()],
          ['rm -rf build', { behavior: 'passthrough', message: 'p' }],
          ['cat secrets', { behavior: 'deny', message: 'd', decisionReason: { type: 'other', reason: 'd' } }],
        ],
        shows: ['This Bash command contains multiple operations', 'parts require approval: echo hi, rm -rf build'],
        hides: ['out.txt', 'cat secrets', 'ls,'],
      },
      {
        what: 'a single part is named in the singular',
        tool: 'Bash',
        parts: [['git push', ask()]],
        shows: [' part requires approval: git push'],
        hides: ['parts', 'require approval:'],
      },
      {
        what: 'a redirection glued to its target is cut too, a quoted one is not',
        tool: 'Bash',
        parts: [['echo a >b', ask()], ['echo "x > y"', ask()]],
        shows: [': echo a, echo "x > y"'],
        hides: ['>b'],
      },
      {
        what: 'another tool keeps its parts whole',
        tool: 'PowerShell',
        parts: [['echo hi > out.txt', ask()]],
        shows: ['This PowerShell command', ': echo hi > out.txt'],
        hides: [],
      },
      {
        what: 'nothing left to approve gives the message with no list',
        tool: 'Bash',
        parts: [['ls', { behavior: 'allow', updatedInput: {} }]],
        shows: ['multiple operations that require approval'],
        hides: [':'],
      },
    ]
    test.each(compounds.map(c => [c.what, c] as const))('%s', (_what, c) => {
      const message = createPermissionRequestMessage(c.tool, results(c.parts))
      expect({ shown: c.shows.filter(s => message.includes(s)), hidden: c.hides.filter(s => message.includes(s)) }).toEqual({
        shown: c.shows,
        hidden: [],
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Changing the rules in force
// ---------------------------------------------------------------------------

describe('deletePermissionRule', () => {
  const capture = () => {
    const calls: ToolPermissionContext[] = []
    return { calls, set: (ctx: ToolPermissionContext) => void calls.push(ctx) }
  }

  test.each(['policySettings', 'flagSettings', 'command'] as const)('refuses a rule from %s', async source => {
    const { calls, set } = capture()
    const initialContext = permissionContext({ alwaysAllowRules: { [source]: ['Scribe'] } })
    await expect(
      deletePermissionRule({ rule: rule(source, 'allow', 'Scribe'), initialContext, setToolPermissionContext: set }),
    ).rejects.toThrow(/read-only/)
    expect(calls).toEqual([])
  })

  const layers = [
    ['userSettings', 'user'],
    ['projectSettings', 'project'],
    ['localSettings', 'local'],
  ] as const
  test.each(layers)('removes a rule from %s, on disk and in the session', async (source, layer) => {
    const w = world()
    const file = w.settings(layer, {
      permissions: { allow: ['Scribe', 'Peek'], deny: ['Scribe'], defaultMode: 'default' },
      model: 'kept-as-is',
    })
    const { calls, set } = capture()
    const initialContext = permissionContext({
      alwaysAllowRules: { [source]: ['Scribe', 'Peek'], session: ['Scribe'] },
      alwaysDenyRules: { [source]: ['Scribe'] },
    })
    await deletePermissionRule({ rule: rule(source, 'allow', 'Scribe'), initialContext, setToolPermissionContext: set })
    const disk = JSON.parse(readFileSync(file, 'utf8'))
    expect(disk).toEqual({ permissions: { allow: ['Peek'], deny: ['Scribe'], defaultMode: 'default' }, model: 'kept-as-is' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.alwaysAllowRules).toEqual({ [source]: ['Peek'], session: ['Scribe'] })
    expect(calls[0]?.alwaysDenyRules).toEqual({ [source]: ['Scribe'] })
    expect(initialContext.alwaysAllowRules[source]).toEqual(['Scribe', 'Peek'])
  })

  test('matches an entry on disk written under a retired tool name, and a content rule', async () => {
    const w = world()
    const file = w.settings('user', { permissions: { deny: ['KillShell', 'Bash(rm -rf:*)', 'Bash'] } })
    const { set } = capture()
    const initialContext = permissionContext({ alwaysDenyRules: { userSettings: ['TaskStop', 'Bash(rm -rf:*)', 'Bash'] } })
    await deletePermissionRule({ rule: rule('userSettings', 'deny', 'TaskStop'), initialContext, setToolPermissionContext: set })
    await deletePermissionRule({ rule: rule('userSettings', 'deny', 'Bash', 'rm -rf:*'), initialContext, setToolPermissionContext: set })
    expect(JSON.parse(readFileSync(file, 'utf8')).permissions.deny).toEqual(['Bash'])
  })

  test.each(['cliArg', 'session'] as const)('removes a %s rule from the session only', async source => {
    const w = world()
    const file = w.settings('user', { permissions: { ask: ['Scribe'] } })
    const before = statSync(file).mtimeMs
    const { calls, set } = capture()
    const initialContext = permissionContext({ alwaysAskRules: { [source]: ['Scribe', 'Peek'], userSettings: ['Scribe'] } })
    await deletePermissionRule({ rule: rule(source, 'ask', 'Scribe'), initialContext, setToolPermissionContext: set })
    expect(calls[0]?.alwaysAskRules).toEqual({ [source]: ['Peek'], userSettings: ['Scribe'] })
    expect([JSON.parse(readFileSync(file, 'utf8')), statSync(file).mtimeMs]).toEqual([{ permissions: { ask: ['Scribe'] } }, before])
  })

  test('a rule missing from disk still leaves the session', async () => {
    const w = world()
    const file = w.settings('project', { permissions: { allow: ['Peek'] } })
    const { calls, set } = capture()
    await deletePermissionRule({
      rule: rule('projectSettings', 'allow', 'Scribe'),
      initialContext: permissionContext({ alwaysAllowRules: { projectSettings: ['Scribe'] } }),
      setToolPermissionContext: set,
    })
    expect([calls[0]?.alwaysAllowRules, JSON.parse(readFileSync(file, 'utf8'))]).toEqual([
      { projectSettings: [] },
      { permissions: { allow: ['Peek'] } },
    ])
  })
})

describe('applyPermissionRulesToPermissionContext', () => {
  test('appends each rule to its source and kind, after what is there', () => {
    const before = permissionContext({
      mode: 'acceptEdits',
      alwaysAllowRules: { userSettings: ['Peek'] },
      alwaysDenyRules: { session: ['Scribe'] },
    })
    const after = applyPermissionRulesToPermissionContext(before, [
      rule('userSettings', 'allow', 'Bash', 'git status'),
      rule('session', 'ask', 'Scribe'),
      rule('userSettings', 'allow', 'mcp__forge'),
      rule('cliArg', 'deny', 'Bash', 'echo (x)'),
      rule('session', 'deny', 'Peek'),
    ])
    expect([after.mode, after.alwaysAllowRules, after.alwaysDenyRules, after.alwaysAskRules]).toEqual([
      'acceptEdits',
      { userSettings: ['Peek', 'Bash(git status)', 'mcp__forge'] },
      { session: ['Scribe', 'Peek'], cliArg: ['Bash(echo \\(x\\))'] },
      { session: ['Scribe'] },
    ])
    expect(before.alwaysAllowRules).toEqual({ userSettings: ['Peek'] })
  })

  test('no rules leave the context as it was', () => {
    const before = permissionContext({ alwaysAllowRules: { session: ['Peek'] } })
    expect(applyPermissionRulesToPermissionContext(before, [])).toEqual(before)
  })
})

describe('syncPermissionRulesFromDisk', () => {
  const held = () =>
    permissionContext({
      alwaysAllowRules: {
        userSettings: ['Old'],
        projectSettings: ['Old'],
        localSettings: ['Old'],
        flagSettings: ['Flag'],
        policySettings: ['Policy'],
        cliArg: ['Cli'],
        command: ['Cmd'],
        session: ['Sess'],
      },
      alwaysDenyRules: { userSettings: ['OldDeny'], session: ['SessDeny'] },
      alwaysAskRules: { localSettings: ['OldAsk'], cliArg: ['CliAsk'] },
    })

  test('replaces the three settings files wholesale and leaves the other sources alone', () => {
    const before = held()
    const after = syncPermissionRulesFromDisk(before, [
      rule('userSettings', 'allow', 'New'),
      rule('projectSettings', 'deny', 'Bash', 'curl:*'),
      rule('userSettings', 'allow', 'Newer'),
    ])
    const empty = { userSettings: [], projectSettings: [], localSettings: [] }
    expect([after.alwaysAllowRules, after.alwaysDenyRules, after.alwaysAskRules]).toEqual([
      {
        ...empty,
        userSettings: ['New', 'Newer'],
        flagSettings: ['Flag'],
        policySettings: ['Policy'],
        cliArg: ['Cli'],
        command: ['Cmd'],
        session: ['Sess'],
      },
      { ...empty, projectSettings: ['Bash(curl:*)'], session: ['SessDeny'] },
      { ...empty, cliArg: ['CliAsk'] },
    ])
    expect(before.alwaysAllowRules.userSettings).toEqual(['Old'])
  })

  test('rules from other sources in the list replace those sources too', () => {
    const after = syncPermissionRulesFromDisk(held(), [rule('policySettings', 'allow', 'P2'), rule('flagSettings', 'allow', 'F2')])
    expect([after.alwaysAllowRules.policySettings, after.alwaysAllowRules.flagSettings, after.alwaysAllowRules.cliArg]).toEqual([
      ['P2'],
      ['F2'],
      ['Cli'],
    ])
  })

  test('when policy allows managed rules only, the CLI and session rules go as well', () => {
    world().settings('policy', { allowManagedPermissionRulesOnly: true })
    const after = syncPermissionRulesFromDisk(held(), [rule('policySettings', 'deny', 'Bash')])
    const cleared = { userSettings: [], projectSettings: [], localSettings: [], cliArg: [], session: [] }
    // What happens to flagSettings here is left open on purpose: see the spec's findings.
    const { flagSettings: _flag, ...allowed } = after.alwaysAllowRules
    expect([allowed, after.alwaysDenyRules, after.alwaysAskRules]).toEqual([
      { ...cleared, policySettings: ['Policy'], command: ['Cmd'] },
      { ...cleared, policySettings: ['Bash'] },
      cleared,
    ])
  })

  test('a policy that does not set the switch changes nothing for the CLI and session', () => {
    world().settings('policy', { allowManagedPermissionRulesOnly: false })
    const after = syncPermissionRulesFromDisk(held(), [])
    expect([after.alwaysAllowRules.cliArg, after.alwaysAllowRules.session]).toEqual([['Cli'], ['Sess']])
  })
})

// ---------------------------------------------------------------------------
// The denial counter
// ---------------------------------------------------------------------------

describe('denial tracking', () => {
  test('the limits are three in a row and twenty in all', () => {
    expect(DENIAL_LIMITS).toEqual({ maxConsecutive: 3, maxTotal: 20 })
  })

  test('a fresh state counts nothing, and each call gives a new one', () => {
    const a = createDenialTrackingState()
    expect(a).toEqual({ consecutiveDenials: 0, totalDenials: 0 })
    expect(createDenialTrackingState()).not.toBe(a)
  })

  test('a denial counts in both, without touching the state it was given', () => {
    const start = { consecutiveDenials: 2, totalDenials: 7 }
    expect([recordDenial(start), start]).toEqual([{ consecutiveDenials: 3, totalDenials: 8 }, { consecutiveDenials: 2, totalDenials: 7 }])
  })

  test('a success ends the streak and keeps the total; with no streak it hands back the same state', () => {
    const streak = { consecutiveDenials: 2, totalDenials: 9 }
    const calm = { consecutiveDenials: 0, totalDenials: 9 }
    expect(recordSuccess(streak)).toEqual(calm)
    expect(recordSuccess(streak)).not.toBe(streak)
    expect(recordSuccess(calm)).toBe(calm)
  })

  const fallback: Array<[number, number, boolean]> = [
    [0, 0, false],
    [2, 19, false],
    [3, 3, true],
    [5, 5, true],
    [0, 20, true],
    [1, 25, true],
  ]
  test.each(fallback)('%p in a row and %p in all: fall back to prompting is %p', (consecutiveDenials, totalDenials, expected) => {
    expect(shouldFallbackToPrompting({ consecutiveDenials, totalDenials })).toBe(expected)
  })

  test('three denials in a row reach the limit, a success in between does not', () => {
    let s = createDenialTrackingState()
    s = recordSuccess(recordDenial(recordDenial(s)))
    s = recordDenial(recordDenial(s))
    const beforeThird = shouldFallbackToPrompting(s)
    s = recordDenial(s)
    expect([beforeThird, shouldFallbackToPrompting(s), s]).toEqual([false, true, { consecutiveDenials: 3, totalDenials: 5 }])
  })
})
