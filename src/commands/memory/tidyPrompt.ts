import {
  DIR_EXISTS_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from '../../memdir/memdir.js'

// getAutoMemPath()/getTeamMemPath() return paths with a trailing separator
// (paths.ts, teamMemPaths.ts) — strip it before interpolating so the prompt
// doesn't render `…/memory//MEMORY.md`.
const TRAILING_SEP_RE = /[/\\]+$/

function normalizeRoot(root: string): string {
  return root.replace(TRAILING_SEP_RE, '')
}

const KB = 1024

/**
 * Builds the prompt for `/memory tidy` — a manual, conservative pass over the
 * existing memory files that merges duplicates and rebuilds the index. Unlike
 * /dream (session synthesis), this never looks at transcripts and never
 * creates new memories: it only reorganizes what is already on disk.
 *
 * The prompt runs in the main conversation (local-jsx command with
 * shouldQuery), so deletions go through the normal Bash permission prompt —
 * that prompt is the human gate, keep the instructions deletion-via-`rm`.
 */
export function buildMemoryTidyPrompt(
  memoryRoot: string,
  teamRoot: string | null,
): string {
  const root = normalizeRoot(memoryRoot)
  const team = teamRoot === null ? null : normalizeRoot(teamRoot)
  const maxKb = Math.round(MAX_ENTRYPOINT_BYTES / KB)

  // Step 1 must only mention the team dir when this run actually covers it —
  // otherwise the agent is invited into team/ without the boundary rules.
  const subdirGuidance =
    team !== null
      ? 'skip subdirectories other than the team dir handled separately'
      : 'skip all subdirectories'

  const teamSection =
    team !== null
      ? `
## Team memory

Also tidy the team memory directory: \`${team}\`

- Apply the exact same orient → identify → merge → update-index steps inside \`${team}\` (its index is \`${team}/${ENTRYPOINT_NAME}\`)
- The team index may have its own structure beyond bare index lines — a \`# Team Memory\` header, an intro blockquote, \`## Section\` groupings. **Preserve all of it**: only touch the individual index lines for files you deleted or renamed, exactly as in the private index. Never reformat, reorder, or flatten the team index's sections.
- **Never merge across the boundary**: a private memory and a team memory about the same fact stay separate. Do not move content between \`${root}\` and \`${team}\`, do not merge a pair that spans the two, and do not "promote" a private memory into team — that is a deliberate user decision, not tidy's job.
- Files you change or delete here propagate to the team via automatic sync — another reason to stay strictly conservative.
`
      : ''

  return `# Memory Tidy: conservative duplicate merge

You are tidying the memory directory — a **conservative** pass that merges duplicate memory files and updates the index. This is NOT a dream/consolidation: do not look at transcripts, do not create new memories, do not reorganize by topic, and do not rewrite the content of files that are not duplicates.

Memory directory: \`${root}\`
${DIR_EXISTS_GUIDANCE}
${teamSection}
---

## Step 1 — Orient

- Read \`${root}/${ENTRYPOINT_NAME}\` to see the current index
- Read every \`.md\` file in the directory — full contents, not just frontmatter (there are at most a couple hundred; ${subdirGuidance})

## Step 2 — Identify duplicates

Look for pairs or groups of files that record the **same fact**:

- Same topic under different names (e.g. \`feedback-build-after-edit.md\` vs \`always-build-after-source-change.md\`)
- Near-identical \`description\` frontmatter
- Heavily overlapping body content

Two files that merely **partially overlap** are NOT duplicates: if file A covers facts X+Y and file B covers X+Z, each holds a distinct fact — leave both alone. Only files where one is (nearly) fully redundant with the other qualify.

If you are not confident two files describe the same fact, they are NOT duplicates — leave both untouched and list them under "ambiguous pairs" in your report.

## Step 3 — Merge (conservatively)

For each confirmed duplicate group:

1. Pick the survivor: prefer the file with the more complete frontmatter and richer content; on a tie prefer the older file (check mtime with \`ls -l\` — its name is more likely already referenced elsewhere).
2. Fold the redundant file's content into the survivor. When the two files **conflict factually**, keep BOTH facts (union) and note the contradiction in your report — never silently pick one side.
3. Keep the survivor's frontmatter \`type\`; refresh its \`description\` only if the merged content demands it. If a file's frontmatter is malformed, skip that file entirely and note it in the report.
4. Delete the redundant file with \`rm\`. The user will see a permission prompt for each deletion — that is intentional, it is their chance to veto a merge.

Hard rules:
- Never merge across the private ↔ team boundary.
- Never delete a file that is merely stale, ambiguous, or low-quality — only confirmed duplicates. Stale or wrong content is reported, not fixed.
- Never create new memory files, and never touch files outside the memory directories.

## Step 4 — Update the index (minimal edits, NOT a rewrite)

Edit \`${root}/${ENTRYPOINT_NAME}\` (and the team index if applicable) **in place, surgically**:

- Remove only the lines pointing at files you deleted
- Update the survivor's line only if its title/hook changed
- Do not reorder, regroup, reformat, or rewrite surviving lines — the rest of the index stays byte-for-byte as it was
- Format for any line you do touch: \`- [Title](file.md) — one-line hook\`, under ~150 chars
- The index must stay under ${MAX_ENTRYPOINT_LINES} lines AND under ~${maxKb}KB — it's an index, never write memory content into it

## Step 5 — Report

Finish with a brief summary:

- **Merged**: which files combined into which survivor (X + Y → Z)
- **Deleted**: files removed
- **Ambiguous pairs left alone**: candidates you were not confident about, so the user can decide by hand
- **Conflicts noted**: factual contradictions you kept as union
- **Stale or broken observed**: outdated content, malformed frontmatter, or anything else you noticed but deliberately did NOT fix (tidy only merges duplicates)

If nothing was duplicated, say so — a tidy run that changes nothing is a correct outcome.`
}
