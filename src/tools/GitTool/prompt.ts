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

One command per element: no pipes, \`&&\`, \`;\` or redirects outside quotes — use Bash for those. Inside quotes they are literal, so a multi-line \`git commit -m\` or \`gh pr create --body\` belongs here; quote with '…' when the text holds a backtick or a \`$\`. Writes run too, asking for permission exactly as in Bash, under your existing Bash rules. Commands run in order and stop at the first failure; \`full: true\` returns the whole body instead of a summary.`
