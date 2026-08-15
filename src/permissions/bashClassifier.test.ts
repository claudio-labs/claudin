import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import {
  createPromptRuleContent,
  extractPromptDescription,
  getBashPromptAllowDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptDenyDescriptions,
  PROMPT_PREFIX,
} from 'src/permissions/bashClassifier.js'

const ctx = (rulesByBucket: {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}): ToolPermissionContext =>
  ({
    mode: 'auto',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: rulesByBucket.allow
      ? { localSettings: rulesByBucket.allow }
      : {},
    alwaysDenyRules: rulesByBucket.deny
      ? { localSettings: rulesByBucket.deny }
      : {},
    alwaysAskRules: rulesByBucket.ask
      ? { localSettings: rulesByBucket.ask }
      : {},
    isBypassPermissionsModeAvailable: false,
  }) as unknown as ToolPermissionContext

describe('extractPromptDescription', () => {
  test('extracts the description after prompt:', () => {
    expect(extractPromptDescription('prompt: list git remotes')).toBe(
      'list git remotes',
    )
  })

  test('handles leading whitespace', () => {
    expect(extractPromptDescription('  prompt:   foo bar')).toBe('foo bar')
  })

  test('is case-insensitive on the prefix', () => {
    expect(extractPromptDescription('Prompt: foo')).toBe('foo')
  })

  test('returns null for non-prompt rules', () => {
    expect(extractPromptDescription('npm install:*')).toBeNull()
    expect(extractPromptDescription('git status')).toBeNull()
  })

  test('returns null for empty / undefined input', () => {
    expect(extractPromptDescription(undefined)).toBeNull()
    expect(extractPromptDescription('')).toBeNull()
    expect(extractPromptDescription('prompt:   ')).toBeNull()
  })
})

describe('createPromptRuleContent', () => {
  test('produces "prompt: <description>"', () => {
    expect(createPromptRuleContent('list git remotes')).toBe(
      `${PROMPT_PREFIX} list git remotes`,
    )
  })

  test('trims the description', () => {
    expect(createPromptRuleContent('  foo  ')).toBe(`${PROMPT_PREFIX} foo`)
  })
})

describe('get*PromptDescriptions', () => {
  test('returns descriptions only for Bash(prompt:...) rules in the matching bucket', () => {
    const c = ctx({
      allow: [
        'Bash(prompt: list git remotes)',
        'Bash(npm install:*)',
        'Read(/etc/passwd)',
      ],
      deny: ['Bash(prompt: install global npm packages)'],
      ask: ['Bash(prompt: connect to production database)'],
    })

    expect(getBashPromptAllowDescriptions(c)).toEqual(['list git remotes'])
    expect(getBashPromptDenyDescriptions(c)).toEqual([
      'install global npm packages',
    ])
    expect(getBashPromptAskDescriptions(c)).toEqual([
      'connect to production database',
    ])
  })

  test('deduplicates descriptions across sources', () => {
    const c = {
      mode: 'auto',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {
        localSettings: ['Bash(prompt: list git remotes)'],
        userSettings: ['Bash(prompt: list git remotes)'],
        projectSettings: ['Bash(prompt: run jest tests)'],
      },
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    } as unknown as ToolPermissionContext

    expect(getBashPromptAllowDescriptions(c)).toEqual([
      'list git remotes',
      'run jest tests',
    ])
  })

  test('returns empty array when no prompt rules exist', () => {
    expect(
      getBashPromptAllowDescriptions(
        ctx({ allow: ['Bash(npm install:*)'] }),
      ),
    ).toEqual([])
  })

  test('ignores prompt-shaped rules on tools other than Bash', () => {
    expect(
      getBashPromptAllowDescriptions(
        ctx({ allow: ['Read(prompt: read sensitive files)'] }),
      ),
    ).toEqual([])
  })
})
