import {
  DIR_EXISTS_GUIDANCE,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/memdir.js'
import { type MemoryDir, promptRoots } from 'src/memory/memdir/memoryDirs.js'
import type { MemoryAudit } from 'src/memory/memdir/memoryAudit.js'
import { isMemoryHygieneEnabled } from 'src/memory/memdir/memoryHygiene.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memoryScopes.js'

const KB = 1024

function findingLine(f: MemoryAudit['findings'][number]): string {
  switch (f.kind) {
    case 'secret':
      return `- Secret-shaped content (${f.labels.join(', ')}): \`${f.path}\``
    case 'hidden-text':
      return `- Hidden characters (${f.labels.join(', ')}): \`${f.path}\``
    case 'expired':
      return `- Past its \`expires:\` date (${f.expires}): \`${f.path}\``
    case 'broken-link':
      return `- Link \`${f.target}\` reaches no memory its readers have: \`${f.path}\``
    case 'unindexed':
      return `- Nothing links to it from its \`MEMORY.md\`: \`${f.path}\``
    case 'duplicate-name':
      return `- Shares \`name: ${f.name}\` with another memory: \`${f.path}\``
    case 'near-duplicate':
      return `- Reads like \`${f.other.path}\` (${f.other.scope}, score ${f.score}): \`${f.path}\``
    case 'misplaced-type':
      return `- A \`type: user\` memory outside the global dir: \`${f.path}\``
    case 'open-contradiction':
      return `- Marked \`contradicts:\` ${f.targets.map(t => `\`${t}\``).join(', ')}: \`${f.path}\``
    case 'index-over-cap':
      return `- Index over its cap (${f.lines} lines, ${f.bytes} bytes): \`${f.path}\``
    case 'oversize':
      return `- ${Math.round(f.bytes / 1024)} KB, over the size a memory is read at cheaply: \`${f.path}\``
  }
}

/**
 * What the memory audit found, for the model to report: never to fix here,
 * since tidy only merges duplicates — the near-duplicate pairs aside, which
 * are tidy's candidates. Empty without findings, so the prompt is then
 * exactly what it was.
 */
function findingsSection(findings: MemoryAudit['findings']): { section: string; report: string } {
  if (findings.length === 0) return { section: '', report: '' }
  const lines = findings.map(findingLine)
  const secrets = findings.some(f => f.kind === 'secret')
  const hidden = findings.some(f => f.kind === 'hidden-text')
  const expired = findings.some(f => f.kind === 'expired')
  const structural = findings.some(f => f.kind === 'broken-link' || f.kind === 'unindexed' || f.kind === 'duplicate-name')
  const pairs = findings.some(f => f.kind === 'near-duplicate')
  const hygiene = findings.some(f => f.kind === 'misplaced-type' || f.kind === 'open-contradiction' || f.kind === 'index-over-cap' || f.kind === 'oversize')
  return {
    section: `
## Found before you started

The memory audit found these without any judgment — what to do about them is the user's call, not this tidy's:

${lines.join('\n')}

Do not delete, rewrite or re-date any of them here${pairs ? ' — except a near-duplicate pair, which is a candidate for Step 2 like any other' : ''}.${secrets ? ' A secret-shaped file: never repeat the matched text, in the report or anywhere else.' : ''}
`,
    report: [
      ...(secrets ? ['- **Secret-shaped (team)**: each file above, first in the report — the user removes the secret and rotates it if it was ever committed'] : []),
      ...(hidden ? ['- **Hidden characters (team)**: each file above — the user removes them, since they change what a reviewer of the commit sees'] : []),
      ...(expired ? ['- **Expired, for review**: each memory past its `expires:` date, untouched — the user re-verifies it, then moves the date or removes it'] : []),
      ...(structural ? ['- **Links and index, for review**: each file above, untouched — the user fixes the link, indexes the memory or renames it'] : []),
      ...(hygiene ? ['- **Hygiene, for review**: each user memory outside the global dir, open contradiction, index over its cap and oversized memory above, untouched — `/memory sort` moves the first; the rest are the user\'s call'] : []),
    ].join('\n'),
  }
}

/**
 * Builds the prompt for `/memory tidy` — a manual, conservative pass over the
 * existing memory files that merges duplicates and rebuilds the index. Unlike
 * /dream (session synthesis), this never looks at transcripts and never
 * creates new memories: it only reorganizes what is already on disk.
 *
 * The prompt runs in the main conversation (local-jsx command with
 * shouldQuery), so deletions go through the normal Bash permission prompt —
 * that prompt is the human gate, keep the instructions deletion-via-`rm`.
 *
 * `dirs` is the session's memory directories (memoryDirs.ts); the global one,
 * while it is on, is tidied by the same rules and never merged across.
 */
