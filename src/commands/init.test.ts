import { expect, mock, test } from 'bun:test'

async function importInitCommand() {
  return (await import(`./init.ts?ts=${Date.now()}-${Math.random()}`)).default
}

test('init prompt preserves existing root CLAUDE.md by default', async () => {
  mock.module('../projectOnboardingState.js', () => ({
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
  mock.module('../projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  const command = await importInitCommand()
  const blocks = await command.getPromptForCommand()
  const text = String(blocks[0]?.text)

  expect(text).toContain('Set up custom subagents for this project?')
  expect(text).toContain('Configure guardrails')
})

test('init prompt includes Phase 5.5 subagent creation flow', async () => {
  mock.module('../projectOnboardingState.js', () => ({
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
  mock.module('../projectOnboardingState.js', () => ({
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
  mock.module('../projectOnboardingState.js', () => ({
    maybeMarkProjectOnboardingComplete: () => {},
  }))

  const command = await importInitCommand()
  const blocks = await command.getPromptForCommand()
  const text = String(blocks[0]?.text)

  expect(text).toContain('## Subagents')
  expect(text).toContain('## Skills')
  expect(text).toContain('## Guardrails')
})
