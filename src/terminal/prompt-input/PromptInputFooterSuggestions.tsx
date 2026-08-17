import figures from 'figures'
import { memo, type ReactNode } from 'react'
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import { Box, Text } from 'src/terminal/ink.js'
import { getFileTypeIcon } from 'src/terminal/fileIcons.js'
import {
  truncatePathMiddle,
  truncateToWidth,
  truncateToWidthNoEllipsis,
} from 'src/shared/text/format.js'
import { hasNerdFontGlyphs } from 'src/terminal/terminalFont.js'
import type { Theme } from 'src/terminal/theme/theme.js'

export type SuggestionItem = {
  id: string
  displayText: string
  tag?: string
  description?: string
  metadata?: unknown
  color?: keyof Theme
}

export type SuggestionType =
  | 'command'
  | 'file'
  | 'directory'
  | 'agent'
  | 'shell'
  | 'custom-title'
  | 'slack-channel'
  | 'none'

// Visible-row window for the suggestion menu: at least MIN, at most MAX,
// otherwise tracks the terminal height (leaving 2 rows for the prompt).
export const MIN_VISIBLE_ITEMS = 8
export const MAX_VISIBLE_ITEMS = 15

// Command descriptions wrap onto this many rows instead of being cut to one
// line — most of them are a full sentence, and a single ellipsized line hid the
// part that says when to use the command.
export const MAX_DESCRIPTION_LINES = 2

const SELECTED_PREFIX = `${figures.pointer} `
const UNSELECTED_PREFIX = '  '
const PREFIX_WIDTH = stringWidth(SELECTED_PREFIX)

const WHITESPACE_RUN_RE = /\s+/g

// Env-derived terminal capability can't change mid-session, so resolve the
// Nerd Font gate once at module load — the row re-renders on every keystroke.
const NERD = hasNerdFontGlyphs()

export function getIcon(itemId: string, displayText: string, nerd: boolean): string {
  if (itemId.startsWith('file-')) {
    return nerd ? getFileTypeIcon(displayText) : '+'
  }
  if (itemId.startsWith('mcp-resource-')) return '◇'
  if (itemId.startsWith('agent-')) return '*'
  return '+'
}

function isUnifiedSuggestion(itemId: string): boolean {
  return (
    itemId.startsWith('file-') ||
    itemId.startsWith('mcp-resource-') ||
    itemId.startsWith('agent-')
  )
}

// Path/directory completions (e.g. `@../`, `@~/`, `/add-dir`) come from
// directoryCompletion.ts with a plain path id (no `file-` prefix), so they
// render through the non-unified branch below. They carry `metadata.type`,
// which lets us give them the same file/folder glyph as the unified rows.
export function isPathCompletionItem(item: SuggestionItem): boolean {
  const type = (item.metadata as { type?: unknown } | undefined)?.type
  return type === 'directory' || type === 'file'
}

/**
 * Word-wraps a description into at most `maxLines` lines of `width` columns.
 * Whatever does not fit is folded into the last line and ellipsized there, so a
 * long description degrades to the previous single-line behavior when the
 * column is narrow instead of disappearing.
 */
export function wrapDescription(
  description: string,
  width: number,
  maxLines: number,
): string[] {
  if (width <= 0 || maxLines <= 0) return []
  const text = description.replace(WHITESPACE_RUN_RE, ' ').trim()
  if (text === '') return []

  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    if (current === '') {
      current = word
    } else if (stringWidth(current) + 1 + stringWidth(word) <= width) {
      current = `${current} ${word}`
    } else {
      lines.push(current)
      current = word
    }
    // A single word wider than the column still has to break somewhere.
    while (stringWidth(current) > width) {
      const head = truncateToWidthNoEllipsis(current, width)
      if (head === '') break
      lines.push(head)
      current = current.slice(head.length)
    }
    if (lines.length > maxLines) break
  }
  if (current !== '') lines.push(current)

  if (lines.length <= maxLines) return lines
  const merged = lines.slice(maxLines - 1).join(' ')
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] =
    stringWidth(merged) <= width ? merged : truncateToWidth(merged, width)
  return kept
}

