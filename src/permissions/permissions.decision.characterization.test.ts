/**
 * The permission decision, as the agent loop asks for it: a tool, its input,
 * and the session's permission state go in; allow, ask or deny comes out.
 *
 * This file runs under plain `bun test`, where the auto-mode build flags are
 * off. What changes with them on lives in
 * `permissions.autoMode.characterization.test.ts`, which runs itself in a
 * child process with the flags set.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

import { getPlanFilePath } from 'src/agent/plans/plans.js'
import { AUTO_REJECT_MESSAGE, DONT_ASK_REJECT_MESSAGE } from 'src/agent/messages/messages.js'
import {
  checkRuleBasedPermissions,
  hasPermissionsToUseTool,
  planModeDefersToClassifier,
} from 'src/permissions/permissions.js'
import type { PermissionDecision, PermissionResult } from 'src/permissions/PermissionResult.js'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import { AbortError } from 'src/shared/errors.js'
import type { Tool } from 'src/tools/Tool.js'
import {
  ASSISTANT_TURN,
  makeCtx,
  messageOf,
  standIn,
  useDecisionWorld,
  type ContextSpec,
  type StandIn,
} from 'src/permissions/__testutils__/decisionWorld.js'

const world = useDecisionWorld()

const SOURCES: PermissionRuleSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
  'cliArg',
  'command',
  'session',
]
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'] as const
type Mode = (typeof MODES)[number]
type Kind = 'allow' | 'deny' | 'ask'

const decide = (tool: Tool, input: Record<string, unknown>, spec: ContextSpec = {}) =>
  hasPermissionsToUseTool(tool, input, makeCtx(spec), ASSISTANT_TURN, 'toolu_decision_suite')

/** The parts of a decision a caller branches on. */
function gist(d: PermissionDecision | PermissionResult | null) {
  if (d === null) return null
  return {
    behavior: d.behavior,
    reason: d.decisionReason ?? null,
    ...(d.behavior === 'allow' ? { input: d.updatedInput } : {}),
  }
}

const rulesFor = (kind: Kind, source: PermissionRuleSource, rule: string) => ({
  [kind === 'allow' ? 'alwaysAllowRules' : kind === 'deny' ? 'alwaysDenyRules' : 'alwaysAskRules']: {
    [source]: [rule],
  },
})

// ---------------------------------------------------------------------------
// The whole-tool rule matrix
// ---------------------------------------------------------------------------

type Subject = { label: string; tool: StandIn; rule: string; readOnly: boolean }

const subjects = (): Subject[] => [
  { label: 'a writing tool', tool: standIn({ name: 'Scribe' }), rule: 'Scribe', readOnly: false },
  { label: 'a reading tool', tool: standIn({ name: 'Peek', readOnly: true }), rule: 'Peek', readOnly: true },
  {
    label: 'an MCP tool',
    tool: standIn({ name: 'mcp__forge__deploy', mcp: { serverName: 'forge', toolName: 'deploy' } }),
    rule: 'mcp__forge__deploy',
    readOnly: false,
  },
]

const INPUT = { file_path: '/work/notes.txt' }

/** What the decision must be, written out case by case. */
function expected(kind: Kind | null, source: PermissionRuleSource, mode: Mode, s: Subject) {
  const rule = kind && { source, ruleBehavior: kind, ruleValue: { toolName: s.rule } }
  const planGate = { behavior: 'deny', reason: { type: 'mode', mode: 'plan' } }
  const dontAsk = { behavior: 'deny', reason: { type: 'mode', mode: 'dontAsk' } }
  if (kind === 'deny') return { behavior: 'deny', reason: { type: 'rule', rule } }
  if (kind === 'ask') return mode === 'dontAsk' ? dontAsk : { behavior: 'ask', reason: { type: 'rule', rule } }
  if (mode === 'plan' && !s.readOnly) return planGate
  if (mode === 'bypassPermissions') {
    return { behavior: 'allow', reason: { type: 'mode', mode: 'bypassPermissions' }, input: INPUT }
  }
  if (kind === 'allow') return { behavior: 'allow', reason: { type: 'rule', rule }, input: INPUT }
  if (mode === 'dontAsk') return dontAsk
  return { behavior: 'ask', reason: null }
}

describe('a whole-tool rule, by source, kind, mode and tool', () => {
  for (const kind of ['allow', 'deny', 'ask'] as const) {
    for (const source of SOURCES) {
      test(`${kind} from ${source}`, async () => {
        const got: Array<[string, unknown]> = []
        const want: Array<[string, unknown]> = []
        for (const mode of MODES) {
          for (const s of subjects()) {
            const label = `${s.label} in ${mode}`
            const d = await decide(s.tool, INPUT, { permissions: { mode, ...rulesFor(kind, source, s.rule) } })
            got.push([label, gist(d)])
            want.push([label, expected(kind, source, mode, s)])
          }
        }
        expect(got).toEqual(want)
      })
    }
  }

  test('no rule at all', async () => {
    const got: Array<[string, unknown]> = []
    const want: Array<[string, unknown]> = []
    for (const mode of MODES) {
      for (const s of subjects()) {
        got.push([`${s.label} in ${mode}`, gist(await decide(s.tool, INPUT, { permissions: { mode } }))])
        want.push([`${s.label} in ${mode}`, expected(null, 'session', mode, s)])
      }
    }
    expect(got).toEqual(want)
  })
})

