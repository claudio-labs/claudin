import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/memdir.js'
import { type MemoryDir, promptRoots } from 'src/memory/memdir/memoryDirs.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memoryScopes.js'
import {
  MEMORY_TYPES,
  renderTeamCategoriesXml,
  TEAM_CATEGORIES,
  TYPE_SCOPES,
} from 'src/memory/memdir/memoryTypes.js'

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
 * human veto per file; keep the instructions on `git mv`, never `mv`. What is
 * NOT prompted: the frontmatter keys added to a moved file and the index
 * edits, which go through the memory carve-out (internalPaths.ts) like any
 * memory write. The prompt says so, and asks for them in the report.
 *
 * With the global dir on it also promotes what is about the user from the
 * private dir to the global one — the migration for memories saved before
 * the global dir existed. There the prompted steps are `mv -n` (a move, never
 * over a file another project saved) and `rm` (the private half of a merge);
 * a split's new global file and a merge's edit are written without a prompt.
 */
export function buildMemorySortPrompt(dirs: readonly MemoryDir[]): string {
  const roots = promptRoots(dirs)
  const teamPart = buildTeamPart(roots.team)
  return roots.global === null
    ? teamPart
    : `${teamPart}\n\n---\n\n# Part 2 — promote what is about the user to the global memory\n\nThe hard rules above are about the team dir; this part has its own.\n\n${buildPromotionPart(roots.private, roots.global)}`
}

function buildTeamPart(team: string): string {
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

The user approves each \`git mv\`; nothing else here asks them. The frontmatter keys of steps 3 and 4 and the index edit of Step 4 are written without a prompt, so the report lists every one of them.

## Step 4 — Update the index (surgical)

Edit \`${team}/${ENTRYPOINT_NAME}\` in place:

- For each moved file change ONLY its pointer — \`(file.md)\` → \`(<category>/file.md)\` — and move that one line under the matching ${sections} heading, creating the heading once (near the top, after any intro) if it does not exist yet.
- Everything else stays byte-for-byte: other lines, other headings, their order, blank lines. Never reformat, reorder or flatten the rest of the index.
- The index must stay under ${MAX_ENTRYPOINT_LINES} lines AND under ~${maxKb}KB — it is an index, never write memory content into it.

## Step 5 — Report

- **Moved**: \`file.md → category/file.md\`, the one-phrase reason, and any frontmatter you added
- **Written without a prompt**: every frontmatter key you added, by file, and the index lines you changed
- **Left at root (ambiguous)**: candidates you considered and why they stayed
- **Frontmatter you could not fill**: files that looked like a fit but whose \`scope\`/\`impact\` you could not justify from the body

Hard rules:
- Only files directly at the team root move — never a private memory, never between subdirectories, never anything outside \`${team}\`.
- Never create or delete a memory, never rewrite a body, never change a \`name:\` or \`type:\`.
- A second run over a sorted directory moves nothing — say so; that is the correct outcome.`
}

/**
 * The private → global pass. A move is a `mv -n` — the permission prompt is
 * the veto, and `-n` keeps it from replacing a global memory of the same name
 * that another project saved; a name collision is compared first, then merged
 * or moved under a new name. A merge is an edit of the global file plus an
 * `rm` of the private one; a split is a new global file plus an edit of the
 * private one. The `mv` and `rm` are prompted; the new file and the edits are
 * not (memory carve-out), so the prompt says that and asks to report them.
 * What moves is what TYPE_SCOPES says goes global; conservative like the team
 * pass, so what is unclear stays private.
 */
function buildPromotionPart(own: string, global: string): string {
  const scopes = MEMORY_TYPES.map(type => `- \`${type}\`: ${TYPE_SCOPES[type].withGlobal}.`)
  return `The private memory directory \`${own}\` was the only home for what is about the user until the global one existed: \`${global}\`, shared by every project this user works in. Move there what holds in any project, so the next project starts already knowing it — and nothing else.

## Step 1 — Orient

- Read \`${own}/${ENTRYPOINT_NAME}\` and \`${global}/${ENTRYPOINT_NAME}\`
- \`ls ${own}\` — only the \`.md\` files directly in it are candidates; never \`team/\` or any other subdirectory
- Read every candidate in full, and every file already in \`${global}\`, so you merge instead of duplicating — the user may already have said the same thing in another project

## Step 2 — Classify, conservatively

For each candidate decide: **move** (the whole file holds in any project), **split** (part of it does) or **stays**.

Each type goes where its scope says — the same scopes as your system prompt's:
${scopes.join('\n')}

A file whose body mixes the two — a \`user\` memory that also says what they work on here — is a split: what holds anywhere goes global, the rest stays.

Anything you are not sure about stays and goes in the report — the private dir is a valid home, not a failure.

## Step 3 — Move, merge or split

- **Move**: when no global memory records the same fact, \`mv -n ${own}/<file>.md ${global}/<file>.md\`. Always \`-n\`: the global dir is shared by every project, and a file of that name there is another project's memory, never something to replace. The user sees a permission prompt for each move; that is their veto. Then drop a \`paths:\` key from the moved file if it has one — a global memory is not tied to a project's files.
- **Name collision**: when \`${global}/<file>.md\` already exists — check before the move, and check again if \`mv -n\` left the private file where it was — read both. If they hold the same fact, it is a merge (next item). If they do not, move the private file under a new name that says what sets it apart: \`mv -n ${own}/<file>.md ${global}/<new-name>.md\`, and point its index line at the new name.
- **Merge**: when a global memory already records the same fact, fold the private file into it — when the two differ, keep both facts and say so in the report — then delete the private file with \`rm\` (another permission prompt).
- **Split**: write the part that holds anywhere as a new file in \`${global}\` with its own frontmatter (\`type: user\` or \`feedback\`) — under a name no global file has — then edit the private file down to what stays, changing its \`type\` if the old one no longer fits.

Never touch the team dir, never change what a memory says, never invent a fact.

**What the user approves, and what they do not.** Each \`mv\` and each \`rm\` goes through a Bash permission prompt — that is the user's veto, file by file. Writes into the memory directories do not: a split's new global file, the edit that folds a merge into a global memory, the edit that cuts a split's private file down, the dropped \`paths:\` key and the index edits of Step 4 are all written without a prompt. Keep them to exactly what this step describes, and list every one in the report so the user can review it afterwards.

## Step 4 — Update both indexes (surgical)

- In \`${own}/${ENTRYPOINT_NAME}\`, remove the pointer line of each file you moved or merged away, and update the line of each file you split if its hook changed.
- In \`${global}/${ENTRYPOINT_NAME}\`, add \`- [Title](file.md) — one-line hook\` for each file it gains (create the index if it does not exist).
- Everything else in both stays byte-for-byte. Each must stay under ${MAX_ENTRYPOINT_LINES} lines.

## Step 5 — Report

- **Moved to global**: \`file.md\` and the one-phrase reason
- **Renamed on a collision**: \`file.md → new-name.md\`, and what sets it apart from the global file of the old name
- **Merged into a global memory**: which into which, and any difference you kept
- **Split**: what went global, what stayed
- **Written without a prompt**: every file you created or edited in either directory, the indexes included
- **Left private (ambiguous)**: candidates you considered and why they stayed

A second run over a sorted directory moves nothing — say so; that is the correct outcome.`
}
