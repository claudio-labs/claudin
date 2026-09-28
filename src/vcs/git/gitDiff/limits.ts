/**
 * How much of a change set the reviewer is given. The bounds keep one huge
 * change from filling memory or the screen; the totals always cover everything.
 */

/** Files that get an entry: tracked and untracked together, or files with hunks. */
export const MAX_FILES = 50

/** Hunk lines kept per file, and rows of an untracked file shown as added. */
export const MAX_LINES_PER_FILE = 400

/** A file's section of a unified diff, in UTF-8 bytes, beyond which it is skipped. */
export const MAX_SECTION_BYTES = 1_000_000

/** git's whole patch output, in bytes, beyond which no file gets hunks. */
export const MAX_PATCH_BYTES = 1_000_000

/** Changed tracked files beyond which only git's totals come back. */
export const MAX_FILES_FOR_DETAIL = 500
