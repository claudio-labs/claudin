import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// The scheduler's behaviour is pinned in ruleMapScheduler.test.ts, and the
// held-row predicate in footerSummary.test.ts; this pins that something calls
// them. Each is one line whose deletion leaves the whole suite green and the
// feature silently dead — driving the real stop-hook pipeline, headless exit
// or prompt footer to observe them would cost a harness bigger than the
// feature, so the call sites are read as text. The patterns allow any
// whitespace, so a reformat does not break them; a rename or a removal does.
const SRC = join(import.meta.dir, '..', '..')

function source(relPath: string): string {
  return readFileSync(join(SRC, relPath), 'utf8')
}

describe('navigation-map sync wiring', () => {
  test('the end of a main-thread turn runs it, inside the block that runs auto-dream', () => {
    expect(source('agent/query/stopHooks.ts')).toMatch(
      /if \(!toolUseContext\.agentId\) \{\s*void executeAutoDream\([^)]*\)\s*(\/\/[^\n]*\s*)*void executeRuleMapSync\(\{/,
    )
  })

  test('the session arms it, beside initAutoDream', () => {
    expect(source('platform/backgroundHousekeeping.ts')).toMatch(
      /initAutoDream\(\)\s*initRuleMapSync\(\)/,
    )
  })

  test('a headless run waits for a write in flight before it exits', () => {
    expect(source('platform/headless/print/runHeadless.ts')).toMatch(
      /await drainPendingRuleMapSync\(\)\s*gracefulShutdownSync\(/,
    )
  })

  test('startup does not sync it — the first prompt waits on nothing', () => {
    const setup = source('platform/setup.ts')
    expect(setup).not.toContain('ruleMapAutoSync')
    expect(setup).not.toContain('ruleMapScheduler')
  })

  test('the footer cursor, and its hint, can reach a notice listed on its own', () => {
    expect(source('terminal/prompt-input/PromptInput.tsx')).toMatch(
      /tasksFooterVisible\s*=\s*\([^)]*\|\|\s*hasHeldRows\)/,
    )
    expect(source('terminal/prompt-input/PromptInputFooterLeftSide.tsx')).toMatch(
      /showTasksTree\s*=\s*\(hasBackgroundTasks\s*\|\|\s*hasHeldRows\)/,
    )
  })
})
