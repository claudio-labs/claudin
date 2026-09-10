import { basename } from 'path'
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { scanMemoryFiles, type MemoryHeader } from 'src/memory/memdir/memoryScan.js'
import {
  buildMemoryDirRows,
  removeIndexPointer,
  type MemoryDirRow,
} from 'src/memory/ui/memoryDirRows.js'
import { openPath } from 'src/shared/browser.js'
import { getExternalEditor } from 'src/shared/editor.js'
import { isAbortError } from 'src/shared/errors.js'
import { getDisplayPath } from 'src/shared/fs/file.js'
import { readFileInRange } from 'src/shared/fs/readFileInRange.js'
import { parseFrontmatter } from 'src/shared/frontmatterParser.js'
import { logError } from 'src/shared/log.js'
import { ConfigurableShortcutHint } from 'src/terminal/ConfigurableShortcutHint.js'
import { SearchableSelect } from 'src/terminal/custom-select/index.js'
import { Byline } from 'src/terminal/design-system/Byline.js'
import { Box, Text } from 'src/terminal/ink.js'
import { editFileInEditor } from 'src/terminal/input/promptEditor.js'
import { useKeybinding, useKeybindings } from 'src/terminal/keybindings/useKeybinding.js'
import { Markdown } from 'src/terminal/markdown/Markdown.js'

/**
 * Browses one memory directory — the private dir, the team dir, or an agent's
 * — inside the /memory dialog: one row per memory with its frontmatter
 * description, a read-only preview of the focused one, and enter/d/o to edit,
 * delete or reveal it.
 *
 * Three constraints shape this file and are easy to undo by accident:
 *
 * 1. The preview caps what it READS rather than clipping what it renders.
 *    ScrollBox only clips inside a fullscreen root (ink-tui.md §4) and
 *    PgUp/PgDn are always consumed by ScrollKeybindingHandler (§8), so a
 *    scrollable pane here would be two traps for little gain.
 * 2. `d` and `o` are plain letters, and SearchableSelect's search mode swallows
 *    every letter — hence `onSearchModeChange` and the `isActive` gate. Without
 *    it, typing "d" in the query would open the delete confirmation.
 * 3. Esc must go back to the memory list, not close the whole dialog, so the
 *    caller renders <Dialog isCancelActive={false}> while this is mounted and
 *    lets Select's own cancel handle the key.
 */

/** Body lines shown in the preview before the "+N more lines" footer. */
const PREVIEW_BODY_LINES = 10
/** Lines read off the top of a memory: the preview body plus its frontmatter. */
const PREVIEW_READ_LINES = 40

type Preview = {
  heading: string
  body: string
  moreLines: number
}

type Props = {
  /** Absolute path of the directory to browse (may carry a trailing separator). */
  dir: string
  /** "Private memory" / "Team memory" / "code-reviewer agent memory". */
  title: string
  /** The directory's MEMORY.md, pinned as the first row when it exists. */
  indexPath: string
  /** Team memories are synced, so their delete confirmation says so. */
  isTeamDir?: boolean
  onBack: () => void
}

