import figures from 'figures'
import React from 'react'
import { Box, Text } from 'src/terminal/ink.js'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import { hasNerdFontGlyphs } from 'src/terminal/terminalFont.js'
import { useBlink } from 'src/terminal/hooks/useBlink.js'
import { truncateToWidth } from 'src/shared/text/truncate.js'
import type { Theme } from 'src/terminal/theme/theme.js'
import type {
  SessionLine,
  SessionRow,
  SessionStatus,
} from 'src/sessions/ui/sessionRows.js'

const GAP = '  '
const LEAD_WIDTH = 4 // the cursor, then the status dot
const GAPS_WIDTH = GAP.length * 5
/** The narrowest each figure column gets: its header, or its widest value. */
const MIN_AGENTS_WIDTH = 6
const MIN_TOKENS_WIDTH = 7
const MIN_COST_WIDTH = 8
const MIN_WHEN_WIDTH = 8
const MIN_FIGURES_WIDTH =
  MIN_AGENTS_WIDTH + MIN_TOKENS_WIDTH + MIN_COST_WIDTH + MIN_WHEN_WIDTH
const MIN_TITLE_WIDTH = 12
const CURRENT_SUFFIX = ' (current)'
/** Nerd Font devicon git-branch, as on the prompt's branch pill (format-branch.ts). */
const BRANCH_ICON = '\uE725'
/** Terminal rows per table line: the line, then a blank one to breathe. */
export const SESSION_LINE_ROWS = 2

const DOT_COLOR: Record<SessionStatus, keyof Theme> = {
  current: 'success',
  open: 'success',
  elsewhere: 'warning',
  inactive: 'inactive',
}

export type SessionColumns = {
  title: number
  agents: number
  place: number
  tokens: number
  cost: number
  when: number
}

/**
 * Columns that add up to exactly `width`, so the table spans the search box
 * above it: the description two fifths, the place a quarter, and the four
 * figure columns share the rest evenly — right-aligned, "When" ends on the
 * box's right edge.
 */
export function sessionColumns(width: number): SessionColumns {
  const place = Math.max(16, Math.min(60, Math.round(width * 0.25)))
  const title = Math.max(
    MIN_TITLE_WIDTH,
    Math.min(
      Math.round(width * 0.4),
      width - LEAD_WIDTH - GAPS_WIDTH - place - MIN_FIGURES_WIDTH,
    ),
  )
  const spare = Math.max(
    0,
    width - LEAD_WIDTH - GAPS_WIDTH - title - place - MIN_FIGURES_WIDTH,
  )
  const share = Math.floor(spare / 4)
  return {
    title,
    agents: MIN_AGENTS_WIDTH + share,
    place,
    tokens: MIN_TOKENS_WIDTH + share,
    cost: MIN_COST_WIDTH + share,
    // The remainder too, so the last column ends on the edge.
    when: MIN_WHEN_WIDTH + spare - share * 3,
  }
}

function padEnd(text: string, width: number): string {
  const cut = truncateToWidth(text, width)
  return cut + ' '.repeat(Math.max(0, width - stringWidth(cut)))
}

function padStart(text: string, width: number): string {
  const cut = truncateToWidth(text, width)
  return ' '.repeat(Math.max(0, width - stringWidth(cut))) + cut
}

/**
 * Fit `where` and `branch` into a pill of `width` columns, its padding
 * included. When both cannot fit, the branch stays: it says more.
 */
export function fitPlace(
  where: string,
  branch: string,
  width: number,
): { where: string; branch: string } {
  const inner = width - 2
  if (!branch) return { where: truncateToWidth(where, inner), branch: '' }
  // ' ' between them, then the icon and its space.
  const branchRoom = inner - stringWidth(where) - 3
  if (branchRoom >= Math.min(8, stringWidth(branch))) {
    return { where, branch: truncateToWidth(branch, branchRoom) }
  }
  return { where: '', branch: truncateToWidth(branch, inner - 2) }
}

