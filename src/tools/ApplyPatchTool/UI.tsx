import * as React from 'react'
import { useState } from 'react'
import { FilePathLink } from 'src/components/FilePathLink.js'
import { Box, Text } from 'src/ink.js'
import { getDisplayPath } from 'src/utils/fs/file.js'
import type {
  ApplyPatchChangeType,
  ApplyPatchFileResult,
  ApplyPatchOutput,
} from 'src/tools/ApplyPatchTool/applyPatch.js'
import { parsePatch } from 'src/tools/ApplyPatchTool/patchFormat.js'

const LABEL: Record<ApplyPatchChangeType, string> = {
  add: 'Write',
  update: 'Update',
  move: 'Rename',
  delete: 'Delete',
}

// Render groups in this fixed order regardless of the order files appear in the
// patch, so the summary reads consistently.
const GROUP_ORDER: ApplyPatchChangeType[] = ['add', 'update', 'move', 'delete']

function targetPath(file: ApplyPatchFileResult): string {
  return file.type === 'move' && file.movePath ? file.movePath : file.absPath
}

export function renderToolUseMessage(
  input: Partial<{ patchText: string }>,
  _options: { verbose: boolean },
): React.ReactNode {
  if (!input.patchText) return null
  // Parse opportunistically — patchText may still be streaming in.
  try {
    const count = parsePatch(input.patchText).hunks.length
    if (count === 0) return null
    return `${count} file${count === 1 ? '' : 's'}`
  } catch {
    return null
  }
}

type Group = {
  type: ApplyPatchChangeType
  files: ApplyPatchFileResult[]
  additions: number
  deletions: number
}

function groupFiles(files: ApplyPatchFileResult[]): Group[] {
  const groups: Group[] = []
  for (const type of GROUP_ORDER) {
    const groupFiles = files.filter(f => f.type === type)
    if (groupFiles.length === 0) continue
    groups.push({
      type,
      files: groupFiles,
      additions: groupFiles.reduce((n, f) => n + f.additions, 0),
      deletions: groupFiles.reduce((n, f) => n + f.deletions, 0),
    })
  }
  return groups
}

function groupLabel(group: Group): string {
  const n = group.files.length
  return `${LABEL[group.type]} ${n} file${n === 1 ? '' : 's'}`
}

// One clickable group row. The header (label + aggregate counts) carries no
// disclosure marker; clicking it (or global verbose) reveals each file under a
// "⎿" connector, matching the app's native tool-result sub-line style. (We avoid
// a "▾"/"▸" chevron on the header — the small down-triangle is tofu in some
// fonts, and a glyph glued to the label reads as cramped.) Hover brightens the
// row by dropping dimColor (so it lights up to the normal foreground) rather
// than adding bold over dimColor — the latter renders as a muddy dark-gray in
// some terminals instead of reading as "active".
function GroupRow({
  group,
  expanded,
  labelWidth,
  onToggle,
}: {
  group: Group
  expanded: boolean
  labelWidth: number
  onToggle: () => void
}): React.ReactNode {
  const [hover, setHover] = useState(false)
  const n = group.files.length
  // Pad the noun so the +/− counts stay column-aligned across rows, matching
  // groupLabel().padEnd(labelWidth) — but split out the count digit so it can
  // render bold against the dim verb/noun.
  const labelPad = ' '.repeat(Math.max(labelWidth - groupLabel(group).length, 0))
  return (
    <Box flexDirection="column">
      <Box
        flexDirection="row"
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <Text dimColor={!hover}>
          {`${LABEL[group.type]} `}
          <Text bold>{n}</Text>
          {` file${n === 1 ? '' : 's'}${labelPad}`}
        </Text>
        <Text color="success">{'  '}+{group.additions}</Text>
        <Text color="error">{' '}−{group.deletions}</Text>
      </Box>
      {expanded
        ? group.files.map(file => {
            const path = targetPath(file)
            return (
              <Box key={path} flexDirection="row">
                <Text dimColor>{'⎿  '}</Text>
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    <Text bold>{LABEL[file.type]}</Text>
                    <Text>(</Text>
                    <Text dimColor>
                      <FilePathLink filePath={path}>
                        {getDisplayPath(path)}
                      </FilePathLink>
                    </Text>
                    <Text>)</Text>
                    {file.type === 'move' ? (
                      <Text dimColor>
                        {` (renamed from ${getDisplayPath(file.absPath)})`}
                      </Text>
                    ) : null}
                  </Box>
                  {file.additions > 0 || file.deletions > 0 ? (
                    <Text dimColor>
                      {file.additions > 0 ? (
                        <>
                          Added <Text bold>{file.additions}</Text>{' '}
                          {file.additions > 1 ? 'lines' : 'line'}
                        </>
                      ) : null}
                      {file.additions > 0 && file.deletions > 0 ? ', ' : null}
                      {file.deletions > 0 ? (
                        <>
                          {file.additions === 0 ? 'R' : 'r'}emoved{' '}
                          <Text bold>{file.deletions}</Text>{' '}
                          {file.deletions > 1 ? 'lines' : 'line'}
                        </>
                      ) : null}
                    </Text>
                  ) : null}
                </Box>
              </Box>
            )
          })
        : null}
    </Box>
  )
}

function ApplyPatchResultMessage({
  files,
  verbose,
}: {
  files: ApplyPatchFileResult[]
  verbose: boolean
}): React.ReactNode {
  const [expanded, setExpanded] = useState<ReadonlySet<ApplyPatchChangeType>>(
    () => new Set(),
  )
  const groups = groupFiles(files)
  const labelWidth = Math.max(...groups.map(g => groupLabel(g).length))
  const toggle = (type: ApplyPatchChangeType) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  return (
    <Box flexDirection="column" marginLeft={3}>
      {groups.map(group => (
        <GroupRow
          key={group.type}
          group={group}
          expanded={verbose || expanded.has(group.type)}
          labelWidth={labelWidth}
          onToggle={() => toggle(group.type)}
        />
      ))}
      <Text dimColor>run /diff to review full changes</Text>
    </Box>
  )
}

export function renderToolResultMessage(
  output: ApplyPatchOutput,
  _progressMessagesForMessage: unknown,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const { files } = output
  if (files.length === 0) return null
  return <ApplyPatchResultMessage files={files} verbose={verbose} />
}