describe('rule precedence', () => {
  const tool = () => standIn({ name: 'Scribe', readOnly: true })

  test('deny wins over ask and allow, whatever their sources', async () => {
    const d = await decide(tool(), {}, {
      permissions: {
        alwaysAllowRules: { policySettings: ['Scribe'] },
        alwaysAskRules: { userSettings: ['Scribe'] },
        alwaysDenyRules: { session: ['Scribe'] },
      },
    })
    expect(gist(d)).toEqual({
      behavior: 'deny',
      reason: { type: 'rule', rule: { source: 'session', ruleBehavior: 'deny', ruleValue: { toolName: 'Scribe' } } },
    })
  })

  test('ask wins over allow', async () => {
    const d = await decide(tool(), {}, {
      permissions: { alwaysAllowRules: { userSettings: ['Scribe'] }, alwaysAskRules: { session: ['Scribe'] } },
    })
    expect(d.behavior).toBe('ask')
  })

  test('when several sources hold the rule, the one reported follows the source order', async () => {
    const reported: string[] = []
    for (let i = 0; i < SOURCES.length; i++) {
      const held = Object.fromEntries(SOURCES.slice(i).map(source => [source, ['Scribe']]))
      for (const kind of ['allow', 'deny', 'ask'] as const) {
        const key = kind === 'allow' ? 'alwaysAllowRules' : kind === 'deny' ? 'alwaysDenyRules' : 'alwaysAskRules'
        const d = await decide(tool(), {}, { permissions: { [key]: held } })
        const reason = d.decisionReason
        reported.push(`${kind}:${reason?.type === 'rule' ? reason.rule.source : 'none'}`)
      }
    }
    expect(reported).toEqual(SOURCES.flatMap(source => [`allow:${source}`, `deny:${source}`, `ask:${source}`]))
  })

  const shapes: Array<[string, string, boolean]> = [
    ['a bare name', 'Scribe', true],
    ['empty parentheses', 'Scribe()', true],
    ['a lone wildcard in parentheses', 'Scribe(*)', true],
    ['content in parentheses', 'Scribe(notes.txt)', false],
    ['another case', 'scribe', false],
    ['a longer name', 'Scribes', false],
    ['a prefix of the name', 'Scrib', false],
  ]
  test.each(shapes)('a deny rule written as %s', async (_what, rule, denies) => {
    const d = await decide(standIn({ name: 'Scribe', readOnly: true }), {}, { permissions: { alwaysDenyRules: { session: [rule] } } })
    expect(d.behavior).toBe(denies ? 'deny' : 'ask')
  })

  const legacy: Array<[string, string]> = [
    ['KillShell', 'TaskStop'],
    ['Task', 'Agent'],
    ['BashOutputTool', 'TaskOutput'],
  ]
  test.each(legacy)('a rule naming the retired %s applies to %s', async (oldName, current) => {
    const d = await decide(standIn({ name: current, readOnly: true }), {}, { permissions: { alwaysDenyRules: { userSettings: [oldName] } } })
    expect(gist(d)).toEqual({
      behavior: 'deny',
      reason: { type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'deny', ruleValue: { toolName: current } } },
    })
  })
})

