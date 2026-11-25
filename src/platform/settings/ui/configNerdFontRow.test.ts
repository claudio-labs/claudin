import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Config.tsx is not loaded by any test (it needs the whole settings dialog),
// so the "Nerd Font icons" row is pinned on its source: the decision it shows
// lives in terminalFont.ts and is tested there.
const source = readFileSync(join(import.meta.dir, 'Config.tsx'), 'utf8')
const row = source.slice(source.indexOf("id: 'nerdFontIcons'"), source.indexOf("id: 'autoUpdatesChannel'"))

describe('/config — Nerd Font icons row', () => {
  test('offers auto/on/off over the stored setting, auto by default', () => {
    expect(row).toContain('options: [...NERD_FONT_ICONS_OPTIONS]')
    expect(row).toContain("value: globalConfig.nerdFontIcons ?? 'auto'")
  })

  test('names the env pin and the resolved value in its label', () => {
    expect(row).toContain(
      "label: `Nerd Font icons (${isNerdFontForcedByEnv() ? 'env, ' : ''}${hasNerdFontGlyphs() ? 'on' : 'off'})`",
    )
  })

  test('saves the pick to global config and the in-memory copy', () => {
    expect(row.match(/nerdFontIcons: nerdFontIcons as NerdFontIconsSetting/g)).toHaveLength(2)
    expect(row).toContain('saveGlobalConfig(')
    expect(row).toContain('setGlobalConfig(')
  })

  test('reports the change when the dialog closes', () => {
    expect(source).toContain(
      "formattedChanges.push(`Set Nerd Font icons to ${chalk.bold(globalConfig.nerdFontIcons ?? 'auto')}`)",
    )
  })
})
