import { type ReactNode, useCallback, useMemo, useState } from 'react'

import { ConfigurableShortcutHint } from 'src/terminal/ConfigurableShortcutHint.js'
import {
  filterOptions,
  sortFavoritesFirst,
  starLabel,
} from 'src/terminal/custom-select/favoritesFilter.js'
import {
  type OptionWithDescription,
  Select,
  type SelectProps,
} from 'src/terminal/custom-select/select.js'
import { Byline } from 'src/terminal/design-system/Byline.js'
import { useSearchInput } from 'src/terminal/hooks/useSearchInput.js'
import { Box, Text } from 'src/terminal/ink.js'
import { useTerminalFocus } from 'src/terminal/ink/hooks/use-terminal-focus.js'
import { useKeybindings } from 'src/terminal/keybindings/useKeybinding.js'
import { SearchBox } from 'src/terminal/SearchBox.js'

/**
 * A Select with type-to-filter search ('/') and starred rows pinned to the top
 * (ctrl+f). Used by the /model and /provider pickers, whose lists outgrew a
 * plain scroll.
 *
 * Search is a MODE rather than always-on typing, because `j` and `k` are bound
 * to select:next/previous in the Select context and consume the key before any
 * text field sees it — and model names are full of both (haiku, kimi, grok).
 * So while searching, the underlying Select is disabled, exactly as /config
 * does it: Enter or ↓ leaves search for the filtered list, Esc clears the
 * query, a second Esc leaves search.
 *
 * What "favorite" means is INJECTED via the `favorites` prop, so this file
 * stays domain-free and the terminal slice never imports from src/providers/.
 */

export type SelectFavorites<T> = {
  /** Currently starred ids, read through to wherever they are persisted. */
  list: () => string[]
  /** Flips `id` and persists. */
  toggle: (id: string) => void
  /** The favorites id for a row, or null when the row cannot be starred. */
  keyOf: (value: T) => string | null
}

export type SearchableSelectProps<T> = SelectProps<T> & {
  favorites?: SelectFavorites<T>
  searchPlaceholder?: string
  /**
   * Render the "and N more…" line under the list. The plain Select has no such
   * line; ModelPicker used to render its own, which goes stale the moment the
   * list can be filtered.
   */
  showOverflowCount?: boolean
}

export function SearchableSelect<T = string>({
  favorites,
  searchPlaceholder = 'Search…',
  showOverflowCount = false,
  options,
  onFocus,
  visibleOptionCount = 5,
  ...selectProps
}: SearchableSelectProps<T>): ReactNode {
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [favoriteIds, setFavoriteIds] = useState<string[]>(
    () => favorites?.list() ?? [],
  )
  const [focusedValue, setFocusedValue] = useState<T | undefined>(undefined)
  const isTerminalFocused = useTerminalFocus()

  const { query, cursorOffset } = useSearchInput({
    isActive: isSearchMode,
    onExit: () => setIsSearchMode(false),
    // ctrl+f has to reach the keybinding handler instead of the text field.
    passthroughCtrlKeys: ['f'],
    // Esc is the way out; a held backspace shouldn't eject the user mid-filter.
    backspaceExitsOnEmpty: false,
  })

  const isFavoriteOption = useCallback(
    (option: OptionWithDescription<T>): boolean => {
      const id = favorites?.keyOf(option.value)
      return id != null && favoriteIds.includes(id)
    },
    [favorites, favoriteIds],
  )

  // Filter on the raw labels, then pin, then star — the star prefix is never
  // part of what a query is matched against.
  const processedOptions = useMemo(() => {
    const pinned = sortFavoritesFirst(
      filterOptions(options, query),
      isFavoriteOption,
    )
    if (favoriteIds.length === 0) return pinned
    return pinned.map(option =>
      isFavoriteOption(option)
        ? { ...option, label: starLabel(option.label, true) }
        : option,
    )
  }, [options, query, isFavoriteOption, favoriteIds.length])

  const handleFocus = useCallback(
    (value: T) => {
      setFocusedValue(value)
      onFocus?.(value)
    },
    [onFocus],
  )

  const handlers = useMemo(() => {
    const map: Record<string, () => void | false> = {}
    // Registered only outside search mode, so '/' types normally in the query.
    if (!isSearchMode) {
      map['select:search'] = () => setIsSearchMode(true)
    }
    if (favorites) {
      map['select:toggleFavorite'] = () => {
        if (focusedValue === undefined) return false
        const id = favorites.keyOf(focusedValue)
        if (id === null) return false
        favorites.toggle(id)
        setFavoriteIds(favorites.list())
      }
    }
    return map
  }, [isSearchMode, favorites, focusedValue])

  useKeybindings(handlers, { context: 'Select' })

  const hiddenCount = Math.max(0, processedOptions.length - visibleOptionCount)

  return (
    <Box flexDirection="column">
      {/* Always mounted, like /config's. Showing it only while searching
          changes the dialog's height and width mid-list, and the renderer
          repaints the reflowed rows incompletely (ink-tui.md §3). */}
      <Box marginBottom={1}>
        <SearchBox
          query={query}
          isFocused={isSearchMode}
          isTerminalFocused={isTerminalFocused}
          cursorOffset={cursorOffset}
          placeholder={searchPlaceholder}
          borderless
        />
      </Box>
      {processedOptions.length === 0 ? (
        <Text dimColor>No matches for &quot;{query}&quot;</Text>
      ) : (
        <Select
          {...selectProps}
          options={processedOptions}
          onFocus={handleFocus}
          visibleOptionCount={visibleOptionCount}
          // Disabling is what frees the keyboard: it turns off both the
          // Select-context keybindings (j/k/enter) and the useInput branch
          // that maps digits to rows, so every key reaches the search box.
          isDisabled={isSearchMode || selectProps.isDisabled}
          highlightText={query || undefined}
        />
      )}
      {showOverflowCount && hiddenCount > 0 && (
        <Box paddingLeft={3}>
          <Text dimColor>and {hiddenCount} more…</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor italic>
          <Byline>
            {isSearchMode ? (
              <Text dimColor>Enter or ↓ to pick · Esc to clear</Text>
            ) : (
              <ConfigurableShortcutHint
                action="select:search"
                context="Select"
                fallback="/"
                description="search"
              />
            )}
            {favorites ? (
              <ConfigurableShortcutHint
                action="select:toggleFavorite"
                context="Select"
                fallback="ctrl+f"
                description="favorite"
              />
            ) : null}
            {query !== '' && !isSearchMode ? (
              <Text dimColor>filtered by &quot;{query}&quot;</Text>
            ) : null}
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}
