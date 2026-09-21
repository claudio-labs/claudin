// Extracted from dream.ts so auto-dream ships independently of KAIROS
// feature flags (dream.ts is behind a feature()-gated require).

import {
  DIR_EXISTS_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/memdir.js'
import {
  renderTeamCategoriesXml,
  TEAM_CATEGORIES,
} from 'src/memory/memdir/memoryTypes.js'

// getTeamMemPath() returns a path with a trailing separator (teamMemPaths.ts)
// — strip it before interpolating so the prompt doesn't render `…/team//x`.
const TRAILING_SEP_RE = /[/\\]+$/

/**
 * The dream prompt. `teamRoot` is the team memory dir when team memory is
 * active (the dream then files decisions, bugs and docs into its category
 * subdirectories — the git commit is the review gate) and null otherwise,
 * in which case the run is private-only as it always was. `extra` carries
 * the run-specific tail: the decision-sources digest (dreamDigest.ts), the
 * session list, tool constraints.
 */
export function buildConsolidationPrompt(
  memoryRoot: string,
  transcriptDir: string,
  extra: string,
  teamRoot: string | null = null,
): string {
  const team = teamRoot === null ? null : teamRoot.replace(TRAILING_SEP_RE, '')
  const sections = TEAM_CATEGORIES.map(c => `\`## ${c.section}\``).join(' / ')

  const whereToWrite =
    team === null
      ? `For each thing worth remembering, write or update a memory file at the top level of the memory directory.`
      : `For each thing worth remembering, write or update a memory file. Where it goes:

- a private fact — about this user, their feedback, private project context — at the top level of \`${memoryRoot}\`
- a team decision, a known defect or a documentation pointer — in the matching category subdirectory of the team dir \`${team}\` (see Team categories below; each has a bar to clear), with its index line under the ${sections} section of \`${team}/${ENTRYPOINT_NAME}\`, creating the section if absent, and the subdirectory in the link (\`(decisions/file.md)\`)
- team-scoped context that is none of those — a convention, a process finding — at the team root

The team dir is git-tracked: what you write there shows up in the user's \`git status\` and reaches teammates when they commit — that commit is the review, so write only what clears the bar, and never a secret.`

  const teamSection =
    team === null ? '' : `\n${renderTeamCategoriesXml().join('\n')}`

  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${memoryRoot}\`
${DIR_EXISTS_GUIDANCE}

Session transcripts: \`${transcriptDir}\` (large JSONL files — grep narrowly, don't read whole files)

---

## Phase 1 — Orient

- \`ls\` the memory directory to see what already exists
- Read \`${ENTRYPOINT_NAME}\` to understand the current index${team === null ? '' : ` — both the private one and \`${team}/${ENTRYPOINT_NAME}\``}
- Skim existing topic files so you improve them rather than creating duplicates
- If \`logs/\` or \`sessions/\` subdirectories exist (assistant-mode layout), review recent entries there

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Decision sources** — the digest under "Additional context" lists the plans modified since the last consolidation (their \`## Context\`, their \`## Agreed Decisions\`, and a blast radius counted from their tasks), the prompts of the sessions in the period, and the impactful commits (\`feat\`, \`refactor\`, breaking). That is where product and architecture decisions surface. Read a plan in full only when its digest entry suggests a decision that clears the bar; a one-file plan or a routine prompt almost never does.
2. **Daily logs** (\`logs/YYYY/MM/YYYY-MM-DD.md\`) if present — these are the append-only stream
3. **Existing memories that drifted** — facts that contradict something you see in the codebase now
4. **Transcript search** — if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSONL transcripts for narrow terms:
   \`grep -rn "<narrow term>" ${transcriptDir}/ --include="*.jsonl" | tail -50\`

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 — Consolidate

${whereToWrite}

Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source
${teamSection}
## Phase 4 — Prune and index

Update \`${ENTRYPOINT_NAME}\`${team === null ? '' : ' (each index you touched)'} so it stays under ${MAX_ENTRYPOINT_LINES} lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

---

Return a brief summary of what you consolidated, updated, or pruned${team === null ? '' : ', naming any team file you created so the user knows what to review before committing'}. If nothing changed (memories are already tight), say so.${extra ? `\n\n## Additional context\n\n${extra}` : ''}`
}
