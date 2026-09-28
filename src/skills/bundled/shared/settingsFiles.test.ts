import { describe, expect, test } from 'bun:test'

import { SETTING_SOURCES } from 'src/platform/settings/constants.js'
import {
  SETTINGS_FILES,
  describeSettingsFiles,
  listResolvedSettingsFiles,
} from 'src/skills/bundled/shared/settingsFiles.js'

describe('settings files', () => {
  test('are listed in the precedence order the settings layer applies', () => {
    const listed = SETTINGS_FILES.map(file => file.source)
    expect(SETTING_SOURCES.filter(source => (listed as string[]).includes(source))).toEqual(listed)
  })

  test('are described with portable paths and the precedence chain', () => {
    const text = describeSettingsFiles()
    for (const path of ['~/.claudin/settings.json', '`.claudin/settings.json`', '`.claudin/settings.local.json`']) {
      expect(text).toContain(path)
    }
    expect(text).toContain('user → project → local')
  })

  test('are listed with the paths the resolver gives, and say so when it has none', () => {
    const text = listResolvedSettingsFiles(source =>
      source === 'localSettings' ? undefined : `/resolved/${source}.json`,
    )
    expect(text).toContain('/resolved/userSettings.json')
    expect(text).toContain('/resolved/projectSettings.json')
    expect(text).toContain('**local** (personal overrides for this project, gitignored): no path in this session')
  })
})
