import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { createUserMessage } from 'src/agent/messages/factories.js'
import { snapshotPlanModeReminder } from 'src/agent/messages/planMode.js'

// The wording tests assert on the source: the phase text is a template literal
// in planMode.ts, and a render shows only the arm the current flags select.
// The snapshot guard at the bottom calls the module.
const src = readFileSync(new URL('./planMode.ts', import.meta.url), 'utf8')

describe('plan mode V2 — Phase 1', () => {
  test('Phase 1 is done in-session, not delegated', () => {
    // It used to say "you should only use the Explore subagent type" and
    // "Launch up to N Explore agents IN PARALLEL" — both ungated, so with the
    // agent out of the registry they named something unspawnable.
    expect(src).toContain('do not delegate Phase 1 to a subagent')
    expect(src).not.toContain('EXPLORE_AGENT')
    expect(src).not.toContain('exploreAgentCount')
  })

  test('Phase 1 says HOW to search, not just to search', () => {
    // Removing the agents removed the parallelism they provided. Replacing them
    // with a bare "read the code" would be a downgrade, so the batching and the
    // outline-first order are what carry it — assert on them, not on the fact
    // that a search happens.
    expect(src).toContain('batching independent calls')
    expect(src).toContain("view='outline'")
  })

  test('Phase 1 states the goal it is trying to reach', () => {
    // Survives whatever replaces the agents: the phase is worthless if the
    // rewrite keeps the mechanism and drops the objective.
    expect(src).toContain('### Phase 1: Initial Understanding')
    expect(src).toContain(
      'Actively search for existing functions, utilities, and patterns that can be reused',
    )
  })
})

describe('plan mode V2 — Phase 2 belongs to the Plan agent', () => {
  test('Phase 2 launches Plan agents and is untouched by the Phase 1 question', () => {
    expect(src).toContain(
      'Launch ${PLAN_AGENT.agentType} agent(s) to design the implementation',
    )
    expect(src).toContain('const agentCount = getPlanModeV2AgentCount()')
  })
})

describe('plan mode — interview path', () => {
  test('the Explore loop step names tools, not an agent', () => {
    // It carried a registry-gated sentence offering the Explore agent, which is
    // why this path degraded on its own where Phase 1 did not. The step is
    // still called "Explore" — that is the phase name, not an agent.
    expect(src).toContain(
      '1. **Explore** — Use ${getReadOnlyToolNames()} to read code.',
    )
    expect(src).not.toContain('agent type to parallelize complex searches')
  })
})

describe('plan mode — the no-op placeholder guard is gone', () => {
  test('neither attachment carries the clause or its resolver', () => {
    // The A/B (2026-08-19, Sonnet 5, one build, both arms set explicitly)
    // counted 1 no-op in 94 tool turns WITHOUT the clause against 3 in 85 WITH
    // it — no benefit, overlapping ranges, and if anything a nudge toward the
    // behavior it named. Re-adding it needs a new measurement, not a revert.
    expect(src).not.toContain('Never emit a placeholder command')
    expect(src).not.toContain('isPlanNoopGuardEnabled')
  })
})

describe('plan mode — the sub-agent brief (#224)', () => {
  // The short branch is a template literal with no backticks of its own, so it
  // runs from the opening sentence to the next backtick in the file.
  const START = 'Plan mode is active in the session that launched you.'
  function shortBrief(): string {
    const start = src.indexOf(START)
    expect(start).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('`', start))
  }

  test('an agent that cannot submit a plan is not told to write one', () => {
    // The long brief names ExitPlanMode, Write/Edit and AskUserQuestion. A
    // WebResearcher holds none of the three, and being instructed to use them
    // is most of what made two of them report this reminder as a
    // prompt-injection attempt in the page they had just fetched.
    const brief = shortBrief()
    expect(brief).toContain('READ-ONLY actions only')
    expect(brief).not.toContain('planFilePath')
    expect(brief).not.toContain('FileWriteTool')
    expect(brief).not.toContain('FileEditTool')
    expect(brief).not.toContain('ASK_USER_QUESTION_TOOL_NAME')
  })

  test('the long form survives for the agent that can submit a plan', () => {
    // In-process teammates keep ExitPlanMode in plan mode (filterToolsForAgent),
    // so the plan-file guidance is not dead — it is gated, not deleted.
    expect(src).toContain('if (!attachment.canExitPlanMode)')
    expect(src).toContain('${ASK_USER_QUESTION_TOOL_NAME} tool')
  })
})

describe('snapshotPlanModeReminder keeps a reminder whole or not at all', () => {
  // The snapshot is what a resumed process re-sends in place of the render.
  // Every renderer returns one text message today, so the guard is reached
  // only through an injected render: any other shape keeps nothing, and the
  // attachment renders live rather than re-sending part of what was sent.
  const FIELDS = { reminderType: 'full', planFilePath: '/plans/p.md', planExists: false } as const
  const text = (content: string) => createUserMessage({ content, isMeta: true })

  test('one text message is kept as it is', () => {
    expect(snapshotPlanModeReminder(FIELDS, () => [text('Plan mode is active.')])).toBe(
      'Plan mode is active.',
    )
  })

  test('any other shape is not kept', () => {
    // Keeping the first of two would drop the second on resume.
    expect(snapshotPlanModeReminder(FIELDS, () => [text('first'), text('second')])).toBeUndefined()
    const blocks = createUserMessage({ content: [{ type: 'text', text: 'blocks' }], isMeta: true })
    expect(snapshotPlanModeReminder(FIELDS, () => [blocks])).toBeUndefined()
    // Nothing rendered is not an empty reminder.
    expect(snapshotPlanModeReminder(FIELDS, () => [])).toBeUndefined()
  })
})
