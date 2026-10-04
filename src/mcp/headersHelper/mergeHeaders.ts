/**
 * Lays the helper's headers over the static ones. HTTP header names are
 * case-insensitive, so a helper `Authorization` replaces a static
 * `authorization` instead of travelling beside it (fetch would join the two
 * into one comma-separated value).
 */
export function mergeHeaders(
  base: Readonly<Record<string, string>>,
  overlay: Readonly<Record<string, string>>,
): Record<string, string> {
  const replaced = new Set(Object.keys(overlay).map(name => name.toLowerCase()))
  const kept = Object.entries(base).filter(
    ([name]) => !replaced.has(name.toLowerCase()),
  )
  return { ...Object.fromEntries(kept), ...overlay }
}
