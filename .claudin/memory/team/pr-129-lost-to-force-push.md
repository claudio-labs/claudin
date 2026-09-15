---
name: pr-129-lost-to-force-push
description: A merged PR's code vanished from main (locally AND on GitHub) via a non-fast-forward push; refs/pull/N/head is how to get it back, and `gh pr diff` lies about what the PR contained
type: project
---

On 2026-08-22 PR #129 (`refactor(bash): split bashPermissions and bashSecurity
into barrels`) merged cleanly — squash commit `97ac18e6`, parent `cdc87dc4`
(=`#128`). **Thirty seconds later a local branch that had not pulled the merge
pushed `1e5f7b88` on top of `cdc87dc4` and the merge commit was gone.** `#130`
built on that and cemented it. Nobody noticed for three weeks, because the
commit that survived was the *memory file recording the split* — so the docs
described 5,100 lines of work whose code no longer existed.

Recovered and re-landed on 2026-09-14 (see [[tier3-file-split-roadmap]]).

## How to detect this class of problem

The tell was a memory that disagreed with `wc -l`. Confirm it like this:

    gh pr view <N> --json state,mergeCommit      # MERGED, with a SHA
    git cat-file -t <that sha>                   # fatal: could not get object info
    gh api repos/<owner>/<repo>/compare/<sha>...main --jq .status
                                                 # "diverged" + behind_by 1

That last one is the one that matters: **GitHub's own `main` had also lost it.**
A non-fast-forward push rewrites the remote, so "it is merged on GitHub" is not
the same as "it is reachable from GitHub's main".

Census it across the whole repo by diffing two sets — merged PR numbers
(`gh pr list --state merged --limit 300 --json number`) against every `(#N)` in
`git log --oneline origin/main`. In this repo that came back 192 × 192 with
exactly one unmatched number, #129. (The counts matching was a coincidence:
local also carries a `#67` from the legacy Gitea numbering that GitHub never
merged. Compare the *sets*, never the counts.)

## How to get the code back

GitHub keeps `refs/pull/<N>/head` after the branch is deleted:

    git ls-remote origin "refs/pull/129/*"
    git fetch origin refs/pull/129/head:pr-129
    git cherry-pick <base>..pr-129            # base = the PR's base.sha

**`gh pr diff <N>` is worse than useless here** — it computes `base...head`
against the *current* main, so for #129 it reported 3 files / +492 instead of
the real 26 files / +6318. The API (`gh api .../pulls/<N>/files`) reports the
truth. Cherry-picking the range preserves the original commits and their
messages, which for a split is the whole review value.

Conflicts are only where the file drifted **after** the merge date. Check with
`git diff --stat <base>..HEAD -- <the PR's files>` before starting: for #129,
of the six files the PR touched, only `bashSecurity.ts`/`.test.ts` had moved
(by `e58d3ead`, #174), so nine of the ten commits applied clean and the tenth
needed the later fix re-applied into the module the split had created for it.

See also [[repo-prs-github-via-gh]] for the remote/`gh` setup this assumes.
