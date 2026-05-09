import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import figures from 'figures'
import React from 'react'
import stripAnsi from 'strip-ansi'

import type { LspServerRow } from '../../services/lsp/builtinServers.js'

// MACRO is a build-time replacement; mirror what other component tests do.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }

// Mock LSP user settings so the component reads a deterministic master toggle
// state instead of the developer's home directory.
const realUserSettings = { ...(await import('../../services/lsp/userSettings.js')) }
const mockIsLspGloballyEnabled = mock(() => true)
mock.module('../../services/lsp/userSettings.js', () => ({
  ...realUserSettings,
  isLspGloballyEnabled: mockIsLspGloballyEnabled,
}))

// Mock settings writer so the toggle path doesn't try to mutate disk.
const realSettings = { ...(await import('../../utils/settings/settings.js')) }
const mockUpdateSettings = mock(() => {})
mock.module('../../utils/settings/settings.js', () => ({
  ...realSettings,
  updateSettingsForSource: mockUpdateSettings,
}))

// Quiet the keybinding hook — we don't drive interactive flow in these tests.
mock.module('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: () => {},
  useKeybindings: () => {},
}))

// Import after mocks are registered.
const { LspListPanel } = await import('./LspListPanel.js')
const { renderToString } = await import('../../utils/staticRender.js')

function row(overrides: Partial<LspServerRow> & { name: string; status: LspServerRow['status'] }): LspServerRow {
  return {
    name: overrides.name,
    status: overrides.status,
    installer: overrides.installer ?? 'npm',
    disabled: overrides.disabled ?? overrides.status === '⊘ disabled',
    managed: overrides.managed ?? false,
    found: overrides.found ?? overrides.status === '✓ detected',
    languages: overrides.languages ?? ['lang'],
    extensions: overrides.extensions ?? ['.ext'],
  }
}

const SAMPLE_ROWS: LspServerRow[] = [
  row({ name: 'typescript-language-server', status: '✓ detected' }),
  row({ name: 'pyright', status: '✓ detected' }),
  row({ name: 'rust-analyzer', status: '✗ missing', installer: 'github' }),
  row({ name: 'gopls', status: '✗ missing', installer: 'go install' }),
  row({ name: 'dart', status: '✗ missing', installer: 'manual (SDK)' }),
  row({ name: 'yaml-language-server', status: '⊘ disabled' }),
]

describe('<LspListPanel />', () => {
  beforeEach(() => {
    mockIsLspGloballyEnabled.mockReset()
    mockIsLspGloballyEnabled.mockReturnValue(true)
    mockUpdateSettings.mockReset()
  })

  afterAll(() => {
    mock.module('../../services/lsp/userSettings.js', () => realUserSettings)
    mock.module('../../utils/settings/settings.js', () => realSettings)
  })

  test('renders title "LSP servers" and subtitle with counts', async () => {
    const out = await renderToString(
      <LspListPanel rows={SAMPLE_ROWS} onSelectServer={() => {}} onComplete={() => {}} />,
      120,
    )
    const text = stripAnsi(out)
    expect(text).toContain('LSP servers')
    expect(text).toContain('6 servers')
    expect(text).toContain('2 detected')
    expect(text).toContain('3 missing')
    expect(text).toContain('1 disabled')
  })

  test('groups servers under Detected / Missing / Disabled headings', async () => {
    const out = await renderToString(
      <LspListPanel rows={SAMPLE_ROWS} onSelectServer={() => {}} onComplete={() => {}} />,
      120,
    )
    const text = stripAnsi(out)
    expect(text).toContain('Detected (2)')
    expect(text).toContain('Missing (3)')
    expect(text).toContain('Disabled (1)')
    // Heading order: Detected appears before Missing, Missing before Disabled.
    expect(text.indexOf('Detected (2)')).toBeLessThan(text.indexOf('Missing (3)'))
    expect(text.indexOf('Missing (3)')).toBeLessThan(text.indexOf('Disabled (1)'))
  })

  test('skips empty groups', async () => {
    const allDetected = [
      row({ name: 'typescript-language-server', status: '✓ detected' }),
      row({ name: 'pyright', status: '✓ detected' }),
    ]
    const out = await renderToString(
      <LspListPanel rows={allDetected} onSelectServer={() => {}} onComplete={() => {}} />,
      120,
    )
    const text = stripAnsi(out)
    expect(text).toContain('Detected (2)')
    expect(text).not.toContain('Missing')
    expect(text).not.toContain('Disabled')
    expect(text).not.toContain('Installing')
  })

  test('renders pointer on selected master row, two spaces on unselected server rows', async () => {
    const out = await renderToString(
      <LspListPanel rows={SAMPLE_ROWS} onSelectServer={() => {}} onComplete={() => {}} />,
      120,
    )
    const text = stripAnsi(out)
    // Master toggle is selected by default → its line shows the pointer figure.
    const masterLineRe = new RegExp(`\\${figures.pointer}\\s+LSP\\s+`)
    expect(text).toMatch(masterLineRe)
    // Server rows are not selected initially → no pointer next to their names.
    expect(text).not.toMatch(new RegExp(`\\${figures.pointer}\\s+typescript-language-server`))
  })

  test('renders status icons for each group', async () => {
    const out = await renderToString(
      <LspListPanel rows={SAMPLE_ROWS} onSelectServer={() => {}} onComplete={() => {}} />,
      120,
    )
    const text = stripAnsi(out)
    expect(text).toContain(figures.tick)       // detected
    expect(text).toContain(figures.cross)      // missing
    expect(text).toContain(figures.radioOff)   // disabled
  })

  test('renders installer hint for missing servers', async () => {
    const out = await renderToString(
      <LspListPanel rows={SAMPLE_ROWS} onSelectServer={() => {}} onComplete={() => {}} />,
      120,
    )
    const text = stripAnsi(out)
    expect(text).toContain('install via github')
    expect(text).toContain('install via go install')
    expect(text).toContain('install via Dart SDK')
  })

  test('shows the disabled banner when LSP is globally off', async () => {
    mockIsLspGloballyEnabled.mockReturnValue(false)
    const out = await renderToString(
      <LspListPanel rows={SAMPLE_ROWS} onSelectServer={() => {}} onComplete={() => {}} />,
      120,
    )
    const text = stripAnsi(out)
    expect(text).toContain('LSP is disabled')
  })

  test('renders Loading indicator when rows is empty', async () => {
    const out = await renderToString(
      <LspListPanel rows={[]} onSelectServer={() => {}} onComplete={() => {}} />,
      120,
    )
    const text = stripAnsi(out)
    expect(text).toContain('Loading')
  })
})
