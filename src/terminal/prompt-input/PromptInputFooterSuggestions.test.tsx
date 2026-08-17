import figures from 'figures'
import { describe, expect, it, test } from 'bun:test'
import { EXTENSION_ICONS } from 'src/terminal/fileIcons.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import {
  countSuggestionRows,
  getIcon,
  isPathCompletionItem,
  PromptInputFooterSuggestions,
  wrapDescription,
  type SuggestionItem,
} from 'src/terminal/prompt-input/PromptInputFooterSuggestions.js'

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

  it('wraps a long command description onto a second row', async () => {
    const suggestions: SuggestionItem[] = [
      {
        id: 'command-code-review',
        displayText: '/code-review',
        description:
          'Review the current diff for correctness bugs and reuse cleanups at the given effort level',
      },
    ]

    const output = await renderToString(
      <PromptInputFooterSuggestions
        suggestions={suggestions}
        selectedSuggestion={0}
      />,
      80,
    )

    const lines = output.split('\n').filter(line => line.trim() !== '')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Review the current diff')
    // The tail that the old single-line render ellipsized away.
    expect(lines[1]).toContain('effort level')
    // Continuation aligns under the description column, not under the name.
    expect(lines[1]).not.toContain('/code-review')
  })
})

describe('wrapDescription', () => {
  test('keeps a short description on one line', () => {
    expect(wrapDescription('Show help', 40, 2)).toEqual(['Show help'])
  })

  test('breaks on word boundaries and collapses whitespace runs', () => {
    expect(wrapDescription('alpha  beta\ngamma delta', 11, 3)).toEqual([
      'alpha beta',
      'gamma delta',
    ])
  })

  test('ellipsizes the overflow into the last allowed line', () => {
    const lines = wrapDescription('one two three four five six', 9, 2)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('one two')
    expect(lines[1]!.endsWith('…')).toBe(true)
    expect(lines[1]).toContain('three')
  })

  test('hard-breaks a word wider than the column', () => {
    expect(wrapDescription('supercalifragilistic', 5, 2)).toEqual([
      'super',
      'cali…',
    ])
  })

  test('returns nothing for an empty description or a zero-width column', () => {
    expect(wrapDescription('   ', 20, 2)).toEqual([])
    expect(wrapDescription('anything', 0, 2)).toEqual([])
  })
})

describe('countSuggestionRows', () => {
  test('unified (file/agent) rows always paint a single line', () => {
    expect(
      countSuggestionRows(
        {
          id: 'file-src/a.ts',
          displayText: 'src/a.ts',
          description: 'a '.repeat(200),
        },
        80,
        20,
      ),
    ).toBe(1)
  })

  test('a command row grows with its wrapped description', () => {
    const item: SuggestionItem = {
      id: 'command-x',
      displayText: '/x',
      description: 'word '.repeat(40),
    }
    expect(countSuggestionRows(item, 80, 20)).toBe(2)
    expect(countSuggestionRows({ ...item, description: 'short' }, 80, 20)).toBe(1)
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
