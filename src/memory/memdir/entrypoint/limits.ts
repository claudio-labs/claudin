/** The index at the root of every memory directory; it is the only memory file loaded each session. */
export const ENTRYPOINT_NAME = 'MEMORY.md'

export const MAX_ENTRYPOINT_LINES = 200

/** Measured in UTF-8 bytes, not characters, so a non-ASCII index cannot slip past it. */
export const MAX_ENTRYPOINT_BYTES = 25_000
