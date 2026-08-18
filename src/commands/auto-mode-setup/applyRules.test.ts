import { describe, expect, test } from 'bun:test'

import type { EditableSettingSource } from 'src/platform/settings/constants.js'
import type { SettingsJson } from 'src/platform/settings/types.js'
import {
  AUTO_MODE_WRITE_TARGET,
  type ApplyRulesDeps,
  applyRules,
  diffRules,
  enableAutoMode,
  isNoOpDiff,
} from 'src/commands/auto-mode-setup/applyRules.js'

function recordingDeps(): {
  deps: ApplyRulesDeps
  writes: { source: EditableSettingSource; settings: SettingsJson }[]
} {
  const writes: { source: EditableSettingSource; settings: SettingsJson }[] = []
  return {
    writes,
    deps: {
      writeSettings: (source, settings) => {
        writes.push({ source, settings })
        return { error: null }
      },
    },
  }
}

const proposed = {
  allow: ['$defaults', 'Running bun run build'],
  soft_deny: ['$defaults', 'Pushing to main'],
  environment: ['$defaults'],
}

describe('diffRules', () => {
  test('reports everything as added when nothing is configured yet', () => {
    const diff = diffRules(null, proposed)
    expect(diff.find(d => d.section === 'allow')?.added).toEqual([
      '$defaults',
      'Running bun run build',
    ])
    expect(isNoOpDiff(diff)).toBe(false)
  })

  test('separates added, kept and removed on a re-run', () => {
    const diff = diffRules(
      {
        allow: ['$defaults', 'Reading anything under /tmp'],
        soft_deny: ['$defaults', 'Pushing to main'],
        environment: ['$defaults'],
      },
      proposed,
    )
    const allow = diff.find(d => d.section === 'allow')
    expect(allow?.added).toEqual(['Running bun run build'])
    expect(allow?.kept).toEqual(['$defaults'])
    expect(allow?.removed).toEqual(['Reading anything under /tmp'])
  })

  test('recognises a proposal that changes nothing', () => {
    expect(isNoOpDiff(diffRules(proposed, proposed))).toBe(true)
  })
})

describe('applyRules', () => {
  test('writes only the three rule sections, to the user settings', () => {
    const { deps, writes } = recordingDeps()
    const result = applyRules({ ...proposed }, deps)

    expect(result.error).toBeNull()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.source).toBe('userSettings')
    expect(writes[0]?.settings).toEqual({
      autoMode: {
        allow: ['$defaults', 'Running bun run build'],
        soft_deny: ['$defaults', 'Pushing to main'],
        environment: ['$defaults'],
      },
    })
  })

  test('never writes a repo-controlled settings file', () => {
    // A repo can ship both of these, so getAutoModeConfig ignores them; writing
    // there would produce a config that looks applied and does nothing.
    expect(AUTO_MODE_WRITE_TARGET).toBe('userSettings')
  })

  test('does not persist the notes', () => {
    const { deps, writes } = recordingDeps()
    applyRules({ ...proposed, notes: ['a note'] } as never, deps)
    expect(JSON.stringify(writes[0]?.settings)).not.toContain('a note')
  })
})

describe('enableAutoMode', () => {
  test('records the opt-in without touching the default mode', () => {
    const { deps, writes } = recordingDeps()
    enableAutoMode(false, deps)
    expect(writes[0]?.settings).toEqual({ skipAutoPermissionPrompt: true })
  })

  test('sets the default mode when asked', () => {
    const { deps, writes } = recordingDeps()
    enableAutoMode(true, deps)
    expect(writes[0]?.settings).toEqual({
      skipAutoPermissionPrompt: true,
      permissions: { defaultMode: 'auto' },
    })
  })
})
