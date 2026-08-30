import figures from 'figures'
import type { ReactNode } from 'react'

/**
 * Pure list operations behind SearchableSelect: the substring filter, the
 * favorites-first reorder, and the star prefix. Kept domain-free (no config,
 * no provider types) so the terminal slice never reaches into `src/providers/`
 * — the caller injects what "favorite" means.
 */

export const FAVORITE_PREFIX = `${figures.star} `

type FilterableOption = {
  label: ReactNode
  description?: string
}

/**
 * The text a query is matched against. A non-string label (Select accepts any
 * ReactNode) contributes nothing rather than being stringified into noise.
 */
function searchableText(option: FilterableOption): string {
  const label = typeof option.label === 'string' ? option.label : ''
  return `${label}\n${option.description ?? ''}`.toLowerCase()
}

export function matchesQuery(option: FilterableOption, query: string): boolean {
  if (query === '') return true
  return searchableText(option).includes(query.toLowerCase())
}

export function filterOptions<T extends FilterableOption>(
  options: T[],
  query: string,
): T[] {
  if (query === '') return options
  return options.filter(option => matchesQuery(option, query))
}

/**
 * Stable partition: favorites keep their relative order, and so does the rest
 * of the list. Returns the original array when nothing is starred, so Select's
 * `options !== lastOptions` identity check doesn't reset navigation for free.
 */
export function sortFavoritesFirst<T>(
  options: T[],
  isFavorite: (option: T) => boolean,
): T[] {
  const favorites = options.filter(isFavorite)
  if (favorites.length === 0 || favorites.length === options.length) {
    return options
  }
  return [...favorites, ...options.filter(option => !isFavorite(option))]
}

/**
 * Prefixes a starred row's label. Only string labels are touched: Select's
 * `highlightText` pass only fires on strings, and prefixing keeps that working
 * because the match is a plain `indexOf` over the whole label.
 */
export function starLabel(label: ReactNode, isFavorite: boolean): ReactNode {
  if (!isFavorite || typeof label !== 'string') return label
  return `${FAVORITE_PREFIX}${label}`
}