type CommandRowLayout = {
  displayText: string
  displayTextWidth: number
  pathIcon: string
  tagText: string
  descriptionLines: string[]
}

// Shared by the row renderer and by the height budget in the parent, so the
// window never claims more rows than the wrapped descriptions actually paint.
function layoutCommandRow(
  item: SuggestionItem,
  columns: number,
  maxColumnWidth: number | undefined,
): CommandRowLayout {
  const maxNameWidth = Math.floor(columns * 0.4)
  const displayTextWidth = Math.min(
    maxColumnWidth ?? stringWidth(item.displayText) + 5,
    maxNameWidth,
  )

  let displayText = item.displayText
  if (stringWidth(displayText) > displayTextWidth - 2) {
    displayText = truncateToWidth(displayText, displayTextWidth - 2)
  }

  const pathIcon = isPathCompletionItem(item)
    ? `${NERD ? getFileTypeIcon(item.displayText) : '+'} `
    : ''
  const tagText = item.tag ? `[${item.tag}] ` : ''
  const descriptionWidth = Math.max(
    0,
    columns - PREFIX_WIDTH - displayTextWidth - stringWidth(tagText) - 4,
  )
  const descriptionLines = item.description
    ? wrapDescription(item.description, descriptionWidth, MAX_DESCRIPTION_LINES)
    : []

  return { displayText, displayTextWidth, pathIcon, tagText, descriptionLines }
}

export function countSuggestionRows(
  item: SuggestionItem,
  columns: number,
  maxColumnWidth: number | undefined,
): number {
  if (isUnifiedSuggestion(item.id)) return 1
  return Math.max(1, layoutCommandRow(item, columns, maxColumnWidth).descriptionLines.length)
}

const SuggestionItemRow = memo(function SuggestionItemRow({
  item,
  maxColumnWidth,
  isSelected,
}: {
  item: SuggestionItem
  maxColumnWidth?: number
  isSelected: boolean
}): ReactNode {
  const columns = useTerminalSize().columns
  const selectionPrefix = isSelected ? SELECTED_PREFIX : UNSELECTED_PREFIX
  const rowBackgroundColor: keyof Theme | undefined = isSelected
    ? 'suggestion'
    : undefined
  const textColor: keyof Theme | undefined = isSelected ? 'inverseText' : undefined

  if (isUnifiedSuggestion(item.id)) {
    const icon = getIcon(item.id, item.displayText, NERD)
    const dimColor = !isSelected
    const isFile = item.id.startsWith('file-')
    const isMcpResource = item.id.startsWith('mcp-resource-')
    const iconWidth = 2
    const paddingWidth = 4
    const separatorWidth = item.description ? 3 : 0

    let displayText: string
    if (isFile) {
      const descReserve = item.description
        ? Math.min(20, stringWidth(item.description))
        : 0
      const maxPathLength =
        columns -
        PREFIX_WIDTH -
        iconWidth -
        paddingWidth -
        separatorWidth -
        descReserve
      displayText = truncatePathMiddle(item.displayText, maxPathLength)
    } else if (isMcpResource) {
      displayText = truncateToWidth(item.displayText, 30)
    } else {
      displayText = item.displayText
    }

    const availableWidth =
      columns -
      PREFIX_WIDTH -
      iconWidth -
      stringWidth(displayText) -
      separatorWidth -
      paddingWidth

    let lineContent: string
    if (item.description) {
      const truncatedDesc = truncateToWidth(
        item.description.replace(/\s+/g, ' '),
        Math.max(0, availableWidth),
      )
      lineContent = `${selectionPrefix}${icon} ${displayText} - ${truncatedDesc}`
    } else {
      lineContent = `${selectionPrefix}${icon} ${displayText}`
    }

    return (
      <Box width="100%" opaque={true} backgroundColor={rowBackgroundColor}>
        <Text color={textColor} dimColor={dimColor} bold={isSelected} wrap="truncate">
          {lineContent}
        </Text>
      </Box>
    )
  }

  const { displayText, displayTextWidth, pathIcon, tagText, descriptionLines } =
    layoutCommandRow(item, columns, maxColumnWidth)

  const paddedDisplayText =
    selectionPrefix +
    pathIcon +
    displayText +
    ' '.repeat(Math.max(0, displayTextWidth - stringWidth(displayText)))
  // Continuation rows keep the name column empty so the description reads as
  // one paragraph under its own column.
  const continuationIndent = ' '.repeat(
    stringWidth(paddedDisplayText) + stringWidth(tagText),
  )
  const lines =
    descriptionLines.length > 0
      ? descriptionLines.map((line, index) =>
          index === 0
            ? `${paddedDisplayText}${tagText}${line}`
            : `${continuationIndent}${line}`,
        )
      : [`${paddedDisplayText}${tagText}`]

  return (
    <Box
      flexDirection="column"
      width="100%"
      opaque={true}
      backgroundColor={rowBackgroundColor}
    >
      {lines.map((line, index) => (
        <Text
          key={index}
          color={textColor}
          dimColor={!isSelected}
          bold={isSelected}
          wrap="truncate"
        >
          {line}
        </Text>
      ))}
    </Box>
  )
})

