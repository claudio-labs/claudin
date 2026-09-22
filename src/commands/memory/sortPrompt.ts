import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  ENTRYPOINT_NAME,
} from 'src/memory/memdir/memdir.js'
import {
  renderTeamCategoriesXml,
  TEAM_CATEGORIES,
} from 'src/memory/memdir/memoryTypes.js'

// getTeamMemPath() returns a path with a trailing separator (teamMemPaths.ts)
// — strip it before interpolating so the prompt doesn't render `…/team//x`.
const TRAILING_SEP_RE = /[/\\]+$/

const KB = 1024

/**
 * Builds the prompt for `/memory sort` — a conservative, idempotent pass that
 * files team memories from the team root into the category subdirectories
 * (`decisions/`, `bugs/`, `docs/`) when, and only when, a file unambiguously
 * clears that category's bar. Unlike /memory tidy it merges nothing, and
 * unlike /dream it reads no transcripts and writes no new memories: it only
 * relocates what is already on disk and fixes the index lines pointing at it.
 *
 * Runs in the main conversation (local-jsx command with shouldQuery), so each
 * `git mv` goes through the normal Bash permission prompt — that prompt is the
 * human veto per file; keep the instructions on `git mv`, never `mv`.
 */
export function buildMemorySortPrompt(teamRoot: string): string {
  const team = teamRoot.replace(TRAILING_SEP_RE, '')
  const maxKb = Math.round(MAX_ENTRYPOINT_BYTES / KB)
  const dirs = TEAM_CATEGORIES.map(c => `\`${c.dir}/\``).join(', ')
  const sections = TEAM_CATEGORIES.map(c => `\`## ${c.section}\``).join(' / ')

  return `# Memory Sort: file team memories by category

You are sorting the team memory directory — a **conservative, idempotent** pass that moves files from the team root into its category subdirectories (${dirs}) when, and only when, a file unambiguously belongs there. This is NOT a tidy (no duplicate merging) and NOT a dream (no transcripts, no new memories): it only relocates what is already on disk and fixes the index lines that point at it.

Team memory directory: \`${team}\`

${renderTeamCategoriesXml().join('\n')}
---

## Step 1 — Orient

- Read \`${team}/${ENTRYPOINT_NAME}\` to see the current index
- \`ls ${team}\` — only the \`.md\` files directly at the root are candidates. Never descend into ${dirs} or any other subdirectory: a file already in a category is done.
- Read every candidate in full — the decision is made on the body, not the title

## Step 2 — Classify, conservatively

For each root file decide: ${dirs}, or **stays**. A file moves only when it clears that category's \`<when_to_save>\` bar as written above AND none of its \`<when_not_to_save>\` applies. A \`feedback\` memory never moves. Anything you are not sure about stays at the root and goes in the report — the root is a valid home, not a failure.

Signals worth reading: a \`bugs/\` candidate names a symptom, a location and a status; a \`docs/\` candidate is a pointer (a path, a URL) plus what it covers; a \`decisions/\` candidate records a choice with a why that changed what the project does or how it is structured, or an alternative that was rejected. A process finding, a census, a convention, a roadmap stays where it is.

## Step 3 — Move

For each file that moves:

1. \`mkdir -p ${team}/<category>\` if the subdirectory does not exist yet.
2. \`git mv ${team}/<file>.md ${team}/<category>/<file>.md\` — \`git mv\`, not \`mv\`, so history follows the file. The user sees a permission prompt for each move; that is intentional — it is their veto.
3. If the category expects frontmatter the file lacks (\`decisions/\`: \`scope:\` and \`impact:\`), add ONLY those keys, with values you can justify from the body. If you cannot justify them, the file was not an unambiguous fit — leave it at the root instead.
4. Add \`paths:\` (same syntax as a rule: globs relative to the project root) ONLY when the body names concrete files or a directory — a \`bugs/\` file naming the function's file, a \`docs/\` file covering one subsystem's directory. Never invent a path.

Do not rewrite the body. Do not rename the file. Do not merge, split or delete anything.

## Step 4 — Update the index (surgical)

Edit \`${team}/${ENTRYPOINT_NAME}\` in place:

- For each moved file change ONLY its pointer — \`(file.md)\` → \`(<category>/file.md)\` — and move that one line under the matching ${sections} heading, creating the heading once (near the top, after any intro) if it does not exist yet.
- Everything else stays byte-for-byte: other lines, other headings, their order, blank lines. Never reformat, reorder or flatten the rest of the index.
- The index must stay under ${MAX_ENTRYPOINT_LINES} lines AND under ~${maxKb}KB — it is an index, never write memory content into it.

## Step 5 — Report

- **Moved**: \`file.md → category/file.md\`, the one-phrase reason, and any frontmatter you added
- **Left at root (ambiguous)**: candidates you considered and why they stayed
- **Frontmatter you could not fill**: files that looked like a fit but whose \`scope\`/\`impact\` you could not justify from the body

Hard rules:
- Only files directly at the team root move — never a private memory, never between subdirectories, never anything outside \`${team}\`.
- Never create or delete a memory, never rewrite a body, never change a \`name:\` or \`type:\`.
- A second run over a sorted directory moves nothing — say so; that is the correct outcome.`
}
