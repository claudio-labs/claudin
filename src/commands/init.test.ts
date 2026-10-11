import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { RULE_MAP_KILLSWITCH } from 'src/memory/instructions/ruleMapAutoSync.js'
import {
  getLastRuleMapRun,
  initRuleMapSync,
  resetRuleMapSyncForTesting,
} from 'src/memory/instructions/ruleMapScheduler.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from 'src/platform/config/config.js'

// /init syncs the navigation map before it builds its prompt, and under
// `bun test` the project root is this checkout: without the killswitch every
// test below would rewrite the repo's own search-strategy.md.
const savedKillswitch = process.env[RULE_MAP_KILLSWITCH]
beforeAll(() => {
  process.env[RULE_MAP_KILLSWITCH] = '1'
})
afterAll(() => {
  if (savedKillswitch === undefined) delete process.env[RULE_MAP_KILLSWITCH]
  else process.env[RULE_MAP_KILLSWITCH] = savedKillswitch
  resetRuleMapSyncForTesting()
})

async function importInitCommand() {
  return (await import(`./init.ts?ts=${Date.now()}-${Math.random()}`)).default
}

test('init prompt preserves existing root CLAUDE.md by default', async () => {
  mock.module('src/platform/projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  const command = await importInitCommand()
  const blocks = await command.getPromptForCommand()

  expect(blocks).toHaveLength(1)
  expect(blocks[0]?.type).toBe('text')
  const text = String(blocks[0]?.text)
  expect(text).toContain(
    'checked-in root `CLAUDE.md` and does NOT already have a root `AGENTS.md`',
  )
  expect(text).toContain('do NOT silently create a second root instruction file')
  expect(text).toContain('update the existing root `CLAUDE.md` in place by default')
})

test('init prompt asks about subagents and guardrails in Phase 1', async () => {
  mock.module('src/platform/projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  const command = await importInitCommand()
  const blocks = await command.getPromptForCommand()
  const text = String(blocks[0]?.text)

  expect(text).toContain('Set up custom subagents for this project?')
  expect(text).toContain('Configure guardrails')
})

test('init prompt annotates the navigation map without rewriting it', async () => {
  mock.module('src/platform/projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  resetRuleMapSyncForTesting()
  const command = await importInitCommand()
  const blocks = await command.getPromptForCommand()
  // /init is often a fresh repo's first prompt, before any turn has ended to
  // write the map — so it syncs one itself, then enriches rather than creates.
  expect(getLastRuleMapRun()).toMatchObject({
    trigger: 'command',
    outcome: { status: 'skipped', reason: 'killswitch' },
  })
  expect(blocks).toHaveLength(1)
  const text = String(blocks[0]?.text)

  expect(text).toContain('Phase 4.5: Annotate the navigation map')
  expect(text).toContain('.claudin/rules/search-strategy.md')
  expect(text).toContain('Only annotate what you actually read')
  // Four gates can skip the write, so the file is not guaranteed to be there
  // and /init must not hand-write one when it is missing.
  expect(text).toContain('CLAUDIN_DISABLE_RULE_MAP_SYNC')
  expect(text).toContain('skip this phase')
  // The two kinds behave differently, and the hand-written one is this repo's
  // own case: telling the model its tree is regenerated would be false.
  expect(text).toContain('A generated map')
  expect(text).toContain('A hand-written map')
})

test('init leaves the map alone after /map off', async () => {
  mock.module('src/platform/projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  resetRuleMapSyncForTesting()
  const saved = getCurrentProjectConfig().ruleMapSyncDisabled
  saveCurrentProjectConfig(current => ({ ...current, ruleMapSyncDisabled: true }))
  try {
    const command = await importInitCommand()
    await command.getPromptForCommand()
    // Its prompt tells the model the map is skipped after `/map off`.
    expect(getLastRuleMapRun()).toBeNull()
  } finally {
    saveCurrentProjectConfig(current => ({
      ...current,
      ruleMapSyncDisabled: saved,
    }))
  }
})

test('init announces a map it wrote, through the command context', async () => {
  mock.module('src/platform/projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  // A faked sync, so the write is real to the scheduler and nothing touches
  // this checkout's map.
  initRuleMapSync({
    root: () => '/repo',
    fingerprint: async () => null,
    disabledForProject: () => false,
    interactive: () => true,
    track: (_setAppState, sync) => sync,
    sync: async () => ({
      status: 'created',
      path: '.claudin/rules/search-strategy.md',
      changes: [{ path: 'src/', from: null, to: 8 }],
    }),
  })
  try {
    const notices: string[] = []
    const command = await importInitCommand()
    await command.getPromptForCommand('', {
      appendSystemMessage: (msg: { content: unknown }) => notices.push(String(msg.content)),
      setAppState: () => {},
    })
    expect(notices).toEqual([
      'Navigation map · .claudin/rules/search-strategy.md · created · 1 directory (/map off to turn this off)',
    ])
  } finally {
    resetRuleMapSyncForTesting()
  }
})

test('init prompt includes Phase 5.5 subagent creation flow', async () => {
  mock.module('src/platform/projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  const command = await importInitCommand()
  const blocks = await command.getPromptForCommand()
  const text = String(blocks[0]?.text)

  expect(text).toContain('Phase 5.5')
  expect(text).toContain('.claudin/agents/<slug>.md')
  expect(text).toContain('/agents')
})

test('init prompt includes guardrail categories and addPermissionRulesToSettings', async () => {
  mock.module('src/platform/projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  const command = await importInitCommand()
  const blocks = await command.getPromptForCommand()
  const text = String(blocks[0]?.text)

  expect(text).toContain('addPermissionRulesToSettings')
  // Pin the source enum literals — drift here would silently break persistence wiring.
  expect(text).toContain("'projectSettings'")
  expect(text).toContain("'userSettings'")
  expect(text).toContain('No destructive git')
  expect(text).toContain('Bash(git push --force')
  // Pin canonical matcher syntax — colon separator must not drift to bare `*`.
  expect(text).toContain('Bash(git commit:*)')
  expect(text).toContain('Bash(<command>:*)')
  expect(text).toContain('Never run `npm install`')
})

test('init prompt instructs final AGENTS.md pass to add Subagents / Skills / Guardrails sections', async () => {
  mock.module('src/platform/projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  const command = await importInitCommand()
  const blocks = await command.getPromptForCommand()
  const text = String(blocks[0]?.text)

  expect(text).toContain('## Subagents')
  expect(text).toContain('## Skills')
  expect(text).toContain('## Guardrails')
})