describe('MCP tools', () => {
  const deploy = () => standIn({ name: 'mcp__forge__deploy', mcp: { serverName: 'forge', toolName: 'deploy' } })

  const denyCases: Array<[string, string, boolean]> = [
    ['the full tool name', 'mcp__forge__deploy', true],
    ['the server alone', 'mcp__forge', true],
    ['every tool of the server', 'mcp__forge__*', true],
    ['another tool of the server', 'mcp__forge__build', false],
    ['another server', 'mcp__smithy', false],
    ['another server, every tool', 'mcp__smithy__*', false],
    ['a server-name prefix', 'mcp__for', false],
    ['a glob on the server name', 'mcp__forge*', false],
    ['the tool with content', 'mcp__forge__deploy(prod)', false],
    ['the server with content', 'mcp__forge(prod)', false],
    ['the bare display name', 'deploy', false],
  ]
  test.each(denyCases)('a deny rule naming %s', async (_what, rule, denies) => {
    const d = await decide(deploy(), {}, { permissions: { alwaysDenyRules: { projectSettings: [rule] } } })
    expect(d.behavior).toBe(denies ? 'deny' : 'ask')
  })

  test('a server-level allow lets every tool of that server run, and no other', async () => {
    const got: unknown[] = []
    for (const [server, toolName] of [['forge', 'deploy'], ['forge', 'rollback'], ['smithy', 'deploy']] as const) {
      const tool = standIn({ name: `mcp__${server}__${toolName}`, mcp: { serverName: server, toolName } })
      got.push(gist(await decide(tool, {}, { permissions: { alwaysAllowRules: { localSettings: ['mcp__forge'] } } }))?.behavior)
    }
    expect(got).toEqual(['allow', 'allow', 'ask'])
  })

  test('a server-level ask rule asks for each tool of the server', async () => {
    const d = await decide(deploy(), {}, { permissions: { mode: 'bypassPermissions', alwaysAskRules: { userSettings: ['mcp__forge__*'] } } })
    expect(gist(d)).toEqual({
      behavior: 'ask',
      reason: {
        type: 'rule',
        rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'mcp__forge__*' } },
      },
    })
  })

  test('an MCP tool shown under a built-in name is matched by its full name only', async () => {
    const shadow = standIn({ name: 'Write', mcp: { serverName: 'files', toolName: 'Write' } })
    const byDisplay = await decide(shadow, {}, { permissions: { alwaysDenyRules: { userSettings: ['Write'] } } })
    const byFull = await decide(shadow, {}, { permissions: { alwaysDenyRules: { userSettings: ['mcp__files__Write'] } } })
    expect([byDisplay.behavior, byFull.behavior]).toEqual(['ask', 'deny'])
  })

  test('the full name is built from the normalized server and tool names', async () => {
    const odd = standIn({ name: 'mcp__my_srv__do_it', mcp: { serverName: 'my srv', toolName: 'do.it' } })
    const got: unknown[] = []
    for (const rule of ['mcp__my_srv__do_it', 'mcp__my_srv', 'mcp__my srv__do.it']) {
      got.push((await decide(odd, {}, { permissions: { alwaysDenyRules: { session: [rule] } } })).behavior)
    }
    expect(got).toEqual(['deny', 'deny', 'ask'])
  })

  test('a server whose name holds a double underscore is matched as the part before it', async () => {
    const tool = standIn({ name: 'mcp__team__a__ship', mcp: { serverName: 'team__a', toolName: 'ship' } })
    const got: unknown[] = []
    for (const rule of ['mcp__team__a', 'mcp__team', 'mcp__team__a__ship', 'mcp__team__a__*']) {
      got.push([rule, (await decide(tool, {}, { permissions: { alwaysDenyRules: { session: [rule] } } })).behavior])
    }
    expect(got).toEqual([
      ['mcp__team__a', 'ask'],
      ['mcp__team', 'deny'],
      ['mcp__team__a__ship', 'deny'],
      ['mcp__team__a__*', 'ask'],
    ])
  })
})

// ---------------------------------------------------------------------------
// The tool's own verdict
// ---------------------------------------------------------------------------

