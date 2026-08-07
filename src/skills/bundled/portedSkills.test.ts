import { afterEach, describe, expect, test } from 'bun:test'

// MACRO is replaced at build time by Bun.define but not in test mode. The
// verify/run skills set `files:`, which resolves an extract dir using
// MACRO.VERSION at registration time — define it so registration doesn't crash.
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: '1970-01-01T00:00:00.000Z',
  ISSUES_EXPLAINER: 'report the issue',
  PACKAGE_URL: '@claudiolabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerFewerPermissionPromptsSkill } from './fewerPermissionPrompts.js'
import { registerRefreshRulesSkill } from './refreshRules.js'
import { registerRunSkill } from './run.js'
import { registerSimplifySkill } from './simplify.js'
import { registerVerifySkill } from './verify.js'
import { RUN_EXAMPLE_FILES, VERIFY_EXAMPLE_FILES } from './verifyRunExamples.js'

afterEach(() => {
  clearBundledSkills()
})

type PromptSkill = {
  name: string
  type: string
  description: string
  getPromptForCommand: (args: string, ctx: never) => Promise<unknown[]>
}

function findSkill(name: string): PromptSkill {
  const skill = getBundledSkills().find(c => c.name === name)
  expect(skill).toBeDefined()
  return skill as unknown as PromptSkill
}

async function promptText(name: string): Promise<string> {
  const skill = findSkill(name)
  expect(skill.type).toBe('prompt')
  const blocks = await skill.getPromptForCommand('', {} as never)
  expect(blocks.length).toBeGreaterThan(0)
  expect(blocks[0]).toMatchObject({ type: 'text' })
  return (blocks[0] as { text: string }).text
}

describe('simplify skill', () => {
  test('registers and prompts for quality cleanup, not bugs', async () => {
    registerSimplifySkill()
    const text = await promptText('simplify')
    expect(text).toContain('Quality Cleanup')
    expect(text).toContain('4 cleanup agents')
    expect(text).toContain('/code-review')
  })

  test('appends free-text focus when passed', async () => {
    registerSimplifySkill()
    const skill = findSkill('simplify')
    const blocks = await skill.getPromptForCommand('the auth module', {} as never)
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('## Additional Focus')
    expect(text).toContain('the auth module')
  })
})

describe('verify skill', () => {
  test('registers as runtime-observation skill', async () => {
    registerVerifySkill()
    const skill = findSkill('verify')
    expect(skill.description).toContain('Verify a change works')
  })

  test('carries both cli and server examples', () => {
    expect(Object.keys(VERIFY_EXAMPLE_FILES).sort()).toEqual([
      'examples/cli.md',
      'examples/server.md',
    ])
    // base64 round-trips back to the captured markdown
    expect(VERIFY_EXAMPLE_FILES['examples/cli.md']).toContain(
      'Verifying a CLI change',
    )
  })
})

describe('run skill', () => {
  test('registers as launch-and-drive skill', async () => {
    registerRunSkill()
    const skill = findSkill('run')
    expect(skill.description).toContain("Launch this project's app")
  })

  test('carries all six project-type examples', () => {
    expect(Object.keys(RUN_EXAMPLE_FILES).sort()).toEqual([
      'examples/cli.md',
      'examples/electron.md',
      'examples/library.md',
      'examples/playwright.md',
      'examples/server.md',
      'examples/tui.md',
    ])
  })
})

describe('fewer-permission-prompts skill', () => {
  test('targets Claudin paths, not .claude', async () => {
    registerFewerPermissionPromptsSkill()
    const text = await promptText('fewer-permission-prompts')
    expect(text).toContain('.claudin/settings.json')
    // transcript dir is injected from Claudin's runtime projects dir
    expect(text).toContain('/projects/')
    expect(text).toContain('CLAUDIN_CONFIG_DIR')
    // does not instruct writing to the legacy .claude/settings.json
    expect(text).not.toContain('`.claude/settings.json`')
  })
})

describe('refresh-rules skill', () => {
  test('scopes the scan to this project and forbids rewriting an existing rule', async () => {
    registerRefreshRulesSkill()
    const text = await promptText('refresh-rules')
    // A single project dir, not the whole projects/ tree: rules are
    // project-scoped, unlike the permissions allowlist.
    expect(text).toContain('/projects/')
    expect(text).not.toContain('across the projects dir')
    expect(text).toContain('do not write anything')
    expect(text).toContain('.claudin/rules/search-strategy.md')
  })

  test('embeds the mechanical findings so the model does not re-derive them', async () => {
    registerRefreshRulesSkill()
    const text = await promptText('refresh-rules')
    expect(text).toContain('rule file(s)')
    expect(text).toMatch(/Always-loaded rules: \d+/)
  })

  test('states the create threshold and the supported frontmatter key', async () => {
    registerRefreshRulesSkill()
    const text = await promptText('refresh-rules')
    expect(text).toContain('20 sessions')
    expect(text).toContain('`paths` is the ONLY supported key')
    expect(text).toContain('globs:')
  })
})
