import {
  getGlobalConfig,
  saveGlobalConfig,
  type GlobalConfig,
} from 'src/platform/config/config.js'
import type { SelectFavorites } from 'src/terminal/custom-select/SearchableSelect.js'

/**
 * Starred entries in the /model and /provider pickers (ctrl+f), pinned to the
 * top of their list. Global rather than project-scoped: which models you reach
 * for is a property of you, not of the checkout.
 *
 * Stored in ~/.claudin/config.json and deliberately absent from
 * GLOBAL_CONFIG_KEYS — the picker owns these, not `claudin config set`.
 */

export type FavoritesNamespace = 'model' | 'providerProfile'

const CONFIG_KEY: Record<
  FavoritesNamespace,
  'favoriteModels' | 'favoriteProviderProfiles'
> = {
  model: 'favoriteModels',
  providerProfile: 'favoriteProviderProfiles',
}

export function getFavorites(namespace: FavoritesNamespace): string[] {
  return readFavorites(getGlobalConfig(), namespace)
}

export function isFavorite(
  namespace: FavoritesNamespace,
  id: string,
): boolean {
  return getFavorites(namespace).includes(id)
}

/** Toggles `id` and returns whether it is starred afterwards. */
export function toggleFavorite(
  namespace: FavoritesNamespace,
  id: string,
): boolean {
  const key = CONFIG_KEY[namespace]
  const next = nextFavorites(getFavorites(namespace), id)
  saveGlobalConfig(config => ({ ...config, [key]: next }))
  return next.includes(id)
}

/**
 * The `favorites` prop SearchableSelect takes. Build one at module scope so its
 * identity is stable across renders — ModelPicker is React-Compiler output and
 * cannot grow a `useMemo` for it.
 */
export function makeFavoritesAdapter<T>(
  namespace: FavoritesNamespace,
  keyOf: (value: T) => string | null,
): SelectFavorites<T> {
  return {
    list: () => getFavorites(namespace),
    toggle: (id: string) => {
      toggleFavorite(namespace, id)
    },
    keyOf,
  }
}

/**
 * Pure toggle, exported for the test: appends to the end so the starred block
 * keeps a stable, oldest-first order across sessions.
 */
export function nextFavorites(current: string[], id: string): string[] {
  return current.includes(id)
    ? current.filter(entry => entry !== id)
    : [...current, id]
}

/**
 * A stored id whose profile has since been deleted stays in the config: no
 * delete path has to know about favorites, and an id that matches no row is
 * inert because the picker only stars options it is actually rendering.
 * Non-strings are dropped — the file is user-editable.
 */
export function readFavorites(
  config: GlobalConfig,
  namespace: FavoritesNamespace,
): string[] {
  const stored = config[CONFIG_KEY[namespace]]
  return Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []
}
