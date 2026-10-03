import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import {
  getBashPromptAllowDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptDenyDescriptions,
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

describe('the Bash prompt-rule descriptions of a permission context', () => {
  test('each bucket yields only its own Bash(prompt: …) rules', () => {
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