describe("what the tool's own check says", () => {
  const toolDeny: PermissionResult = {
    behavior: 'deny',
    message: 'blocked by the tool',
    decisionReason: { type: 'other', reason: 'tool says no' },
  }
  const contentAsk: PermissionResult = {
    behavior: 'ask',
    message: 'content rule asks',
    decisionReason: {
      type: 'rule',
      rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'Scribe', ruleContent: 'publish:*' } },
    },
  }
  const safetyAsk: PermissionResult = {
    behavior: 'ask',
    message: 'touches a protected path',
    decisionReason: { type: 'safetyCheck', reason: 'protected path', classifierApprovable: false },
  }
  const plainAsk: PermissionResult = {
    behavior: 'ask',
    message: 'the tool wants a yes',
    decisionReason: { type: 'other', reason: 'outside the project' },
  }
  const allowRewritten: PermissionResult = {
    behavior: 'allow',
    updatedInput: { file_path: '/work/normalized.txt' },
    decisionReason: { type: 'other', reason: 'inside the project' },
  }

  test('a tool deny stands in every mode, the same object handed back', async () => {
    const got: unknown[] = []
    for (const mode of MODES.filter(m => m !== 'plan')) {
      got.push([mode, await decide(standIn({ name: 'Scribe', verdict: toolDeny }), INPUT, { permissions: { mode } })])
    }
    expect(got).toEqual(MODES.filter(m => m !== 'plan').map(mode => [mode, toolDeny]))
  })

  test('a content ask rule and a safety check stand even in bypass mode', async () => {
    const got: unknown[] = []
    for (const verdict of [contentAsk, safetyAsk]) {
      for (const mode of ['bypassPermissions', 'default', 'acceptEdits'] as const) {
        got.push(await decide(standIn({ name: 'Scribe', verdict }), INPUT, { permissions: { mode } }))
      }
    }
    expect(got).toEqual([contentAsk, contentAsk, contentAsk, safetyAsk, safetyAsk, safetyAsk])
  })

  test('a tool that needs the user keeps its ask in bypass mode, but not its allow', async () => {
    const asks = await decide(standIn({ name: 'Scribe', needsUser: true, verdict: plainAsk }), INPUT, {
      permissions: { mode: 'bypassPermissions' },
    })
    const allows = await decide(standIn({ name: 'Scribe', needsUser: true, verdict: allowRewritten }), INPUT, {
      permissions: { mode: 'bypassPermissions' },
    })
    expect([asks, gist(allows)]).toEqual([
      plainAsk,
      { behavior: 'allow', reason: { type: 'mode', mode: 'bypassPermissions' }, input: allowRewritten.updatedInput },
    ])
  })

  test('any other ask gives way to bypass mode and to an allow rule, keeping the input', async () => {
    const tool = () => standIn({ name: 'Scribe', verdict: plainAsk })
    const bypass = await decide(tool(), INPUT, { permissions: { mode: 'bypassPermissions' } })
    const ruled = await decide(tool(), INPUT, { permissions: { alwaysAllowRules: { cliArg: ['Scribe'] } } })
    const plain = await decide(tool(), INPUT)
    expect([gist(bypass), gist(ruled), plain]).toEqual([
      { behavior: 'allow', reason: { type: 'mode', mode: 'bypassPermissions' }, input: INPUT },
      {
        behavior: 'allow',
        reason: { type: 'rule', rule: { source: 'cliArg', ruleBehavior: 'allow', ruleValue: { toolName: 'Scribe' } } },
        input: INPUT,
      },
      plainAsk,
    ])
  })

  test("the tool's rewritten input is what an allow carries", async () => {
    const tool = () => standIn({ name: 'Scribe', verdict: allowRewritten })
    const plain = await decide(tool(), INPUT)
    const bypass = await decide(tool(), INPUT, { permissions: { mode: 'bypassPermissions' } })
    const ruled = await decide(tool(), INPUT, { permissions: { alwaysAllowRules: { session: ['Scribe'] } } })
    expect([plain, gist(bypass)?.input, gist(ruled)?.input]).toEqual([
      allowRewritten,
      allowRewritten.updatedInput,
      allowRewritten.updatedInput,
    ])
  })

  test('an allow without a rewritten input carries the input it was given', async () => {
    const d = await decide(standIn({ name: 'Scribe', verdict: { behavior: 'allow' } as PermissionResult }), INPUT, {
      permissions: { mode: 'bypassPermissions' },
    })
    expect(gist(d)?.input).toEqual(INPUT)
  })

  test('a passthrough with a reason becomes an ask whose message explains that reason', async () => {
    const d = await decide(
      standIn({
        name: 'Scribe',
        verdict: {
          behavior: 'passthrough',
          message: 'ignored',
          decisionReason: { type: 'workingDir', reason: 'Scribe wants to write outside the project' },
          suggestions: [{ type: 'addDirectories', directories: ['/elsewhere'], destination: 'session' }],
        },
      }),
      INPUT,
    )
    expect(d).toEqual({
      behavior: 'ask',
      message: 'Scribe wants to write outside the project',
      decisionReason: { type: 'workingDir', reason: 'Scribe wants to write outside the project' },
      suggestions: [{ type: 'addDirectories', directories: ['/elsewhere'], destination: 'session' }],
    })
  })

  test('a plain passthrough becomes an ask that names the tool', async () => {
    const d = await decide(standIn({ name: 'Scribe' }), INPUT)
    expect(d.behavior).toBe('ask')
    expect(d.decisionReason).toBeUndefined()
    expect(messageOf(d)).toContain('permissions to use Scribe')
    expect(messageOf(d)).toContain("haven't granted it yet")
  })

  test('the tool is asked with the parsed input and the live context', async () => {
    const seen: unknown[] = []
    const tool = standIn({
      name: 'Scribe',
      verdict: input => {
        seen.push(input)
        return { behavior: 'passthrough', message: '' }
      },
    })
    await decide(tool, { file_path: '/a', extra: 1 }, { permissions: { mode: 'acceptEdits' } })
    expect([seen, tool.seenModes]).toEqual([[{ file_path: '/a', extra: 1 }], ['acceptEdits']])
  })

  test('input the tool schema rejects is never shown to the tool, and is asked about', async () => {
    const tool = standIn({ name: 'Scribe', verdict: allowRewritten })
    const d = await decide(tool, { file_path: 42 })
    expect([d.behavior, d.decisionReason, tool.seenModes]).toEqual(['ask', undefined, []])
    expect(messageOf(d)).toContain('Scribe')
  })

  test('a tool check that fails is treated as no opinion', async () => {
    const tool = standIn({
      name: 'Scribe',
      verdict: () => {
        throw new Error('checker exploded')
      },
    })
    const plain = await decide(tool, INPUT)
    const bypass = await decide(tool, INPUT, { permissions: { mode: 'bypassPermissions' } })
    const ruled = await decide(tool, INPUT, { permissions: { alwaysDenyRules: { session: ['Scribe'] } } })
    expect([plain.behavior, bypass.behavior, ruled.behavior]).toEqual(['ask', 'allow', 'deny'])
  })

  test('a tool check that was aborted aborts the decision', async () => {
    const tool = standIn({
      name: 'Scribe',
      verdict: () => {
        throw new AbortError('user pressed escape')
      },
    })
    await expect(decide(tool, INPUT, { permissions: { mode: 'bypassPermissions' } })).rejects.toBeInstanceOf(AbortError)
  })

  test('a decision asked for after the turn was aborted fails at once, without asking the tool', async () => {
    const abort = new AbortController()
    abort.abort()
    const tool = standIn({ name: 'Scribe', verdict: allowRewritten })
    let caught: unknown
    try {
      await decide(tool, INPUT, { abort, permissions: { mode: 'bypassPermissions' } })
    } catch (error) {
      caught = error
    }
    expect([caught instanceof AbortError, tool.seenModes]).toEqual([true, []])
  })
})