export function buildMemoryTidyPrompt(dirs: readonly MemoryDir[], findings: MemoryAudit['findings'] = []): string {
  const { private: root, team, global } = promptRoots(dirs)
  const maxKb = Math.round(MAX_ENTRYPOINT_BYTES / KB)
  const found = findingsSection(findings)
  // memoryHygiene.ts: a private copy of a global memory merges into it, and
  // a conflict is marked in the files instead of a report line that is gone
  // by the next session. CLAUDIN_MEMORY_HYGIENE=0 keeps the tidy before it.
  const hygiene = isMemoryHygieneEnabled()
  // Each variant named here, so the template below reads straight
  const globalMerge = hygiene
    ? `- **A private memory that repeats a global one merges into it**: fold what the private copy has more into the global memory, then delete the private copy — the global one is the survivor, and the fact lives in one file. That is the only merge across the boundary: a team memory and a global one stay separate (teammates have no copy of the global dir), and moving a private memory that is NOT a copy is \`/memory sort\`'s job.`
    : `- **Never merge across the boundary**: a global memory and a private or team one about the same fact stay separate. Moving a private memory to the global dir is \`/memory sort\`'s job, not tidy's.`
  const auditPairs = hygiene && findings.some(f => f.kind === 'near-duplicate')
    ? '\n- The near-duplicate pairs the audit found above — the first to check, still only on their content'
    : ''
  const onConflict = hygiene
    ? 'they are not duplicates: keep both files, and add `contradicts:` with the other\'s `name` to the frontmatter of one of them — the conflict then stays visible to every later session, where a report line would be gone — and list it in your report. Never silently pick one side.'
    : 'keep BOTH facts (union) and note the contradiction in your report — never silently pick one side.'
  const globalBoundary =
    global === null
      ? ''
      : hygiene
        ? '- Never merge across the global ↔ team boundary; global ↔ private only as above, the global memory surviving.\n'
        : '- Never merge across the global ↔ private/team boundary.\n'
  const conflictsDone = hygiene ? 'marked with `contradicts:`' : 'kept as union'

  const teamSection = `
## Team memory

Also tidy the team memory directory: \`${team}\`

- Apply the exact same orient → identify → merge → update-index steps inside \`${team}\` (its index is \`${team}/${ENTRYPOINT_NAME}\`)
- The team index may have its own structure beyond bare index lines — a \`# Team Memory\` header, an intro blockquote, \`## Section\` groupings. **Preserve all of it**: only touch the individual index lines for files you deleted or renamed, exactly as in the private index. Never reformat, reorder, or flatten the team index's sections.
- **Never merge across the boundary**: a private memory and a team memory about the same fact stay separate. Do not move content between \`${root}\` and \`${team}\`, do not merge a pair that spans the two, and do not "promote" a private memory into team — that is a deliberate user decision, not tidy's job.
- **Never move a file into \`decisions/\`, \`bugs/\` or \`docs/\`** — filing team memories by category is \`/memory sort\`'s job, not tidy's — and never descend into those subdirectories.
- Files you change or delete here are git-tracked and reach the team on the next commit — another reason to stay strictly conservative.
`

  const globalSection =
    global !== null
      ? `
## Global memory

Also tidy the global memory directory: \`${global}\` — yours and this user's in every project.

- Apply the exact same orient → identify → merge → update-index steps inside \`${global}\` (its index is \`${global}/${ENTRYPOINT_NAME}\`)
${globalMerge}
- Every project reads these files: a deletion here takes the memory away from all of them — another reason to stay strictly conservative.
`
      : ''

  return `# Memory Tidy: conservative duplicate merge

You are tidying the memory directory — a **conservative** pass that merges duplicate memory files and updates the index. This is NOT a dream/consolidation: do not look at transcripts, do not create new memories, do not reorganize by topic, and do not rewrite the content of files that are not duplicates.

Memory directory: \`${root}\`
${DIR_EXISTS_GUIDANCE}
${teamSection}${globalSection}${found.section}
---

## Step 1 — Orient

- Read \`${root}/${ENTRYPOINT_NAME}\` to see the current index
- Read every \`.md\` file in the directory — full contents, not just frontmatter (there are at most a couple hundred; skip subdirectories other than the team dir handled separately)

## Step 2 — Identify duplicates

Look for pairs or groups of files that record the **same fact**:

- Same topic under different names (e.g. \`feedback-build-after-edit.md\` vs \`always-build-after-source-change.md\`)
- Near-identical \`description\` frontmatter
- Heavily overlapping body content${auditPairs}

Two files that merely **partially overlap** are NOT duplicates: if file A covers facts X+Y and file B covers X+Z, each holds a distinct fact — leave both alone. Only files where one is (nearly) fully redundant with the other qualify.

If you are not confident two files describe the same fact, they are NOT duplicates — leave both untouched and list them under "ambiguous pairs" in your report.

## Step 3 — Merge (conservatively)

For each confirmed duplicate group:

1. Pick the survivor: prefer the file with the more complete frontmatter and richer content; on a tie prefer the older file (check mtime with \`ls -l\` — its name is more likely already referenced elsewhere).
2. Fold the redundant file's content into the survivor. When the two files **conflict factually**, ${onConflict}
3. Keep the survivor's frontmatter \`type\`; refresh its \`description\` only if the merged content demands it. If a file's frontmatter is malformed, skip that file entirely and note it in the report.
4. Delete the redundant file with \`rm\`. Outside auto and accept-edits mode the user sees a permission prompt for each deletion — that is intentional, it is their chance to veto a merge; in those modes the deletion runs without one, so list every one in the report.

Hard rules:
- Never merge across the private ↔ team boundary.
${globalBoundary}- Never delete a file that is merely stale, ambiguous, or low-quality — only confirmed duplicates. Stale or wrong content is reported, not fixed.
- Never create new memory files, and never touch files outside the memory directories.

## Step 4 — Update the index (minimal edits, NOT a rewrite)

Edit \`${root}/${ENTRYPOINT_NAME}\` (and the ${global === null ? 'team index' : 'team and global indexes'} if applicable) **in place, surgically**:

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
- **Conflicts noted**: factual contradictions you ${conflictsDone}
- **Stale or broken observed**: outdated content, malformed frontmatter, or anything else you noticed but deliberately did NOT fix (tidy only merges duplicates)
${found.report ? `${found.report}\n` : ''}
If nothing was duplicated, say so — a tidy run that changes nothing is a correct outcome.`
}
