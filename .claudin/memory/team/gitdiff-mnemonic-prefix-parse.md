---
name: parseGitDiff must not assume a/ b/ prefixes
description: git diff.mnemonicPrefix emits c/ w/ (not a/ b/) and broke the /diff hunk parser — force prefixes + loose regex
type: project
---

`parseGitDiff` (src/utils/gitDiff.ts) extracts the file path from the `diff --git <src> <dst>` header. Users with `diff.mnemonicPrefix=true` in their git config get `c/path w/path` (commit/working), not the default `a/path b/path`; `diff.noprefix=true` drops prefixes entirely.

**Why:** the original header regex `^a\/(.+?) b\/(.+)$` returned null for `c/…w/…`, so EVERY tracked file produced zero hunks → `gitDiffResultToFiles` flagged all of them `isLargeFile` (its rule is `!fileHunks`) and the `/diff` reviewer showed "Large file" for every modified file. Reported 2026-06-18 from a live `claudindev` session.

**How to apply:** two-layer fix shipped — (1) force standard prefixes on the git commands that feed parseGitDiff: `git diff HEAD --src-prefix=a/ --dst-prefix=b/` (fetchGitDiffHunks) and `git stash show -p --src-prefix=a/ --dst-prefix=b/` (fetchStashDiff in gitLog.ts); (2) relaxed the header regex to `^.\/(.+?) .\/(.+)$` as a safety net. Regression tests in gitDiff.test.ts cover both prefix styles. ⚠️ `fetchSingleFileGitDiff` → `parseRawDiffToToolUseDiff` (the transcript "Update(…)" tool diffs) parses `git diff` output separately and was NOT audited — it likely has the same latent mnemonic-prefix bug.