// ---------------------------------------------------------------------------
// Plan mode
// ---------------------------------------------------------------------------

describe('plan mode', () => {
  const plan = (extra: ContextSpec['permissions'] = {}) => ({ permissions: { mode: 'plan' as const, ...extra } })

  test('a call that is not read-only is refused, and told which file it may edit', async () => {
    const forAgent = await decide(standIn({ name: 'Scribe' }), INPUT, { ...plan(), agentId: 'planner-7' })
    expect(gist(forAgent)).toEqual({ behavior: 'deny', reason: { type: 'mode', mode: 'plan' } })
    const message = messageOf(forAgent) ?? ''
    for (const fact of ['Plan mode', 'Scribe', 'not read-only', 'ExitPlanMode', `(${getPlanFilePath('planner-7' as never)})`]) {
      expect(message).toContain(fact)
    }
    expect(message).toContain('planner-7')
  })

  const escapes: Array<[string, () => StandIn, ContextSpec['permissions']]> = [
    ['a read-only call', () => standIn({ name: 'Scribe', readOnly: true }), {}],
    ['ExitPlanMode itself', () => standIn({ name: 'ExitPlanMode' }), {}],
    [
      'a call the tool already allows (the plan file)',
      () => standIn({ name: 'Scribe', verdict: { behavior: 'allow', updatedInput: INPUT } }),
      {},
    ],
  ]
  test.each(escapes)('%s is not refused by plan mode', async (_what, make, extra) => {
    const d = await decide(make(), INPUT, plan(extra))
    expect(d.decisionReason).not.toEqual({ type: 'mode', mode: 'plan' })
  })

  test('a session that started in bypass mode skips the gate and is allowed', async () => {
    const d = await decide(standIn({ name: 'Scribe' }), INPUT, plan({ isBypassPermissionsModeAvailable: true }))
    expect(gist(d)).toEqual({ behavior: 'allow', reason: { type: 'mode', mode: 'plan' }, input: INPUT })
  })

  test('the gate comes before the tool deny, a content ask, a safety check and an allow rule', async () => {
    const verdicts: PermissionResult[] = [
      { behavior: 'deny', message: 'x', decisionReason: { type: 'other', reason: 'x' } },
      {
        behavior: 'ask',
        message: 'x',
        decisionReason: { type: 'rule', rule: { source: 'session', ruleBehavior: 'ask', ruleValue: { toolName: 'Scribe', ruleContent: 'a' } } },
      },
      { behavior: 'ask', message: 'x', decisionReason: { type: 'safetyCheck', reason: 'x', classifierApprovable: false } },
    ]
    const got: unknown[] = []
    for (const verdict of verdicts) got.push(gist(await decide(standIn({ name: 'Scribe', verdict }), INPUT, plan()))?.reason)
    got.push(gist(await decide(standIn({ name: 'Scribe' }), INPUT, plan({ alwaysAllowRules: { userSettings: ['Scribe'] } })))?.reason)
    expect(got).toEqual(Array(4).fill({ type: 'mode', mode: 'plan' }))
  })

  test('a whole-tool deny or ask rule still speaks first', async () => {
    const denied = await decide(standIn({ name: 'Scribe' }), INPUT, plan({ alwaysDenyRules: { session: ['Scribe'] } }))
    const asked = await decide(standIn({ name: 'Scribe' }), INPUT, plan({ alwaysAskRules: { session: ['Scribe'] } }))
    expect([gist(denied)?.reason?.type, gist(asked)?.behavior, gist(asked)?.reason?.type]).toEqual(['rule', 'ask', 'rule'])
  })

  test('a read-only check that fails counts as a write', async () => {
    const tool = standIn({
      name: 'Scribe',
      readOnly: () => {
        throw new Error('cannot tell')
      },
    })
    expect(gist(await decide(tool, INPUT, plan()))?.reason).toEqual({ type: 'mode', mode: 'plan' })
  })

  test('read-only is judged on the parsed input', async () => {
    const tool = standIn({ name: 'Scribe', readOnly: input => input.file_path === '/read/me' })
    const reading = await decide(tool, { file_path: '/read/me' }, plan())
    const writing = await decide(tool, { file_path: '/write/me' }, plan())
    expect([reading.behavior, writing.behavior]).toEqual(['ask', 'deny'])
  })

  test('without the auto-mode build, Bash gets the same refusal', async () => {
    const d = await decide(standIn({ name: 'Bash' }), { command: 'rm -rf build' }, plan())
    expect(gist(d)?.reason).toEqual({ type: 'mode', mode: 'plan' })
  })

  const deferral: Array<[string, boolean, boolean]> = [
    ['Bash', true, true],
    ['Bash', false, false],
    ['Write', true, false],
    ['Edit', true, false],
    ['PowerShell', true, false],
    ['bash', true, false],
  ]
  test.each(deferral)('planModeDefersToClassifier(%p, auto %p) is %p', (name, active, defers) => {
    expect(planModeDefersToClassifier(name, active)).toBe(defers)
  })
})

