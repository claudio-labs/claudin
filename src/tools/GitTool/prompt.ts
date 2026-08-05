export const GIT_TOOL_NAME = 'Git'

/**
 * Deliberately short. This string is in the system prompt of EVERY request for
 * the life of the session, while the payload it saves only accrues on the ~26%
 * of sessions that touch git at all (measured over 760 recorded sessions,
 * `scripts/profile/git-tool-baseline.ts`). A RunTests-sized description would
 * cost more than the tool returns. `prompt.test.ts` pins the size.
 */
export const DESCRIPTION = `Run git and gh commands and get back a compact result instead of raw shell output.

Pass \`commands\` as a list of verbatim shell commands, each starting with \`git\` or \`gh\` — e.g. ["git status", "git diff", "git log -5"]. Sending a burst as ONE call is cheaper than one call each.

One command per element: no pipes, \`&&\`, \`;\` or redirects — use Bash for those. Reads and writes both run; a mutating command asks for permission exactly as it would in Bash, and your existing Bash permission rules apply unchanged. Commands run in order and stop at the first failure.`