export function MemoryDirBrowser({
  dir,
  title,
  indexPath,
  isTeamDir = false,
  onBack,
}: Props): React.ReactNode {
  const [headers, setHeaders] = useState<MemoryHeader[] | null>(null)
  const [indexExists, setIndexExists] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [focusedPath, setFocusedPath] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<MemoryDirRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    void (async () => {
      const [scanned, indexStat] = await Promise.all([
        scanMemoryFiles(dir, controller.signal),
        stat(indexPath).then(
          () => true,
          () => false,
        ),
      ])
      if (cancelled) return
      setHeaders(scanned)
      setIndexExists(indexStat)
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [dir, indexPath, reloadToken])

  const rows = useMemo(
    () =>
      headers === null
        ? []
        : buildMemoryDirRows(headers, { indexPath, indexExists }),
    [headers, indexPath, indexExists],
  )

  const options = useMemo(
    () =>
      rows.map(row => ({
        label: row.label,
        value: row.value,
        description: row.description,
      })),
    [rows],
  )

  const focusedRow = rows.find(row => row.value === focusedPath) ?? null

  useEffect(() => {
    if (focusedPath === undefined) return
    const controller = new AbortController()

    void readFileInRange(
      focusedPath,
      0,
      PREVIEW_READ_LINES,
      undefined,
      controller.signal,
    ).then(
      result => {
        const { frontmatter, content } = parseFrontmatter(
          result.content,
          focusedPath,
        )
        const bodyLines = content.split('\n')
        const frontmatterLines =
          result.content.split('\n').length - bodyLines.length
        const shown = bodyLines.slice(0, PREVIEW_BODY_LINES)
        const type = typeof frontmatter.type === 'string' ? frontmatter.type : null
        setPreview({
          heading: type
            ? `${type} · ${basename(focusedPath, '.md')}`
            : basename(focusedPath),
          body: shown.join('\n').trim(),
          moreLines: Math.max(
            0,
            result.totalLines - frontmatterLines - shown.length,
          ),
        })
      },
      error => {
        if (isAbortError(error)) return
        logError(error)
        setPreview(null)
      },
    )

    return () => controller.abort()
  }, [focusedPath])

  const handleOpenInEditor = useCallback(
    (path: string) => {
      if (!getExternalEditor()) {
        setNotice(
          'No editor configured — set $EDITOR or $VISUAL to edit memories here.',
        )
        return
      }
      const result = editFileInEditor(path)
      if (result.error) {
        setNotice(result.error)
        return
      }
      setNotice(null)
      // The file may have gained or lost a description; re-read the directory
      // rather than leaving the row describing the pre-edit content.
      setReloadToken(token => token + 1)
    },
    [],
  )

  const handleConfirmDelete = useCallback(async () => {
    const row = pendingDelete
    if (row === null) return
    setPendingDelete(null)
    try {
      await unlink(row.value)
      // An orphan pointer is worse than the file: the index is what loads into
      // context. A dir with no index, or a memory that was never indexed, both
      // land in the no-op branch.
      const index = await readFile(indexPath, 'utf8').catch(() => null)
      if (index !== null) {
        const next = removeIndexPointer(index, basename(row.value))
        if (next !== index) await writeFile(indexPath, next, 'utf8')
      }
      setNotice(`Deleted ${basename(row.value)}`)
    } catch (error) {
      logError(error)
      setNotice(`Could not delete ${basename(row.value)}`)
    }
    setFocusedPath(undefined)
    setPreview(null)
    setReloadToken(token => token + 1)
  }, [pendingDelete, indexPath])

  const letterHandlers = useMemo(
    () => ({
      'memory:openFolder': () => {
        // mkdir first: an agent's memory dir may not exist until that agent
        // has written something, and openPath on a missing dir does nothing.
        void mkdir(dir, { recursive: true })
          .catch(() => {})
          .then(() => openPath(dir))
      },
      'memory:delete': () => {
        // Deleting the index is not an editing gesture — it is the file every
        // session loads, and nothing here would rebuild it.
        if (focusedRow === null || focusedRow.isIndex) return false
        setPendingDelete(focusedRow)
      },
    }),
    [dir, focusedRow],
  )

  useKeybindings(letterHandlers, {
    context: 'Memory',
    isActive: !isSearchMode && pendingDelete === null,
  })

  useKeybinding('confirm:yes', () => void handleConfirmDelete(), {
    context: 'Confirmation',
    isActive: pendingDelete !== null,
  })
  useKeybinding('confirm:no', () => setPendingDelete(null), {
    context: 'Confirmation',
    isActive: pendingDelete !== null,
  })

  if (headers === null) {
    return (
      <Box flexDirection="column" width="100%">
        <Text dimColor>Reading {getDisplayPath(dir)}…</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width="100%">
      {/* One logical line, one <Text> — sibling <Text> in a Box are columns
          that wrap independently (ink-tui.md §10). */}
      <Box marginBottom={1}>
        <Text bold>
          {title}
          <Text dimColor> · {getDisplayPath(dir)}</Text>
        </Text>
      </Box>

      {rows.length === 0 ? (
        <Text dimColor>
          No memories here yet. They appear as Claudin saves them.
        </Text>
      ) : (
        <SearchableSelect
          options={options}
          visibleOptionCount={5}
          showOverflowCount
          searchPlaceholder="Search memories…"
          isDisabled={pendingDelete !== null}
          onSearchModeChange={setIsSearchMode}
          onFocus={setFocusedPath}
          onChange={handleOpenInEditor}
          onCancel={onBack}
        />
      )}

      {pendingDelete !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="error">
            Delete {basename(pendingDelete.value)}?
          </Text>
          <Text dimColor>
            {isTeamDir
              ? 'Shared memory — the deletion reaches the team on the next sync. Its line in MEMORY.md goes too.'
              : 'Its line in MEMORY.md goes too.'}
          </Text>
        </Box>
      ) : (
        preview !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{preview.heading}</Text>
            {preview.body === '' ? (
              <Text dimColor>(empty)</Text>
            ) : (
              <Markdown dimColor>{preview.body}</Markdown>
            )}
            {preview.moreLines > 0 && (
              <Text dimColor>… +{preview.moreLines} more lines</Text>
            )}
          </Box>
        )
      )}

      {notice !== null && (
        <Box marginTop={1}>
          <Text dimColor>{notice}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor italic>
          {/* Byline separates its CHILDREN with " · ", and a fragment counts
              as one child — so the alternatives stay siblings. */}
          <Byline>
            {pendingDelete !== null ? (
              <Text dimColor>y to delete</Text>
            ) : (
              <Text dimColor>enter to edit</Text>
            )}
            {pendingDelete !== null ? (
              <Text dimColor>n to cancel</Text>
            ) : (
              <ConfigurableShortcutHint
                action="memory:delete"
                context="Memory"
                fallback="d"
                description="delete"
              />
            )}
            {pendingDelete === null && (
              <ConfigurableShortcutHint
                action="memory:openFolder"
                context="Memory"
                fallback="o"
                description="open folder"
              />
            )}
            {pendingDelete === null && <Text dimColor>esc to go back</Text>}
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}