// ---------------------------------------------------------------------------
// dontAsk, auto (flags off) and headless sessions
// ---------------------------------------------------------------------------

describe("dontAsk mode turns every ask into a deny", () => {
  const asks: Array<[string, () => StandIn, ContextSpec['permissions']]> = [
    ['a plain passthrough', () => standIn({ name: 'Scribe' }), {}],
    ['a whole-tool ask rule', () => standIn({ name: 'Scribe' }), { alwaysAskRules: { policySettings: ['Scribe'] } }],
    [
      'a safety check',
      () => standIn({ name: 'Scribe', verdict: { behavior: 'ask', message: 'm', decisionReason: { type: 'safetyCheck', reason: 'r', classifierApprovable: false } } }),
      {},
    ],
    [
      'a tool that needs the user',
      () => standIn({ name: 'Scribe', needsUser: true, verdict: { behavior: 'ask', message: 'm' } }),
      {},
    ],
  ]
  test.each(asks)('%s', async (_what, make, extra) => {
    const d = await decide(make(), INPUT, { permissions: { mode: 'dontAsk', ...extra } })
    expect(d).toEqual({ behavior: 'deny', decisionReason: { type: 'mode', mode: 'dontAsk' }, message: DONT_ASK_REJECT_MESSAGE('Scribe') })
  })

  test('it runs before the headless hooks, so none of them is asked', async () => {
    const w = world()
    const log = `${w.root}/hook.log`
    const d = await decide(standIn({ name: 'Scribe' }), INPUT, {
      permissions: { mode: 'dontAsk', shouldAvoidPermissionPrompts: true },
      permissionRequestHooks: [{ command: w.script(`echo ran >> '${log}'`) }],
    })
    expect([d.decisionReason, existsSync(log)]).toEqual([{ type: 'mode', mode: 'dontAsk' }, false])
  })
})

test('auto mode without the auto-mode build asks like the default mode', async () => {
  const got = []
  for (const tool of [standIn({ name: 'Bash' }), standIn({ name: 'Read', readOnly: true }), standIn({ name: 'PowerShell' })]) {
    got.push(gist(await decide(tool, { command: 'ls' }, { permissions: { mode: 'auto' } })))
  }
  expect(got).toEqual(Array(3).fill({ behavior: 'ask', reason: null }))
})

