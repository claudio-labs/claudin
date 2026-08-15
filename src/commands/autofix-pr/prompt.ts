import {
  FETCH_REFERENCED_CODE_HINT,
  PR_COMMENTS_FORMAT_INSTRUCTIONS,
  TRIAGE_INSTRUCTIONS,
} from 'src/commands/autofix-pr/shared.js'

export type AutofixPromptMode = 'default' | 'dry-run'

export type AutofixPromptInput = {
  mode: AutofixPromptMode
  prNumber: number
  branch: string
  defaultBranch: string
  args: string
}

export function buildAutofixPrompt(input: AutofixPromptInput): string {
  switch (input.mode) {
    case 'dry-run':
      return buildDryRunPrompt(input)
    case 'default':
      return buildDefaultPrompt(input)
  }
}

function buildDefaultPrompt({
  prNumber,
  branch,
  args,
}: AutofixPromptInput): string {
  const extra = args.trim() ? `\n\nAdditional user input: ${args.trim()}` : ''
  return `You are an AI assistant integrated into a git-based version control system. The user invoked \`/autofix-pr\` on PR #${prNumber} (branch \`${branch}\`). Your job is to resolve every actionable review comment on that PR in a single pass: collect, triage, fix, verify, commit, push, and reply.

Follow these steps in order. Do not skip steps.

## 1. Collect comments

- \`gh pr view --json number,headRepository,state,reviewDecision\` to confirm PR identity and that it is still \`OPEN\`.
- \`gh api /repos/{owner}/{repo}/issues/${prNumber}/comments\` for PR-level comments.
- \`gh api /repos/{owner}/{repo}/pulls/${prNumber}/comments\` for review comments. Capture \`id\`, \`body\`, \`diff_hunk\`, \`path\`, \`line\`, \`in_reply_to_id\`. ${FETCH_REFERENCED_CODE_HINT}
- \`gh api /repos/{owner}/{repo}/pulls/${prNumber}/reviews\` to identify which review comments belong to a \`CHANGES_REQUESTED\` review.
- Use \`gh api --paginate\` if any response shows pagination hints.
- Skip comments whose latest reply on the thread is from the PR author (treat as resolved).

## 2. Triage

Assign exactly one label to every remaining comment using the rules below.

${TRIAGE_INSTRUCTIONS}

## 3. PR-level sanity check

Before fixing anything, decide whether the PR itself is still coherent:
- Run \`gh pr view --json mergeStateStatus,mergeable,baseRefName,headRefOid,additions,deletions\`.
- If \`mergeStateStatus\` is \`DIRTY\` / \`BEHIND\` or \`mergeable\` is \`CONFLICTING\`: stop, surface to the user (rebase / merge main / abort?), do not fix.
- If reviewers are giving **conflicting** instructions on the same line/concept (one asks A, another asks not-A): stop, surface to the user.
- If multiple comments together imply the PR's scope has exploded (e.g. asking for a rewrite of an adjacent system): use AskUserQuestion to decide proceed / split / abort.

## 4. Ask the user if needed

Before touching any file:
- For \`pr_questionable\` or \`unclear\`: AskUserQuestion with one question per comment, quoting the comment, offering "Treat as ok and fix" / "Reply explaining why we won't act" / "Mark out_of_scope".
- For \`nit\`: AskUserQuestion once, batched, with "Apply all nits" / "Skip all nits" / "Decide per-nit" (default skip).
- If every actionable label is empty after this step, post a short summary and exit without committing.

## 5. Fix

For each comment labelled \`ok\`, \`change_request\`, or upgraded to \`ok\` by the user:
- Read the target file before editing — never edit code you have not just read.
- Apply the smallest change that satisfies the reviewer. Do not bundle unrelated cleanups.
- Run \`bun run typecheck\` and the relevant focused test(s) (\`bun test path/to/changed.test.ts\`).
- If a fix breaks typecheck/tests and you cannot recover in one more attempt: \`git reset --soft HEAD~1\` to drop the broken commit (if already committed), revert your edits, label the comment \`unclear\`, and surface to the user.

## 6. Commit & push

- Stage only the files you changed (no \`git add -A\`).
- One commit per logical group of related comments. Prefer subject \`fix(review): address <N> review comments\` when the group spans multiple authors; otherwise an imperative subject describing the fix.
- Body: list each comment author and a one-line description of what was addressed. Never \`--no-verify\`, never \`--amend\`.
- Before pushing, check \`git status -sb\` for "behind" — if the local branch is behind the remote, stop and surface (do not auto-rebase).
- \`git push\` to the same branch (no force-push).

## 7. Reply on GitHub

Resolve the viewer identity once with \`gh api user --jq .login\` and cache it; use it to skip replies you already authored (avoid double-replies on the same thread).

For every comment you acted on:
- Review comments (had \`diff_hunk\`): \`gh api -X POST /repos/{owner}/{repo}/pulls/${prNumber}/comments/{comment_id}/replies -f body='...'\` so the reply stays in the thread.
- PR-level (issue) comments: \`gh api -X POST /repos/{owner}/{repo}/issues/${prNumber}/comments -f body='...'\` referencing the original comment.
- Reply body should briefly state what changed and the commit SHA(s).
- For \`out_of_scope\` or \`incorrect\`: post a reply explaining why; do not commit.

## 8. Loop until done (max 5 iterations)

After step 6, re-run step 1 (collect comments) to pick up:
- New comments the reviewer may have posted while you were working.
- Threads the reviewer replied to with further requests.
- Failures introduced by your own fixes that surfaced new comments.

Decide whether to continue the loop using ALL of these stop conditions. Stop **immediately** if any one is true:

1. **Nothing left to do** — after triage, the only remaining labels are \`out_of_scope\` or \`pr_questionable\`/\`unclear\` already deferred to the user this session.
2. **PR no longer open** — \`gh pr view\` reports \`state != OPEN\` or \`reviewDecision == APPROVED\`.
3. **No progress (anti-stall)** — the set of pending \`(comment_id, updated_at)\` tuples is identical to the previous iteration's set. This means your last fix did not change the world; do not retry, stop and report.
4. **Hard cap** — you have completed 5 iterations. Stop even if work remains and surface it in the summary.

Track iteration count in your scratchpad. Do not sleep, do not poll, do not wait for new comments — if step 1 returns nothing actionable, exit.

## 9. Final summary

Print a short summary listing:
- Number of iterations executed.
- How many comments were fixed, skipped (out_of_scope), or deferred (pr_questionable/unclear → user).
- Commit SHA(s) pushed.
- Which stop condition fired (1-4 above).
- If any \`change_request\` was addressed, note that the reviewer must re-approve manually — the agent's reply does **not** dismiss \`CHANGES_REQUESTED\` on GitHub.

Hard rules:
- Do NOT push to the default branch.
- Do NOT use \`--no-verify\`, \`--amend\`, or \`push --force\`.
- Do NOT mock internal logic in tests you touch; mock only at network/fs boundaries.
- Do NOT take destructive git actions (\`reset --hard\`, \`clean -f\`, branch deletion).${extra}`
}

