import figures from 'figures'
import { describe, expect, it, test } from 'bun:test'
import { EXTENSION_ICONS } from 'src/utils/fileIcons.js'
import { renderToString } from 'src/components/staticRender.js'
import {
  getIcon,
  isPathCompletionItem,
  PromptInputFooterSuggestions,
  type SuggestionItem,
} from './PromptInputFooterSuggestions.js'

describe('PromptInputFooterSuggestions', () => {
  it('renders a visible marker for the selected suggestion', async () => {
    const suggestions: SuggestionItem[] = [
      {
        id: 'command-help',
        displayText: '/help',
        description: 'Show help',
      },
      {
        id: 'command-doctor',
        displayText: '/doctor',
        description: 'Run diagnostics',
      },
    ]

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={1}
      />,
      80,
    )

    expect(output).toContain(`${figures.pointer} /doctor`)
    expect(output).toContain('  /help')
  })
})

describe('getIcon (suggestion row icon selection)', () => {
  test('file row falls back to ASCII when Nerd Font is absent', () => {
    expect(getIcon('file-src/a.ts', 'src/a.ts', false)).toBe('+')
  })

  test('file row uses the type glyph when Nerd Font is present', () => {
    expect(getIcon('file-src/a.ts', 'src/a.ts', true)).toBe(
      EXTENSION_ICONS['.ts'],
    )
  })

  test('mcp/agent rows ignore the Nerd Font flag', () => {
    expect(getIcon('mcp-resource-x', 'x', true)).toBe('◇')
    expect(getIcon('agent-x', 'x', true)).toBe('*')
  })
})

describe('isPathCompletionItem', () => {
  test('detects directory and file path completions via metadata.type', () => {
    expect(
      isPathCompletionItem({
        id: '/x/aargau',
        displayText: 'aargau/',
        metadata: { type: 'directory' },
      }),
    ).toBe(true)
    expect(
      isPathCompletionItem({
        id: '/x/notes.txt',
        displayText: 'notes.txt',
        metadata: { type: 'file' },
      }),
    ).toBe(true)
  })

  test('rejects slash commands and scored file suggestions', () => {
    expect(
      isPathCompletionItem({ id: 'command-help', displayText: '/help' }),
    ).toBe(false)
    expect(
      isPathCompletionItem({
        id: 'file-src/a.ts',
        displayText: 'src/a.ts',
        metadata: { score: 1 },
      }),
    ).toBe(false)
  })
})
