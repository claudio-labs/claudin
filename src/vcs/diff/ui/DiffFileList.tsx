import figures from 'figures'
import { basename } from 'path'
import React, { useMemo } from 'react'
import type { DiffFile } from 'src/vcs/diff/hooks/useDiffData.js'
import { Box, Text } from 'src/terminal/ink.js'
import { truncateStartToWidth, truncateToWidth } from 'src/shared/text/format.js'
import { entityColorByIndex } from 'src/vcs/diff/ui/entityColor.js'
import { buildTreeRows, type TreeRow } from 'src/vcs/diff/ui/fileTree.js'
import { getDiffGlyphs } from 'src/vcs/diff/ui/glyphs.js'
import type { RepoGroup } from 'src/vcs/diff/ui/types.js'

export { buildTreeRows, type TreeRow }

/** The colour vocabulary `<Text>` accepts (theme key or raw colour). */
type TextColor = React.ComponentProps<typeof Text>['color']

/**
 * Row width used when the list is the whole body (no side pane). Without a cap
 * the list stretches across the terminal and strands the right-hand badge
 * column (binary/large/renamed) a hundred columns from the file names.
 */
export const INLINE_LIST_WIDTH = 80

type Props = {
  /** Pre-built, collapse-aware tree rows (see buildTreeRows). */
  rows: TreeRow[]
  /** Index into `rows` of the highlighted row. */
  selectedIndex: number
  /** Visible window size (rows available for tree rows). */
  maxVisible: number
  /** Left-pane content width. */
  width: number
  /**
   * Optional per-path git status (relative path → color). When set, matching
   * file rows are tinted (used by /explorer; /diff leaves it undefined).
   */
  statusByPath?: Map<string, string>
  /**
   * Indent file rows by the folder caret width so file names line up under
   * sibling folder names (a real file tree). /explorer sets this; /diff (where
   * files nest under folders at deeper depths) leaves it off.
   */
  alignFiles?: boolean
}

/** Center a fixed-size window of `maxVisible` rows on the selected row. */
function windowRange(
  total: number,
  selected: number,
  maxVisible: number,
): { start: number; end: number } {
  if (total <= maxVisible) return { start: 0, end: total }
  let start = Math.max(0, selected - Math.floor(maxVisible / 2))
  let end = start + maxVisible
  if (end > total) {
    end = total
    start = Math.max(0, end - maxVisible)
  }
  return { start, end }
}

/**
 * Flatten the per-repo groups into the global selectable file order (still used
 * by the dialog for the "any files at all?" check and first-file selection).
 */
export function flattenGroupFiles(groups: RepoGroup[]): DiffFile[] {
  return groups.flatMap(g => g.files)
}

// ── rendering ─────────────────────────────────────────────────────────────

export function DiffFileList({
  rows,
  selectedIndex,
  maxVisible,
  width,
  statusByPath,
  alignFiles,
}: Props): React.ReactNode {
  const glyphs = useMemo(getDiffGlyphs, [])
  const total = rows.length

  if (total === 0) return <Text dimColor>No changed files</Text>

  const { start, end } = windowRange(total, selectedIndex, maxVisible)

  const rendered: React.ReactNode[] = []
  for (let idx = start; idx < end; idx++) {
    const row = rows[idx]!
    rendered.push(
      <TreeRowItem
        key={idx}
        row={row}
        isSelected={idx === selectedIndex}
        width={width}
        glyphs={glyphs}
        alignFiles={alignFiles}
        statusColor={
          row.kind === 'file'
            ? // The map is only ever filled with theme colour names (see
              // STATUS_COLORS in ExplorerDialog); its declared value type is
              // the wider `string` because the Map is built there.
              (statusByPath?.get(row.file.path) as TextColor)
            : undefined
        }
      />,
    )
  }

  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>{` ↑ ${start} more`}</Text>}
      {rendered}
      {end < total && <Text dimColor>{` ↓ ${total - end} more`}</Text>}
    </Box>
  )
}

