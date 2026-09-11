// `readOnly: true` on the Agent tool input — a research/audit brief.
//
// The 2026-09-10 census watched 33 fresh Code agents run a READ-ONLY cross-fork
// audit: each one received the full CLAUDE.md family, both memory indexes and
// the parent's git status at its first tool call (~23k tokens) plus the
// path-scoped rules on its first `src/` Read (~15k) — 43% of everything they
// read, none of it needed by an agent that edits nothing. The caller already
// says which kind of task it is ("clearly tell the agent whether you expect
// it to write code or just to do research"); this flag lets the harness act
// on it: the same omissions Plan gets, plus Plan's write-tool denylist.
//
// Forks are the exception. A fork child keeps the parent's exact tool pool so
// its requests share the parent's cached prefix (the `tools` array is part of
// it — see .claudin/rules/cache.md §5), so the denylist must not touch it; and
// the parent's transcript already carries the CLAUDE.md announcement, so the
// delta lane has nothing to omit. `readOnly` is therefore a no-op on a fork.

import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

/** The Plan agent's denylist: everything that writes, and nested spawning. */
export const READ_ONLY_DISALLOWED_TOOLS: readonly string[] = [
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  APPLY_PATCH_TOOL_NAME,
  AGENT_TOOL_NAME,
]

export const READ_ONLY_INPUT_DESCRIPTION =
  'Set true for a research or audit task: the agent gets no Edit/Write/apply_patch/NotebookEdit/Agent tools and skips the CLAUDE.md, memory-index and git-status injection a read-only brief does not need. Ignored for a fork.'

/**
 * The definition a named agent runs under when the caller marked the task
 * read-only. Returns the input untouched when the flag is off, the caller is
 * forking, or the slim-agent kill-switch is set.
 */
export function applyReadOnly<T extends AgentDefinition>(
  definition: T,
  readOnly: boolean | undefined,
  isFork: boolean,
): T {
  if (readOnly !== true || isFork) return definition
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_SLIM_CODE_AGENT)) return definition
  const existing = definition.disallowedTools ?? []
  const merged = [
    ...existing,
    ...READ_ONLY_DISALLOWED_TOOLS.filter(name => !existing.includes(name)),
  ]
  return {
    ...definition,
    omitClaudeMd: true,
    omitGitStatus: true,
    disallowedTools: merged,
  }
}
