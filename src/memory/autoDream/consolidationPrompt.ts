// Extracted from dream.ts so auto-dream ships independently of KAIROS
// feature flags (dream.ts is behind a feature()-gated require).

import { DIR_EXISTS_GUIDANCE, MAX_ENTRYPOINT_LINES } from 'src/memory/memdir/memdir.js'
import { type MemoryDir, promptRoots } from 'src/memory/memdir/memoryDirs.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memoryScopes.js'
import {
  renderTeamCategoriesXml,
  TEAM_CATEGORIES,
} from 'src/memory/memdir/memoryTypes.js'

/**
 * The dream prompt, over the session's memory directories (memoryDirs.ts
 * getMemoryDirs). Which directory a memory goes to is its type's scope, as
 * the system prompt's `# Memory` section states it — the dream forks share
 * that prompt, and /dream runs in the conversation that has it — so this
 * only says where the directories are and what is particular to a dream:
 * the team categories (the git commit is their review gate) and the global
 * dir, which a run may add to but never prune, because it sees one project
 * and what looks stale here may hold in another. autoDream.ts enforces that
 * in the fork's tool gate. `extra` carries the run-specific tail: the
 * decision-sources digest (dreamDigest.ts), the session list, tool constraints.
 */
export function buildConsolidationPrompt(
  dirs: readonly MemoryDir[],
  transcriptDir: string,
  extra: string,
): string {
  const { private: memoryRoot, team, global } = promptRoots(dirs)
  const sections = TEAM_CATEGORIES.map(c => `\`## ${c.section}\``).join(' / ')
  const notGlobal = global === null ? '' : ' (outside the global dir)'

  const whereToWrite = `For each thing worth remembering, write or update a memory file in the directory its type's scope names — the \`# Memory\` section of your system prompt is the source of truth for that:

${global === null ? '' : `- the global dir \`${global}\`, shared by every project — add to it only (below)\n`}- the private dir \`${memoryRoot}\`, at its top level
- the team dir \`${team}\`: a team decision, a known defect or a documentation pointer goes in the matching category subdirectory (see Team categories below; each has a bar to clear), with its index line under the ${sections} section of \`${team}/${ENTRYPOINT_NAME}\`, creating the section if absent, and the subdirectory in the link (\`(decisions/file.md)\`); other team-scoped context — a convention, a process finding — at the team root

The team dir is git-tracked: what you write there shows up in the user's \`git status\` and reaches teammates when they commit — that commit is the review, so write only what clears the bar, and never a secret.${
    global === null
      ? ''
      : `

The global dir is shared by every project, and this run sees only this one: add memories and add to them there, but never delete, shrink or rewrite one, nor remove a line from its index. A global memory this project contradicts stays as it is — name it in your summary instead.`
  }`

  const teamSection = `\n${renderTeamCategoriesXml().join('\n')}`
  const indexesToRead = [
    `\`${team}/${ENTRYPOINT_NAME}\``,
    ...(global === null ? [] : [`\`${global}/${ENTRYPOINT_NAME}\``]),
  ]

  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${memoryRoot}\`
${DIR_EXISTS_GUIDANCE}

Session transcripts: \`${transcriptDir}\` (large JSONL files — grep narrowly, don't read whole files)

---

## Phase 1 — Orient

- \`ls\` the memory directory to see what already exists
- Read \`${ENTRYPOINT_NAME}\` to understand the current index — the private one and ${indexesToRead.join(' and ')}
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

Use the memory file format and type conventions from your system prompt's \`# Memory\` section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts${notGlobal} — if today's investigation disproves an old memory, fix it at the source
${teamSection}
## Phase 4 — Prune and index

Update \`${ENTRYPOINT_NAME}\` (each index you touched) so it stays under ${MAX_ENTRYPOINT_LINES} lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.${global === null ? '' : ' The pruning below applies to this project\'s indexes only: in the global one, only add lines.'}

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one${global === null ? '' : ', unless it is a global memory: name that one in your summary'}

---

Return a brief summary of what you consolidated, updated, or pruned, naming any team file you created so the user knows what to review before committing. If nothing changed (memories are already tight), say so.${extra ? `\n\n## Additional context\n\n${extra}` : ''}`
}