function TreeRowItem({
  row,
  isSelected,
  width,
  glyphs,
  statusColor,
  alignFiles,
}: {
  row: TreeRow
  isSelected: boolean
  width: number
  glyphs: ReturnType<typeof getDiffGlyphs>
  statusColor?: TextColor
  alignFiles?: boolean
}): React.ReactNode {
  if (row.kind === 'group') {
    const lead = isSelected ? `${glyphs.pointer} ` : '  '
    const caret = row.collapsed ? figures.triangleRight : figures.triangleDown
    return (
      <Text dimColor={!isSelected} bold={isSelected}>
        {`${lead}${caret} `}
        {glyphs.repoIcon && (
          <Text color={entityColorByIndex(row.repoIndex)} dimColor={false}>
            {`${glyphs.repoIcon} `}
          </Text>
        )}
        {row.name}
        {'  '}
        <Text bold>{row.meta}</Text>
        {row.branch && (
          <Text>{`  ${glyphs.branchIcon ? `${glyphs.branchIcon} ` : '· '}${row.branch}`}</Text>
        )}
      </Text>
    )
  }

  const lead = isSelected ? `${glyphs.pointer} ` : '  '
  // Pre-rendered tree guides (│ continuing, └ last child, blank ended). Kept
  // dim so the labels stay the focus; the inverse selection highlight overrides
  // the dim on the active row.
  const guides = row.guides
  // Columns consumed before the label: lead (2) + per-level indent (2 each).
  const indentWidth = 2 + row.depth * 2

  if (row.kind === 'dir') {
    const caret = row.collapsed ? figures.triangleRight : figures.triangleDown
    const icon = glyphs.folderIcon(!row.collapsed)
    const iconPrefix = icon ? `${icon} ` : ''
    // caret + space (2) + optional icon + space (2). Keep the deepest folder
    // (start-truncate) since the compacted label's tail is the most specific.
    const budget = Math.max(4, width - indentWidth - 2 - (iconPrefix ? 2 : 0) - 1)
    const label = truncateStartToWidth(row.label, budget)
    return (
      <Box width={width} flexDirection="row">
        <Box flexShrink={1} overflow="hidden">
          <Text wrap="truncate" bold={isSelected} inverse={isSelected}>
            {lead}
            <Text dimColor={!isSelected}>{guides}</Text>
            {`${caret} ${iconPrefix}${label}`}
          </Text>
        </Box>
        <Box flexGrow={1} />
      </Box>
    )
  }

  // file row
  const icon = glyphs.fileIcon(row.file.path)
  const iconPrefix = icon ? `${icon} ` : ''
  // Pad files by the folder caret width so their names line up under sibling
  // folder names (a real file tree). Off by default — /diff keeps files flush.
  const caretPad = alignFiles ? '  ' : ''
  // Reserve room on the right for the rare status badge (binary/large/renamed).
  const rightReserve =
    row.file.isBinary || row.file.isLargeFile || row.file.renamedFrom ? 9 : 0
  const budget = Math.max(
    4,
    width - indentWidth - caretPad.length - (iconPrefix ? 2 : 0) - rightReserve - 1,
  )
  // Folder rows carry the path; files show only their basename, end-truncated
  // ("asdasdsadsd…") so the start of the name stays visible when it overflows.
  // A row with an explicit `label` (a path, from a flat list) is start-
  // truncated instead, keeping the file name itself visible.
  const name = row.label
    ? truncateStartToWidth(row.label, budget)
    : truncateToWidth(basename(row.file.path), budget)
  return (
    <Box width={width} flexDirection="row">
      <Box flexShrink={1} overflow="hidden">
        <Text wrap="truncate" bold={isSelected} inverse={isSelected}>
          {lead}
          <Text dimColor={!isSelected}>{guides}</Text>
          {caretPad}
          {iconPrefix}
          {statusColor && !isSelected ? (
            <Text color={statusColor}>{name}</Text>
          ) : (
            name
          )}
        </Text>
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0}>
        <FileStats file={row.file} isSelected={isSelected} />
      </Box>
    </Box>
  )
}

function FileStats({
  file,
  isSelected,
}: {
  file: DiffFile
  isSelected: boolean
}): React.ReactNode {
  if (file.isBinary) {
    return (
      <Text dimColor={!isSelected} italic wrap="truncate">
        binary
      </Text>
    )
  }
  if (file.isLargeFile) {
    return (
      <Text dimColor={!isSelected} italic wrap="truncate">
        large
      </Text>
    )
  }
  // Per-file +/- churn counts and the (truncated) marker now live on the diff
  // pane's title for the selected file, so the rows stay clean. Only the
  // rename badge survives here.
  if (file.renamedFrom) {
    return (
      <Text dimColor={!isSelected} italic wrap="truncate">
        renamed
      </Text>
    )
  }
  return null
}
