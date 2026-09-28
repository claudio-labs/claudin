// A top-level dash item with text after it. A prose-led line that groups
// several links is one entry; headings, nested bullets and `*`/`+` items are not.
const INDEX_ENTRY_RE = /^-[ \t]+\S/

/**
 * Counted on both the loaded and the raw index, so the difference tells the
 * transcript that the index was cut.
 */
export function countIndexEntries(indexContent: string): number {
  return indexContent.split('\n').filter(line => INDEX_ENTRY_RE.test(line))
    .length
}
