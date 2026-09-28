/**
 * The Ctrl+R history picker: this project's recent prompts, newest at the
 * bottom next to the query box, narrowed as the user types, with the focused
 * one previewed. Picking one hands it over with its pastes read; the picker
 * never closes itself, the caller takes it down. The design-system FuzzyPicker
 * supplies the query box, the scrolling window, the marks, the keys and the
 * hint line. docs/tech/rewrite/sessions/historySearch.md (section 3) is the spec.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { getTimestampedHistory } from 'src/agent/history.js'
import type { HistoryEntry } from 'src/platform/config/config.js'
import { emptyListNotice, filterPrompts, type ListedPrompt, readListedPrompts } from 'src/sessions/historySearch/pickerList.js'
import { pickerWidths, previewLines, promptRow } from 'src/sessions/historySearch/pickerLayout.js'
import { logError } from 'src/shared/log.js'
import { useRegisterOverlay } from 'src/terminal/contexts/overlayContext.js'
import { FuzzyPicker } from 'src/terminal/design-system/FuzzyPicker.js'
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js'
import { Box, Text } from 'src/terminal/ink.js'

type Props = {
  initialQuery?: string
  onSelect: (entry: HistoryEntry) => void
  onCancel: () => void
}

const OVERLAY_ID = 'history-search'

const keyOf = (prompt: ListedPrompt): string => prompt.key

export function HistorySearchDialog({ initialQuery, onSelect, onCancel }: Props): React.ReactNode {
  useRegisterOverlay(OVERLAY_ID)
  const { columns } = useTerminalSize()
  const widths = pickerWidths(columns)
  const prompts = useListedPrompts()
  const [query, setQuery] = useState(initialQuery ?? '')
  const shown = useMemo(() => filterPrompts(prompts ?? [], query), [prompts, query])

  const select = useCallback(
    (prompt: ListedPrompt) => {
      void prompt.resolve().then(onSelect).catch(logError)
    },
    [onSelect],
  )
  const renderRow = useCallback(
    (prompt: ListedPrompt, isFocused: boolean) => <Row prompt={prompt} width={widths.rowText} isFocused={isFocused} />,
    [widths.rowText],
  )
  const renderPreview = useCallback(
    (prompt: ListedPrompt) => <Preview lines={previewLines(prompt.display, widths.preview)} />,
    [widths.preview],
  )
  const notice = useCallback((typed: string) => emptyListNotice(prompts === undefined, typed), [prompts])

  return (
    <FuzzyPicker
      title="Search prompts"
      placeholder="Filter history…"
      initialQuery={initialQuery}
      items={shown}
      getKey={keyOf}
      renderItem={renderRow}
      renderPreview={renderPreview}
      previewPosition={widths.previewBeside ? 'right' : 'bottom'}
      direction="up"
      onQueryChange={setQuery}
      onSelect={select}
      onCancel={onCancel}
      emptyMessage={notice}
      selectAction="use"
    />
  )
}

/** The history, read once per mount; undefined until the read is done. */
function useListedPrompts(): readonly ListedPrompt[] | undefined {
  const [prompts, setPrompts] = useState<readonly ListedPrompt[]>()
  useEffect(() => {
    const reading = new AbortController()
    void readListedPrompts(getTimestampedHistory(), reading.signal).then(listed => {
      if (!reading.signal.aborted) setPrompts(listed)
    })
    return () => reading.abort()
  }, [])
  return prompts
}

/** One line: the age, dimmed, then the prompt's first line. */
function Row({ prompt, width, isFocused }: { prompt: ListedPrompt; width: number; isFocused: boolean }): React.ReactNode {
  const row = promptRow(prompt, width)
  return (
    <Text>
      <Text dimColor>{row.age}</Text> <Text color={isFocused ? 'suggestion' : undefined}>{row.text}</Text>
    </Text>
  )
}

/** Beside the list it grows to the list's height, so its frame does not jump as the focus moves. */
function Preview({ lines }: { lines: readonly string[] }): React.ReactNode {
  return (
    <Box borderStyle="round" borderDimColor flexDirection="column" flexGrow={1} paddingX={1}>
      <Text>{lines.join('\n')}</Text>
    </Box>
  )
}
