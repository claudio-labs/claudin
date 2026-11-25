/**
 * Bash(prompt: …) deny and ask rules, through bashToolHasPermission.
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

const COMMAND_IN_PROMPT = /<command>\n([\s\S]*)\n<\/command>/

const mockSideQuery = mock(
  async (opts: { system: string; messages: { content: string }[] }) => {
  const chosen = opts.system.includes('deny rule')
    ? verdicts.deny
    : verdicts.ask
  const command = COMMAND_IN_PROMPT.exec(opts.messages[0]!.content)?.[1] ?? ''
  const verdict = typeof chosen === 'function' ? chosen(command) : chosen
  if (verdict === undefined) throw new Error('no verdict set for this rule')
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
  return reason?.type === 'other' ? reason.reason : undefined
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
  const UNEVALUATED =
    'A Bash prompt rule could not be evaluated; approval required'

  test.each([
    ['a provider error', 'throws'],
    ['no tool_use block', 'no-tool-use'],
    ['an out-of-range index', { matchedIndex: 7, confidence: 'high' }],
  ] as const)('asks instead of a literal allow after %s on a deny rule', async (_label, verdict) => {
    verdicts = { deny: verdict }
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
      deny: [DENY_PUSH],
    })
    expect(result.behavior).toBe('ask')
    expect(reasonOf(result)).toBe(UNEVALUATED)
  })

  test('asks instead of a literal allow after an error on an ask rule', async () => {
    verdicts = { ask: 'throws' }
    const result = await decide('git push origin main', {
      allow: ['Bash(git push:*)'],
      ask: [ASK_PUSH],
    })
    expect(result.behavior).toBe('ask')
    expect(reasonOf(result)).toBe(UNEVALUATED)
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
})