describe('a session that cannot show a prompt', () => {
  const headless = { shouldAvoidPermissionPrompts: true }
  const hookAnswer = (decision: Record<string, unknown>) =>
    `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}'`

  test('with no hook, an ask is refused and the model is told why', async () => {
    const d = await decide(standIn({ name: 'Scribe' }), INPUT, { permissions: headless })
    expect(d).toEqual({
      behavior: 'deny',
      decisionReason: { type: 'asyncAgent', reason: expect.stringContaining('not available') },
      message: AUTO_REJECT_MESSAGE('Scribe'),
    })
  })

  test('allows and denies that need no prompt are untouched', async () => {
    const allowed = await decide(standIn({ name: 'Scribe' }), INPUT, { permissions: { ...headless, alwaysAllowRules: { session: ['Scribe'] } } })
    const denied = await decide(standIn({ name: 'Scribe' }), INPUT, { permissions: { ...headless, alwaysDenyRules: { session: ['Scribe'] } } })
    expect([gist(allowed)?.reason?.type, gist(denied)?.reason?.type]).toEqual(['rule', 'rule'])
  })

  test('a PermissionRequest hook that allows lets the call run, with its own input if it gives one', async () => {
    const w = world()
    const rewritten = await decide(standIn({ name: 'Scribe' }), INPUT, {
      permissions: headless,
      permissionRequestHooks: [{ command: w.script(hookAnswer({ behavior: 'allow', updatedInput: { file_path: '/hooked' } })) }],
    })
    const kept = await decide(standIn({ name: 'Scribe' }), INPUT, {
      permissions: headless,
      permissionRequestHooks: [{ command: w.script(hookAnswer({ behavior: 'allow' })) }],
    })
    expect([gist(rewritten), gist(kept)]).toEqual([
      { behavior: 'allow', reason: { type: 'hook', hookName: 'PermissionRequest' }, input: { file_path: '/hooked' } },
      { behavior: 'allow', reason: { type: 'hook', hookName: 'PermissionRequest' }, input: INPUT },
    ])
  })

  test('a hook that allows with rule updates saves them and applies them to the session', async () => {
    const w = world()
    const ctx = makeCtx({
      permissions: headless,
      permissionRequestHooks: [
        {
          command: w.script(
            hookAnswer({
              behavior: 'allow',
              updatedPermissions: [
                { type: 'addRules', rules: [{ toolName: 'Scribe' }], behavior: 'allow', destination: 'localSettings' },
                { type: 'addRules', rules: [{ toolName: 'Peek' }], behavior: 'deny', destination: 'session' },
              ],
            }),
          ),
        },
      ],
    })
    const d = await hasPermissionsToUseTool(standIn({ name: 'Scribe' }), INPUT, ctx, ASSISTANT_TURN, 'toolu_hook')
    const local = JSON.parse(readFileSync(w.settingsPath('local'), 'utf8'))
    const rules = ctx.state().toolPermissionContext
    expect([d.behavior, local.permissions.allow, rules.alwaysAllowRules.localSettings, rules.alwaysDenyRules.session]).toEqual([
      'allow',
      ['Scribe'],
      ['Scribe'],
      ['Peek'],
    ])
  })

  test('a hook that denies refuses with its message, or a stock one', async () => {
    const w = world()
    const said = await decide(standIn({ name: 'Scribe' }), INPUT, {
      permissions: headless,
      permissionRequestHooks: [{ command: w.script(hookAnswer({ behavior: 'deny', message: 'not on a Friday' })) }],
    })
    const silent = await decide(standIn({ name: 'Scribe' }), INPUT, {
      permissions: headless,
      permissionRequestHooks: [{ command: w.script(hookAnswer({ behavior: 'deny' })) }],
    })
    expect(said).toEqual({
      behavior: 'deny',
      message: 'not on a Friday',
      decisionReason: { type: 'hook', hookName: 'PermissionRequest', reason: 'not on a Friday' },
    })
    expect([silent.behavior, silent.decisionReason]).toEqual(['deny', { type: 'hook', hookName: 'PermissionRequest' }])
    expect(messageOf(silent)).toMatch(/denied by hook/i)
  })

  test('a deny that interrupts also aborts the turn; one that does not, does not', async () => {
    const w = world()
    const aborts = []
    for (const interrupt of [true, false]) {
      const abort = new AbortController()
      await decide(standIn({ name: 'Scribe' }), INPUT, {
        abort,
        permissions: headless,
        permissionRequestHooks: [{ command: w.script(hookAnswer({ behavior: 'deny', message: 'stop', interrupt })) }],
      })
      aborts.push(abort.signal.aborted)
    }
    expect(aborts).toEqual([true, false])
  })

  test('a hook with no decision, or a broken one, leaves the refusal in place', async () => {
    const w = world()
    const got: unknown[] = []
    for (const body of ['true', `printf 'not json'`, 'exit 1', `printf '%s' '{"continue":true}'`]) {
      const d = await decide(standIn({ name: 'Scribe' }), INPUT, {
        permissions: headless,
        permissionRequestHooks: [{ command: w.script(body) }],
      })
      got.push(d.decisionReason?.type)
    }
    expect(got).toEqual(['asyncAgent', 'asyncAgent', 'asyncAgent', 'asyncAgent'])
  })

  test("the hook is told the tool, its input, the mode and the tool's suggestions", async () => {
    const w = world()
    const log = `${w.root}/hook-input.json`
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Scribe' }], behavior: 'allow', destination: 'session' }]
    await decide(
      standIn({ name: 'Scribe', verdict: { behavior: 'ask', message: 'm', suggestions } as PermissionResult }),
      INPUT,
      { permissions: { ...headless, mode: 'acceptEdits' }, permissionRequestHooks: [{ command: w.script(`printf '%s' "$input" > '${log}'`) }] },
    )
    const seen = JSON.parse(readFileSync(log, 'utf8'))
    expect([seen.tool_name, seen.tool_input, seen.permission_mode, seen.permission_suggestions]).toEqual([
      'Scribe',
      INPUT,
      'acceptEdits',
      suggestions,
    ])
  })
})

// ---------------------------------------------------------------------------
// Sandboxing and the Bash ask rule
// ---------------------------------------------------------------------------

test('a Bash ask rule holds even with sandboxing switched on, since this build has no sandbox runtime', async () => {
  const w = world()
  w.settings('user', { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } })
  const bash = standIn({ name: 'Bash', verdict: { behavior: 'allow', updatedInput: { command: 'ls' } } })
  const d = await decide(bash, { command: 'ls' }, { permissions: { alwaysAskRules: { userSettings: ['Bash'] } } })
  const ruled = await checkRuleBasedPermissions(bash, { command: 'ls' }, makeCtx({ permissions: { alwaysAskRules: { userSettings: ['Bash'] } } }))
  expect([gist(d)?.behavior, gist(d)?.reason?.type, ruled?.behavior, bash.seenModes]).toEqual(['ask', 'rule', 'ask', []])
})

// ---------------------------------------------------------------------------
// checkRuleBasedPermissions: the rule-only subset
// ---------------------------------------------------------------------------

