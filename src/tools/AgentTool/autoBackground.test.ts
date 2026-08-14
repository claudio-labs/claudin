import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { allowsImplicitAutoBackground } from './autoBackground.js'
import { FORK_SUBAGENT_TYPE } from './forkSubagent.js'

describe('allowsImplicitAutoBackground', () => {
  test('one-shot built-ins stay inline so the parent gets the report this turn', () => {
    for (const agentType of [
      'Explore',
      'Plan',
      'WebResearcher',
      'WebResearcherManager',
    ]) {
      expect(allowsImplicitAutoBackground(undefined, agentType)).toBe(false)
    }
  })

  test('forks and other named agents still follow the toggle', () => {
    expect(allowsImplicitAutoBackground(undefined, FORK_SUBAGENT_TYPE)).toBe(
      true,
    )
    expect(allowsImplicitAutoBackground(undefined, 'code-reviewer')).toBe(true)
    expect(allowsImplicitAutoBackground(undefined, 'Code')).toBe(true)
  })

  test('run_in_background:false is an explicit opt-out, even for a fork', () => {
    expect(allowsImplicitAutoBackground(false, FORK_SUBAGENT_TYPE)).toBe(false)
    expect(allowsImplicitAutoBackground(false, 'code-reviewer')).toBe(false)
  })

  test('run_in_background:true does not need the implicit path', () => {
    // shouldRunAsync has its own `run_in_background === true` term, so the
    // implicit toggle is irrelevant here — asserted to pin the semantics.
    expect(allowsImplicitAutoBackground(true, 'Explore')).toBe(false)
    expect(allowsImplicitAutoBackground(true, FORK_SUBAGENT_TYPE)).toBe(true)
  })
})

describe('auto-background is opt-in', () => {
  // The three flip points live in modules too heavy to import here (AgentTool's
  // 1k-line call(), config's private default factory), and a silent revert to
  // `!== false` reads as a harmless cleanup — so pin the text.
  test('the config default is false', () => {
    const src = readFileSync(
      join(import.meta.dir, '../../services/config/config.ts'),
      'utf8',
    )
    expect(src).toContain('autoBackgroundAgentsEnabled: false,')
  })

  test('AgentTool treats an unset flag as off', () => {
    const src = readFileSync(join(import.meta.dir, 'AgentTool.tsx'), 'utf8')
    expect(src).toContain(
      'getGlobalConfig().autoBackgroundAgentsEnabled === true',
    )
  })

  test('fork availability does not read the background flag', () => {
    // Fork is context inheritance, backgrounding is execution mode. Coupling
    // them made turning off background also disable fork.
    // The doc comment names the flag on purpose, so assert on the read itself.
    const src = readFileSync(join(import.meta.dir, 'forkSubagent.ts'), 'utf8')
    expect(src).not.toContain('getGlobalConfig')
  })
})

describe('AgentTool wiring', () => {
  // The predicate is only worth anything if the spawn path calls it; the async
  // decision itself lives inside a ~1k-line call() that can't be unit-driven.
  const src = () => readFileSync(join(import.meta.dir, 'AgentTool.tsx'), 'utf8')

  test('autoBackgroundImplicit is gated on allowsImplicitAutoBackground', () => {
    expect(src()).toContain(
      'allowsImplicitAutoBackground(run_in_background, selectedAgent.agentType)',
    )
  })

  test('the 120s foreground timer is gated on the same carve-out', () => {
    // getAutoBackgroundMs() is a separate gate (env / GrowthBook). Ungated, it
    // flipped an inline-only spawn to async after 120s, right past the guard.
    expect(src()).toContain(
      'autoBackgroundMs: implicitBackgroundAllowed ? getAutoBackgroundMs() || undefined : undefined',
    )
  })
})
