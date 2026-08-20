import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'

// planMode.ts reaches FileEditTool/FileWriteTool/ExitPlanModeV2Tool, whose
// import chain hits the Ink renderer — unimportable under `bun test` (see
// .claudin/rules/testing.md). The phase text is a template literal in the
// file, so assert on the source.
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

describe('plan mode — the no-op placeholder guard', () => {
  test('the clause names the command, the cost, and the alternative', () => {
    // Sonnet 5 emits Bash({command:'true'}) to buy itself another reasoning
    // block — 33 times across 14 sessions. A bare "don't do that" would leave
    // the model with no legal way to pause, which is what produced the no-op in
    // the first place, so all three halves are load-bearing.
    expect(src).toContain('Never emit a placeholder command')
    expect(src).toContain('a full round-trip of the entire context')
    expect(src).toContain('take it in the same message')
  })

  test('the sparse reminder carries the short form', () => {
    // The full attachment is re-sent only every N human turns, and the no-ops
    // cluster deep in long sessions — a clause that lives only in the full text
    // is gone by the turn it is needed.
    expect(src).toContain(
      'Never emit a placeholder command to buy a reasoning pass.',
    )
  })

  test('one killswitch gates both surfaces', () => {
    // Two call sites, not one: CLAUDIN_PLAN_NOOP_GUARD=0 has to subtract the
    // full clause AND the sparse form, or the A/B measures a half-removed arm.
    expect(src.match(/isPlanNoopGuardEnabled\(\)/g)).toHaveLength(2)
  })
})
