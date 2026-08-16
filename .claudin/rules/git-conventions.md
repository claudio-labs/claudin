# Commit & PR Titles — Claudin Development Rules

No `paths:` frontmatter → this rule is **always in context**. PRs here are
squash-merged, so the PR title becomes the commit subject on `main`, and that
subject is published verbatim as a `CHANGELOG.md` line.

    type(scope): imperative summary, lowercase, no trailing period (#PR)

`scripts/release/release-notes.ts` is the source of truth for `type`: feat, fix,
perf, refactor, ci, build, docs, test, chore, style, revert. A `!` after the
scope marks a breaking change; `chore(release)`/`chore(changelog)` are dropped
as release-bot bookkeeping.

Nothing fails when a title misses the format — `classify()` returns `misc`, so
the entry lands under **🔧 Miscellaneous** instead of its own section. v1.1.14
shipped that way: #103, #104 and #105 were all `feat` and all published as
Miscellaneous.

So check the title before opening the PR, and again before merging — the merge
UI keeps whatever the title says. After the merge the fix costs a rebase and a
force-push over published history.