describe('checkRuleBasedPermissions', () => {
  const check = (tool: Tool, spec: ContextSpec = {}, input: Record<string, unknown> = INPUT) =>
    checkRuleBasedPermissions(tool, input, makeCtx(spec))

  test('a whole-tool deny or ask rule objects, from any source', async () => {
    const got: unknown[] = []
    for (const source of SOURCES) {
      got.push(gist(await check(standIn({ name: 'Scribe' }), { permissions: { alwaysDenyRules: { [source]: ['Scribe'] } } }))?.behavior)
      got.push(gist(await check(standIn({ name: 'Scribe' }), { permissions: { alwaysAskRules: { [source]: ['Scribe'] } } }))?.behavior)
    }
    expect(got).toEqual(SOURCES.flatMap(() => ['deny', 'ask']))
  })

  test('the deny names the tool, and the ask is the same one the full decision gives', async () => {
    const denied = await check(standIn({ name: 'Scribe' }), { permissions: { alwaysDenyRules: { session: ['Scribe'] } } })
    const asked = await check(standIn({ name: 'Scribe' }), { permissions: { alwaysAskRules: { session: ['Scribe'] } } })
    const full = await decide(standIn({ name: 'Scribe' }), INPUT, { permissions: { alwaysAskRules: { session: ['Scribe'] } } })
    expect(denied?.message).toContain('Scribe')
    expect(denied?.message).toContain('denied')
    expect(asked).toEqual(full as never)
  })

  test("a tool deny, a content ask rule and a safety check come back as the tool gave them", async () => {
    const verdicts: PermissionResult[] = [
      { behavior: 'deny', message: 'no', decisionReason: { type: 'other', reason: 'no' } },
      {
        behavior: 'ask',
        message: 'ask',
        decisionReason: { type: 'rule', rule: { source: 'projectSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'Scribe', ruleContent: 'x' } } },
      },
      { behavior: 'ask', message: 'safety', decisionReason: { type: 'safetyCheck', reason: 's', classifierApprovable: true } },
    ]
    const got: unknown[] = []
    for (const verdict of verdicts) got.push(await check(standIn({ name: 'Scribe', verdict })))
    expect(got).toEqual(verdicts)
  })

  const noObjection: Array<[string, () => StandIn, ContextSpec['permissions']]> = [
    ['a passthrough', () => standIn({ name: 'Scribe' }), {}],
    ['an allow rule', () => standIn({ name: 'Scribe' }), { alwaysAllowRules: { session: ['Scribe'] } }],
    ['a plain tool ask', () => standIn({ name: 'Scribe', verdict: { behavior: 'ask', message: 'm' } }), {}],
    [
      'an ask carrying an allow-rule reason',
      () =>
        standIn({
          name: 'Scribe',
          verdict: {
            behavior: 'ask',
            message: 'm',
            decisionReason: { type: 'rule', rule: { source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'Scribe' } } },
          },
        }),
      {},
    ],
    ['an ask from a tool that needs the user', () => standIn({ name: 'Scribe', needsUser: true, verdict: { behavior: 'ask', message: 'm' } }), {}],
    ['a tool allow', () => standIn({ name: 'Scribe', verdict: { behavior: 'allow', updatedInput: {} } }), {}],
    ['dontAsk mode', () => standIn({ name: 'Scribe' }), { mode: 'dontAsk' }],
    ['a headless session', () => standIn({ name: 'Scribe' }), { shouldAvoidPermissionPrompts: true }],
    ['a read-only call in plan mode', () => standIn({ name: 'Scribe', readOnly: true }), { mode: 'plan' }],
    ['a tool check that fails', () => standIn({ name: 'Scribe', verdict: () => { throw new Error('boom') } }), {}],
  ]
  test.each(noObjection)('%s raises no objection', async (_what, make, permissions) => {
    expect(await check(make(), { permissions })).toBeNull()
  })

  test('plan mode refuses a write here too, so a hook allow cannot get around it', async () => {
    const d = await check(standIn({ name: 'Scribe' }), { permissions: { mode: 'plan' }, agentId: 'planner-2' })
    expect(gist(d)).toEqual({ behavior: 'deny', reason: { type: 'mode', mode: 'plan' } })
    expect(d?.message).toContain(getPlanFilePath('planner-2' as never))
  })

  test('an aborted tool check aborts here too', async () => {
    const tool = standIn({ name: 'Scribe', verdict: () => { throw new AbortError('stop') } })
    await expect(check(tool)).rejects.toBeInstanceOf(AbortError)
  })

  test('MCP server rules apply here as well', async () => {
    const tool = standIn({ name: 'mcp__forge__deploy', mcp: { serverName: 'forge', toolName: 'deploy' } })
    const d = await check(tool, { permissions: { alwaysDenyRules: { policySettings: ['mcp__forge'] } } })
    expect(gist(d)?.reason).toEqual({
      type: 'rule',
      rule: { source: 'policySettings', ruleBehavior: 'deny', ruleValue: { toolName: 'mcp__forge' } },
    })
  })
})
