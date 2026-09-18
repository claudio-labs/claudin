/**
 * Magic Docs kept a markdown file marked with a `# MAGIC DOC: [title]` header up
 * to date, by running a forked Edit-only subagent over the conversation once the
 * turn went idle. See docs/magic-docs.md for what it did.
 *
 * The feature is gated to an internal-only build, and in this fork the gate is
 * `initMagicDocs()` below: an empty body. Nothing ever registered a document, so
 * the tracking map, the header detector, the update pass and its ~130-line
 * prompt builder could not run — they were removed rather than left to read as
 * live code.
 *
 * `initMagicDocs()` stays as the seam. Wiring the feature back means restoring
 * the update pass and its `/clear` cache entry together, from
 * `git show <this commit>^:src/platform/MagicDocs/magicDocs.ts`.
 */

export async function initMagicDocs(): Promise<void> {
  // Magic docs feature gated to internal-only build; no-op in open builds.
}
