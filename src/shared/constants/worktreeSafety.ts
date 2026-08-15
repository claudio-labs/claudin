/**
 * Worktree hazards that every actor running inside one needs, wherever its
 * prompt is assembled.
 *
 * They live in their own leaf module because the two call sites sit on
 * opposite ends of an existing import edge: `prompts.ts` already imports
 * `isForkSubagentEnabled` from `tools/AgentTool/forkSubagent.ts`, so having
 * `forkSubagent.ts` import the strings back from `prompts.ts` would close a
 * cycle.
 */

/**
 * The stash stack lives in the main checkout's `.git`, so it is shared by every
 * worktree and every concurrent session. A bare `git stash pop` from an agent
 * has already eaten another session's work in this repo — see
 * `.claudin/rules/agent-safety.md`.
 */
export const WORKTREE_STASH_WARNING = `The git stash stack is SHARED with the main checkout and every other worktree, so a bare \`git stash pop\` here can silently consume another session's work. Prefer a temporary WIP commit. If you must stash: \`git stash push -u -m "<unique-tag>"\`, capture the SHA immediately with \`git stash list --format='%H %gs'\`, restore with \`git stash apply <sha>\` (never \`pop\`), then drop the entry by re-finding its \`stash@{n}\` by that tag.`

/**
 * What "isolated" actually buys. A worktree separates the working copy, not the
 * process: a command that canonicalizes its paths back to the main checkout
 * (some test runners do) writes there anyway, which is how a break-and-restore
 * agent has leaked edits into the shared tree. Telling a child its changes
 * "will not affect the parent's files" is the claim that made that surprising.
 */
export const WORKTREE_WRITE_SCOPE_NOTE = `Your edits land in this worktree rather than the parent's checkout — but that is a path convention, not a sandbox: a command that canonicalizes its paths back to the main checkout still writes there, so check the parent's \`git status\` before reporting it untouched.`