/** `claudin  feat/x` on the prompt's branch-pill background. */
function PlaceCell({
  where,
  branch,
  width,
}: {
  where: string
  branch: string
  width: number
}): React.ReactNode {
  const icon = hasNerdFontGlyphs() ? BRANCH_ICON : '⎇'
  const fit = fitPlace(where, branch, width)
  const branchText = fit.branch ? `${icon} ${fit.branch}` : ''
  const pill = ` ${fit.where}${fit.where && branchText ? ' ' : ''}${branchText} `
  const trailing = ' '.repeat(Math.max(0, width - stringWidth(pill)))
  if (!fit.where && !branchText) return <Text>{' '.repeat(width)}</Text>
  return (
    <Text>
      <Text backgroundColor="messageActionsBackground">
        {` ${fit.where}${fit.where && branchText ? ' ' : ''}`}
        <Text color="suggestion">{branchText}</Text>{' '}
      </Text>
      {trailing}
    </Text>
  )
}

function SessionTableRow({
  row,
  focused,
  columns,
  dotVisible,
}: {
  row: SessionRow
  focused: boolean
  columns: SessionColumns
  dotVisible: boolean
}): React.ReactNode {
  const suffix = row.status === 'current' ? CURRENT_SUFFIX : ''
  const title = truncateToWidth(row.title, columns.title - stringWidth(suffix))
  const titlePad = ' '.repeat(Math.max(0, columns.title - stringWidth(title) - stringWidth(suffix)))
  return (
    <Text>
      <Text color="suggestion">{focused ? `${figures.pointer} ` : '  '}</Text>
      <Text color={DOT_COLOR[row.status]}>{dotVisible ? '● ' : '  '}</Text>
      <Text color={focused ? 'suggestion' : undefined} bold={focused}>
        {title}
      </Text>
      <Text dimColor>
        {suffix}
        {titlePad}
        {GAP}
      </Text>
      <Text dimColor={row.agents === '0'}>{padStart(row.agents, columns.agents)}</Text>
      {GAP}
      <PlaceCell where={row.where} branch={row.branch} width={columns.place} />
      <Text dimColor>
        {GAP}
        {padStart(row.tokens, columns.tokens)}
        {GAP}
      </Text>
      <Text color="claude">{padStart(row.cost, columns.cost)}</Text>
      <Text dimColor>
        {GAP}
        {padStart(row.when, columns.when)}
      </Text>
    </Text>
  )
}

type Props = {
  rows: readonly SessionRow[]
  lines: readonly SessionLine[]
  focusedIndex: number
  /** The first of `lines` to show, and how many (each takes SESSION_LINE_ROWS rows). */
  start: number
  height: number
  width: number
}

/**
 * The session list as a table: one line per session, every column in one
 * `<Text>` so a narrow terminal truncates it instead of wrapping columns
 * apart. Windowed by hand, since a ScrollBox only clips in fullscreen. The
 * dot of a session with a turn or agents running blinks.
 */
export function SessionsTable({
  rows,
  lines,
  focusedIndex,
  start,
  height,
  width,
}: Props): React.ReactNode {
  const [blinkRef, blinkVisible] = useBlink(rows.some(row => row.running))
  const columns = sessionColumns(width)
  const header =
    ' '.repeat(LEAD_WIDTH) +
    padEnd('Description', columns.title) +
    GAP +
    padStart('Agents', columns.agents) +
    GAP +
    padEnd('Branch/worktree', columns.place) +
    GAP +
    padStart('Tokens', columns.tokens) +
    GAP +
    padStart('Cost', columns.cost) +
    GAP +
    padStart('When', columns.when)
  const tableWidth = stringWidth(header)
  const ruleLabel = '── inactive '
  const rule = ruleLabel + '─'.repeat(Math.max(0, tableWidth - LEAD_WIDTH - stringWidth(ruleLabel)))
  return (
    <Box ref={blinkRef} flexDirection="column" flexShrink={0}>
      <Text dimColor bold>
        {header}
      </Text>
      {/* A fixed height, so the screen fills its pane however few sessions there are. */}
      <Box flexDirection="column" height={height * SESSION_LINE_ROWS}>
        {lines.slice(start, start + height).map(line =>
          line.kind === 'divider' ? (
            <Box key="divider" marginBottom={SESSION_LINE_ROWS - 1}>
              <Text dimColor>
                {' '.repeat(LEAD_WIDTH)}
                {rule}
              </Text>
            </Box>
          ) : (
            <Box key={rows[line.index]!.sessionId} marginBottom={SESSION_LINE_ROWS - 1}>
              <SessionTableRow
                row={rows[line.index]!}
                focused={line.index === focusedIndex}
                columns={columns}
                dotVisible={!rows[line.index]!.running || blinkVisible}
              />
            </Box>
          ),
        )}
      </Box>
    </Box>
  )
}
