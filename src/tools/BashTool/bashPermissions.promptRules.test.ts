/**
 * Bash(prompt: …) deny and ask rules, through bashToolHasPermission and the
 * permission engine around it.
 *
 * sideQuery is mocked so the classifier answers without an API call, and the
 * BASH_CLASSIFIER test hatch turns the classifier on (every feature() reads
 * false under bun test). The pendingClassifierCheck arms stay out of reach for
 * the same reason; the decisions below are what this file can see.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const GATE_BLOCKED_BY_DEFERRED_ASK =
  /pendingClassifierCheckUnless\(\s*deferredAsk !== null,/g
const GATE_BLOCKED_BY_UNEVALUATED_DENY =
  /pendingClassifierCheckUnless\(\s*denyResult\?\.unavailable === true,/g

// mock.module lasts for the whole run (testing.md, "Cross-file mock leaks"):
// snapshot the real module and put it back in afterAll.
const realSideQueryModule = { ...(await import('src/agent/sideQuery.js')) }

type Verdict =
  | { matchedIndex: number | null; confidence: 'high' | 'medium' | 'low' }
  | 'throws'
  | 'no-tool-use'

// A verdict, or one chosen per classified command.
type VerdictFor = Verdict | ((command: string) => Verdict)

let verdicts: { deny?: VerdictFor; ask?: VerdictFor } = {}
// A classifier call no test asked for. It must fail the test, not read as a
// classifier error: that would pass every "unevaluated" case below by accident.
let unexpectedClassifierCalls = 0

const COMMAND_IN_PROMPT = /<command>\n([\s\S]*)\n<\/command>/

const mockSideQuery = mock(
  async (opts: { system: string; messages: { content: string }[] }) => {
    const chosen = opts.system.includes('deny rule')
      ? verdicts.deny
      : verdicts.ask
    const command = COMMAND_IN_PROMPT.exec(opts.messages[0]!.content)?.[1] ?? ''
    const verdict = typeof chosen === 'function' ? chosen(command) : chosen
    if (verdict === undefined) {
      unexpectedClassifierCalls++
      return { content: [] }
    }
    if (verdict === 'throws') throw new Error('503 overloaded')
    if (verdict === 'no-tool-use') {
      return { content: [{ type: 'text', text: 'no idea' }] }
    }
    return {
      content: [
        {
          type: 'tool_use',
          name: 'classify_match',
          input: { ...verdict, reason: 'test verdict' },
        },
      ],
    }
  },
)

mock.module('src/agent/sideQuery.js', () => ({
  ...realSideQueryModule,
  sideQuery: mockSideQuery,
}))

const { __setBashClassifierEnabledForTests } = await import(
  'src/permissions/bashClassifier.js'
)
const { bashToolHasPermission } = await import(
  'src/tools/BashTool/bashPermissions.js'
)
const { checkRuleBasedPermissions, hasPermissionsToUseTool } = await import(
  'src/permissions/permissions.js'
)
const { BashTool } = await import('src/tools/BashTool/BashTool.js')
const { pendingClassifierCheckUnless } = await import(
  'src/tools/BashTool/bashPermissions/speculative.js'
)
const {
  makePermissionContext,
  makeToolUseContext,
  resetPermissionState,
  stubMacroVersion,
} = await import('src/tools/BashTool/__testutils__/permissionContext.js')
type PermissionRules = import('src/tools/BashTool/__testutils__/permissionContext.js').PermissionRules

beforeAll(() => {
  stubMacroVersion()
  __setBashClassifierEnabledForTests(true)
})
afterAll(() => {
  __setBashClassifierEnabledForTests(undefined)
  mock.module('src/agent/sideQuery.js', () => realSideQueryModule)
})
afterEach(() => {
  expect(unexpectedClassifierCalls).toBe(0)
  unexpectedClassifierCalls = 0
  verdicts = {}
  mockSideQuery.mockClear()
  resetPermissionState()
})

const MATCH = { matchedIndex: 0, confidence: 'high' } as const
const NO_MATCH = { matchedIndex: null, confidence: 'high' } as const

const DENY_PUSH = 'Bash(prompt: never push to a remote)'
const ASK_PUSH = 'Bash(prompt: pushing to a remote)'

function decide(command: string, rules: PermissionRules) {
  return bashToolHasPermission(
    { command },
    makeToolUseContext(makePermissionContext(rules)),
  )
}

function reasonOf(result: Awaited<ReturnType<typeof decide>>): string | undefined {
  const reason = result.decisionReason
  return reason?.type === 'other' || reason?.type === 'safetyCheck'
    ? reason.reason
    : undefined
}

function unevaluated(classifierReason: string): string {
  return `A Bash prompt rule could not be evaluated (${classifierReason}); approval required`
}

describe('Bash prompt rules', () => {
  test('a matched deny rule denies before any literal allow', async () => {
    verdicts = { deny: MATCH }
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
      deny: [DENY_PUSH],
    })
    expect(result.behavior).toBe('deny')
    expect(reasonOf(result)).toBe(
      'Denied by Bash prompt rule: "never push to a remote"',
    )
  })

  test('a matched ask rule asks before any literal allow', async () => {
    verdicts = { ask: MATCH }
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
      ask: [ASK_PUSH],
    })
    expect(result.behavior).toBe('ask')
    expect(reasonOf(result)).toBe(
      'Required by Bash prompt rule: "pushing to a remote"',
    )
  })

  test('a deny match wins over an ask match', async () => {
    verdicts = { deny: MATCH, ask: MATCH }
    const result = await decide('git push origin main', {
      deny: [DENY_PUSH],
      ask: [ASK_PUSH],
    })
    expect(result.behavior).toBe('deny')
  })

  test('a clean non-match falls through to the literal allow', async () => {
    verdicts = { deny: NO_MATCH, ask: NO_MATCH }
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
      deny: [DENY_PUSH],
      ask: [ASK_PUSH],
    })
    expect(result.behavior).toBe('allow')
  })

  test('only a high-confidence match decides', async () => {
    verdicts = { deny: { matchedIndex: 0, confidence: 'medium' } }
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
      deny: [DENY_PUSH],
    })
    expect(result.behavior).toBe('allow')
  })

  test('no prompt rules, no classifier call', async () => {
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
    })
    expect(result.behavior).toBe('allow')
    expect(mockSideQuery).not.toHaveBeenCalled()
  })

  test('a -1 index is a clean non-match too', async () => {
    verdicts = { deny: { matchedIndex: -1, confidence: 'high' } }
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
      deny: [DENY_PUSH],
    })
    expect(result.behavior).toBe('allow')
  })

  test('an abort during the classifier call throws', async () => {
    verdicts = { deny: NO_MATCH }
    const context = makeToolUseContext(
      makePermissionContext({ deny: [DENY_PUSH] }),
    )
    context.abortController.abort()
    await expect(
      bashToolHasPermission({ command: 'git push origin main' }, context),
    ).rejects.toThrow()
  })
})

// Ported from openclaude #2533's review round: a rule the classifier could
// not evaluate is not a rule that did not match.
describe('a prompt rule the classifier could not evaluate', () => {
  test.each([
    ['a provider error', 'throws', 'classifier error: 503 overloaded'],
    ['no tool_use block', 'no-tool-use', 'classifier returned no tool_use block'],
    [
      'an out-of-range index',
      { matchedIndex: 7, confidence: 'high' },
      'classifier returned an out-of-range index (7)',
    ],
  ] as const)('asks instead of a literal allow after %s on a deny rule', async (_label, verdict, why) => {
    verdicts = { deny: verdict }
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
      deny: [DENY_PUSH],
    })
    expect(result.behavior).toBe('ask')
    expect(reasonOf(result)).toBe(unevaluated(why))
  })

  test('asks instead of a literal allow after an error on an ask rule', async () => {
    verdicts = { ask: 'throws' }
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
      ask: [ASK_PUSH],
    })
    expect(result.behavior).toBe('ask')
    expect(reasonOf(result)).toBe(unevaluated('classifier error: 503 overloaded'))
  })

  test('asks for every segment of a pipeline the literal rules allow', async () => {
    verdicts = { deny: 'throws' }
    const result = await decide('git push origin main | cat', {
      allow: ['Bash(git push:*)', 'Bash(cat:*)'],
      deny: [DENY_PUSH],
    })
    expect(result.behavior).toBe('ask')
  })

  test('asks when only the whole pipeline went unevaluated, its segments not', async () => {
    verdicts = { deny: command => (command.includes('|') ? 'throws' : NO_MATCH) }
    const rules = {
      allow: ['Bash(git push:*)', 'Bash(cat:*)'],
      deny: [DENY_PUSH],
    }
    expect((await decide('git push origin main', rules)).behavior).toBe('allow')
    expect((await decide('git push origin main | cat', rules)).behavior).toBe('ask')
  })

  test('an exact allow does not carry the misparsing gate past it', async () => {
    // Backticks trip the misparsing gate, where only an exact allow passes.
    const rules = { allow: ['Bash(echo `date`)'], deny: [DENY_PUSH] }
    verdicts = { deny: NO_MATCH }
    expect((await decide('echo `date`', rules)).behavior).toBe('allow')
    verdicts = { deny: 'throws' }
    expect((await decide('echo `date`', rules)).behavior).toBe('ask')
  })

  test('a matched ask rule keeps its own reason when the deny side errored', async () => {
    verdicts = { deny: 'throws', ask: MATCH }
    const result = await decide('git push origin main', {
      deny: [DENY_PUSH],
      ask: [ASK_PUSH],
    })
    expect(result.behavior).toBe('ask')
    expect(reasonOf(result)).toBe(
      'Required by Bash prompt rule: "pushing to a remote"',
    )
  })
})

describe('a literal deny against a prompt rule that asks', () => {
  test('the literal prefix deny wins over a matched ask rule', async () => {
    verdicts = { ask: MATCH }
    const result = await decide('git push origin main', {
      deny: ['Bash(git push:*)'],
      ask: [ASK_PUSH],
    })
    expect(result.behavior).toBe('deny')
  })

  test('the literal prefix deny wins over an unevaluated deny rule', async () => {
    verdicts = { deny: 'throws' }
    const result = await decide('git push origin main', {
      deny: ['Bash(git push:*)', DENY_PUSH],
    })
    expect(result.behavior).toBe('deny')
  })

  test('a redirect blocked by a deny rule wins over an unevaluated rule', async () => {
    verdicts = { deny: 'throws' }
    const result = await decide('echo hi > /etc/claudin-review-probe', {
      deny: ['Edit(//etc/**)', DENY_PUSH],
    })
    expect(result.behavior).toBe('deny')
  })
})

// Found by the 2026-11-25 review round: the fail-closed ask has to survive the
// steps of hasPermissionsToUseTool that turn an ordinary ask into an allow.
describe('an unevaluated prompt deny rule through the permission engine', () => {
  function gate(
    rules: PermissionRules,
    mode: 'default' | 'bypassPermissions' = 'default',
  ) {
    const toolPermissionContext = makePermissionContext(rules, { mode })
    const context = {
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false, tools: [] },
      messages: [],
      getAppState: () => ({ toolPermissionContext }),
      setAppState() {},
    } as never
    return hasPermissionsToUseTool(
      BashTool,
      { command: 'git push origin main' },
      context,
      { message: { id: 'msg_test' } } as never,
      'tool_use_test',
    )
  }

  test('control: a matched deny holds against a tool-wide allow and bypass', async () => {
    verdicts = { deny: MATCH }
    expect((await gate({ allow: ['Bash'], deny: [DENY_PUSH] })).behavior).toBe('deny')
    expect((await gate({ deny: [DENY_PUSH] }, 'bypassPermissions')).behavior).toBe('deny')
  })

  test('a tool-wide Bash allow does not approve it', async () => {
    verdicts = { deny: 'throws' }
    expect((await gate({ allow: ['Bash'], deny: [DENY_PUSH] })).behavior).toBe('ask')
  })

  test('bypassPermissions does not approve it', async () => {
    verdicts = { deny: 'throws' }
    expect((await gate({ deny: [DENY_PUSH] }, 'bypassPermissions')).behavior).toBe('ask')
  })

  test('a PreToolUse hook allow does not approve it', async () => {
    // checkRuleBasedPermissions is what toolHooks.ts consults before honoring
    // a hook's allow; null means "no objection".
    const context = makeToolUseContext(makePermissionContext({ deny: [DENY_PUSH] }))
    verdicts = { deny: MATCH }
    expect(
      (await checkRuleBasedPermissions(BashTool, { command: 'git push origin main' }, context))?.behavior,
    ).toBe('deny')
    verdicts = { deny: 'throws' }
    expect(
      (await checkRuleBasedPermissions(BashTool, { command: 'git push origin main' }, context))?.behavior,
    ).toBe('ask')
  })
})

// Every feature() reads false under bun test, so the asks above never carry a
// pendingClassifierCheck here. The gate that withholds it is tested directly,
// and its four call sites are pinned on the source.
describe('the allow classifier is held back behind an unevaluated rule', () => {
  const ALLOW_STATUS = 'Bash(prompt: read-only git status)'

  test('pendingClassifierCheckUnless withholds the check only when blocked', () => {
    const context = makePermissionContext({ allow: [ALLOW_STATUS] })
    expect(pendingClassifierCheckUnless(true, 'git status', context)).toEqual({})
    expect(
      pendingClassifierCheckUnless(false, 'git status', context)
        .pendingClassifierCheck,
    ).toMatchObject({
      command: 'git status',
      descriptions: ['read-only git status'],
    })
  })

  test('each ask that can follow a deferred prompt-rule ask goes through the gate', () => {
    const source = readFileSync(
      join(import.meta.dir, 'bashPermissions', 'decide.ts'),
      'utf8',
    )
    expect(source.match(GATE_BLOCKED_BY_DEFERRED_ASK)?.length).toBe(3)
    expect(source.match(GATE_BLOCKED_BY_UNEVALUATED_DENY)?.length).toBe(1)
  })
})