type Props = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  maxColumnWidth?: number
  overlay?: boolean
}

export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth: maxColumnWidthProp,
  overlay,
}: Props): ReactNode {
  const { columns, rows } = useTerminalSize()
  // Prefer MIN..MAX rows when the terminal can fit MIN, but on short
  // terminals/split panes fall back to whatever fits (floor 1) so the menu
  // never overflows and pushes the prompt off-screen.
  const available = Math.max(1, rows - 2)
  const itemCap =
    available >= MIN_VISIBLE_ITEMS
      ? Math.min(MAX_VISIBLE_ITEMS, available)
      : available

  if (suggestions.length === 0) {
    return null
  }

  const maxColumnWidth =
    maxColumnWidthProp ??
    Math.max(...suggestions.map(item => stringWidth(item.displayText))) + 5

  // A wrapped description paints more than one row, so the item cap alone no
  // longer bounds the menu height — shrink the window until the rows it will
  // actually paint fit the budget.
  const rowHeights = suggestions.map(item =>
    countSuggestionRows(item, columns, maxColumnWidth),
  )
  const windowStart = (count: number): number =>
    Math.max(
      0,
      Math.min(
        selectedSuggestion - Math.floor(count / 2),
        suggestions.length - count,
      ),
    )

  let maxVisibleItems = Math.min(itemCap, suggestions.length)
  while (maxVisibleItems > 1) {
    const start = windowStart(maxVisibleItems)
    const painted = rowHeights
      .slice(start, start + maxVisibleItems)
      .reduce((sum, height) => sum + height, 0)
    if (painted <= available) break
    maxVisibleItems--
  }

  const startIndex = windowStart(maxVisibleItems)
  const endIndex = Math.min(startIndex + maxVisibleItems, suggestions.length)
  const visibleItems = suggestions.slice(startIndex, endIndex)

  return (
    <Box
      flexDirection="column"
      justifyContent={overlay ? undefined : 'flex-end'}
    >
      {visibleItems.map(item => (
        <SuggestionItemRow
          key={`${item.id}:${item.id === suggestions[selectedSuggestion]?.id ? 'selected' : 'idle'}`}
          item={item}
          maxColumnWidth={maxColumnWidth}
          isSelected={item.id === suggestions[selectedSuggestion]?.id}
        />
      ))}
    </Box>
  )
}

export default memo(PromptInputFooterSuggestions)