function buildDryRunPrompt({
  prNumber,
  branch,
  args,
}: AutofixPromptInput): string {
  const extra = args.trim() ? `\n\nAdditional user input: ${args.trim()}` : ''
  return `You are an AI assistant integrated into a git-based version control system. The user invoked \`/autofix-pr --dry-run\` on PR #${prNumber} (branch \`${branch}\`). Your task is to fetch and display the comments on that PR. Do NOT edit any files, do NOT commit, do NOT push, do NOT reply on GitHub. This is a read-only listing.

Follow these steps:

1. Use \`gh pr view --json number,headRepository\` to confirm the PR number and repository info.
2. Use \`gh api /repos/{owner}/{repo}/issues/${prNumber}/comments\` to get PR-level comments.
3. Use \`gh api /repos/{owner}/{repo}/pulls/${prNumber}/comments\` to get review comments. Pay particular attention to the following fields: \`body\`, \`diff_hunk\`, \`path\`, \`line\`, \`in_reply_to_id\`. ${FETCH_REFERENCED_CODE_HINT}
4. Also fetch reviews via \`gh api /repos/{owner}/{repo}/pulls/${prNumber}/reviews\` so you can tell which review comments belong to a \`CHANGES_REQUESTED\` review.
5. Triage every comment (see rules below). Skip nothing.
6. Return the triaged listing in the format below — no additional commentary.

${TRIAGE_INSTRUCTIONS}

${PR_COMMENTS_FORMAT_INSTRUCTIONS}

Remember:
1. Only show the actual comments, no explanatory text.
2. Include both PR-level and code review comments.
3. Preserve the threading/nesting of comment replies.
4. Show the file and line number context for code review comments.
5. Use jq to parse the JSON responses from the GitHub API.${extra}`
}
