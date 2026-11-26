---
name: census-2026-11-26-tool-followups
description: Tool census 11-19..26 (claudin + ferrous-dns, 5,939 paired uses) checked against the corpus since 09-01 (94k calls) — Git cut full:true output at 30,000 bytes (68 results), WaitFor ^/$ anchored the whole output (12 timeouts with the line present), missing paths named no file (top error Oct–Nov); fixed with Git word quoting, Read over-cap paging, Grep -o/exclude, census exits/--dump and scripts/dev/tui-probe on fix/tool-census-followups-2026-11-26; the review round fixed 10 more (Read refresh marker, page recount, flag-value quoting)
type: project
expires: 2027-01-26
---

Window 2026-11-19 → 11-26, claudin and ferrous-dns, this session left out: 5,939 paired tool
uses. Each finding was then re-counted over the corpus since 2026-09-01 (94,205 calls) and
reproduced on `main` before any fix: 21 red, 9 controls green. This is a different census from
[[census-2026-11-26-cache-clean-explore-caps]] (11-22..26, Explore caps, batch Read range).

**Found and fixed on `fix/tool-census-followups-2026-11-26` (2026-11-26):**
- **Git cut at 30,000 bytes, silently.** 68 single-command results since 09-01 at exactly the
  cap, 66 with `full: true`, mostly review sub-agents reading `git diff main...HEAD`; a wide
  diff was summarized from its first 30k (8 files counted as 1). `run.ts` read `result.stdout`
  (the shell's first 30k) for everything but a watch; it now reads the spill file
  (`readFullShellOutput`) and storage pages it. Live: a 185.5 KB diff came back as
  `<persisted-output>` whose file holds all 189,939 bytes.
- **WaitFor `^`/`$` anchored the whole output.** 12 of the 124 timeouts since 09-01 had the line
  they waited for (`^exit \d+` waited 1,200–1,800 s on ~7 min suites). `untilPattern.ts` adds `m`
  unless the pattern holds a lookaround anywhere (the CI "nothing pending" idiom, 9 uses, and its
  tempered form) or `^$`/`^\s*$` as any alternative; a poll matches the output as polled or
  without its trailing newlines. The 12 still match on their first poll.
- **Git refused plain words bash reads literally**: `--grep=#298`, `--format=%(refname:short)`,
  `--grep=(web)`, `issues?a=1&b=2` (six refusals 11-04..26). `parseGitCommand` quotes such a
  word, a flag after its `=` (`--grep='#298'`), and `resolveInput` hands that command to the
  classifier and permissions; a `#` that starts a word, `&&`, a background `&` and the operators
  stay refused. A whole-word `'--grep=#298'` made Bash's permission check ask ("quoted
  characters in flag names") where a `Bash(git log:*)` rule allows the value-quoted form.
- **A missing path named no file** — the top tool error of Oct–Nov (Grep 37, Read 7, nearly all
  sub-agents). `src/tools/shared/missingPath.ts` (Grep, Read, Glob, Edit) names siblings the name
  starts, then up to three same-name files or dirs from `rg --files`, never one the session's
  Read deny rules hide.
- **Read over the token cap refused** (15 since 09-01, 9 of them in Oct–Nov; one sub-agent
  re-sent the same Read 4×): a `view: 'full'` or ranged Read now returns the lines that fit,
  counted again and halved until under the cap, and the offset and limit of the next page. The
  changed-file refresh treats such a page as over the cap, as it did the error. Live: lines
  1–467 of 1,600, `offset=468 limit=467`, then lines 468–934.
- **Grep** gained `-o` (6 InputValidationErrors) and `exclude` (4, Glob's name for it).
- **Census**: a range in `--since` exits 2, an empty window exits 0 (it exited 1 and the
  response chain skipped 10 sibling runs); `--dump=<file>` writes the paired calls (33 ad-hoc
  transcript scans in the window); `--project` takes a list. The skill says so.
- **`scripts/dev/tui-probe.ts`**: start/send/keys/capture/stop on a private tmux server, waiting
  until the footer's `esc to interrupt` is gone (106 Bash tmux calls and 53 WaitFor polls in the
  window, 113 in one session). Named in `ink-tui.md` and `scripts/README.md`.

**Decided by the user (2026-11-26):** the WaitFor exception is the lookaround, not "the pattern
spans lines" (that left 2 of the 12); Git quotes `#`, `(`, `)` and `&`, not only `#`; the dump is a
flag, not a script; `FileReadTool.ts` (8% covered) is covered where the logic lives
(`missingPath.ts` 100% of functions, 97% of lines, + a `call()` test). Left alone on purpose: Git, Build, RunTests and
Typecheck leave their spill file in the session's `tasks/` dir after reading it (only Bash adopts
it; pre-existing, a PR for all four if ever).

**Review round (2026-11-26, bugs / elegance / plan fulfilment):** after a green suite and a
43/43 break-probe, the bug lens found 7: the changed-file refresh relied on the over-cap
error and got a page (a fake diff, Write let through); a page over the cap; a note with no
limit (the 256 KB cap again); three WaitFor patterns that changed meaning; an empty `exclude`
emptying Grep; a hint naming a deny-hidden file; tui-probe `send '-x'` and `--until` before the
grace. The elegance lens found by reading that a `\"` in a double-quoted message let a word of
it be quoted; the plan lens found the page recount never built and session-census still
exiting 1. The fix round found the flag-quoting ask above through a pin the plan lens asked
for. All fixed with red tests first. Not built, on purpose (user, 11-26): the elegance cleanups
(one message helper for the four tools, rg filtering by glob, one glob helper in Grep, `dev/` in
AGENTS.md), the same-name fallback past three siblings, and `stop` killing the pane's process.

**Found, not fixed (pre-existing on main):** Grep `output_mode: "count"` on a single file
reports "Found 0 total occurrences across 0 files" under the count, because rg omits the file
name for one file and only `symbols` mode passes `-H`.

**Checked and dropped:** a one-entry `file_paths` is already a `file_path` since #298 (the 2
errors predate it); a Read past the 256 KB size cap still refuses `view: 'full'`, but the corpus
has 0 such refusals since 09-01; no `until` used a PCRE-only escape (`\Z` is a literal `Z` in JS).

**Evidence:** red tests first (35 fail across 8 files, then 26 across 10 for the review);
break-probe `censusFollowups{Git,WaitFor,Tools,Scripts}.json`, 65 probes, all red (three lines
turned nothing red on a first pass and got cases); full suite 19,320 pass; live on the bundle
with Haiku 5.5, ~$0.026 for every check, the permission one in default mode.

**Checks for the next census:** Git results at exactly 30,000 bytes (expect 0); WaitFor timeouts
whose last output holds the `until` line; Git "inside the argument" refusals; Grep/Read
"does not exist" without a "Did you mean"; Read "exceeds maximum allowed tokens"; ad-hoc
`python3`/`grep` passes over `~/.claudin/projects` against `--dump` use; raw tmux calls against
`tui-probe` use.
