---
name: census-2026-11-26-cache-clean-explore-caps
description: Census 11-22..26 (claudin + ferrous-dns, v1.2.3) — cache and context clean (4 drops, all explained; 0 compactions); fixed in #370 — scoped git diffs kept by the read lane (26 of 63 caps), batch Read takes offset/limit, saved results up to 50k read whole, census miscounts (re-reads, WaitFor); Playwright re-pointed at Brave; mergeable 8.4→12.5% is the work mix
type: project
expires: 2027-01-26
---

Window 2026-11-22 → 11-26, claudin and ferrous-dns (infra-home-lab, olamma, claudin-site had no
calls), the census session left out: 42 main sessions, 28 sub-agent threads (Code 622 calls,
Explore 470), 3,903 API calls, 5,180 tool uses. $290.78 in the transcripts (claudin $259.71,
ferrous-dns $31.07; ~$73 a day, $52 on 11-16).

**Spend by source (whole sessions, cost-state):** main thread $256.68, auto-mode classifier
$26.56 (9%), Code agents $30.53, extract_memories $5.94, auto_dream $6.26, Explore $1.15.
No `agent_summary` row: the 11-16 default-off held.

**Main-thread cache: nothing new.** 4 drops, 568,888 tokens re-written (~$5, ~2%):
- two idle gaps over an hour (85 and 99 min), each followed by a relief clip;
- one relief clip by size at 729,725 tokens (263 results + 58 inputs, ~276k, window lane);
- one `/model` Sonnet 5.5 → Opus 5.5 at a session start (42k).
ferrous-dns 0. No flat no-write stretch. 1h TTL premium $19.33 against ≈$89.85 a 5m policy
would have re-written.

**Thinking drops ride the clips, as cache.md says:** in the two sessions with an idle clip, every
later call carried the same fixed set of `thinking_dropped: prefix_binding_mismatch` paths (136
blocks; 34, then 229 after the size clip) and read the cache back in full. New blocks survive.
The same pattern shows in 24 sessions 10-28..11-21; the onset was checked only in this window.

**Context:** 0 compactions, 0 overflows. Context per call p50 180k / p90 492k (claudin), 120k /
320k (ferrous-dns; 282k / 553k on 11-16). 7 `api_error` retries, 6 of them a network outage on
11-22 (ConnectionRefused, attempt ≤ 3 of 10, all recovered).

**The counters, against 11-16** (re-reads with the corrected census, 2,164 reads):
- Re-reads: duplicates 18 of 1,306 main (1.4%; 1.7% before), 2 of 858 sub (0.2%; 1.8%).
  Outline → body: auto 9 + 21 sub, asked 18 + 19 sub. After a Bash cut 4 + 9. After >1h idle 7
  (the clip). Before the fix the census counted a batch `view: 'outline'` as auto (7 of 16) and
  `sed -n A,Bp f | grep` as lines A–B shown.
- Mergeable requests: core union 12.5% of main (350 of 2,811; 8.4% before). **The work mix:**
  claudin went from 32% to 81% of main calls, and its own rate barely moved (core 11.3% →
  13.4%, M-chain:step 7.5% → 7.8%); reweighted to the old mix it is ~9.2%. `then` on Edit/Patch
  30% of edits (27% before). Ceiling of a fix: ~22 edit→verify calls that could have used `then`
  plus 7 Typecheck→test pairs, ~1% of calls. No change made.
- Bash caps: main 12, sub 50 (5 before), 43 in Explore, mostly `git show <sha> -- <path> | head
  -150` cut to 100 lines. **Fixed:** the lane keeps 26 of the 63 whole (the window grew during
  the day; 1 more accepted but past 28k chars), and 6 of those had been re-run.
- WaitFor 93 calls in claudin, 9 timeouts. The census reported 5 "re-polls" (0 before), all a
  **counter artifact**, now fixed: it counted any back-to-back WaitFor, whatever the command.
  All 5 first calls had matched: 3 were deliberate two-stage waits, 2 an `until` matching the
  prompt the model had typed, echoed in the tmux capture (`WaitForTool.ts:319-320` tests the
  whole output; not changed). Keyed on command + `until`, the count is 0 of 93.
- Empty slash-glob Greps 4 of 39.
- Tool errors 43 of 5,180 (0.83%; 1.1% before): 8 the user's rejections (5 of them
  ExitPlanMode plan reviews), 2 correct classifier denials, 3 batch skips, 17 the model's own
  commands exiting ≠ 0, 2 network, 9 tool-contract misses (3 read gates, 2 batch Read with
  `limit` — fixed, RunTests `files`, Glob `no_ignore`, an unquoted `(` in a Git `--format`, a
  guessed Grep path), 2 Playwright.

**The 11-16 checks:** 0 Grep prompts; no `(gone)` in either repo's rules; `edited_text_file` 38
(7.3 per 1k tool uses, 28.6 before) with 10 `child_written_files`; 1 Patch result `resolved
against the project root`. Playwright in ferrous-dns failed 2/2 on `/usr/bin/chromium` on 11-22.

**Fixed on `fix/census-2026-11-26` (2026-11-26; PR #370, merged as 0ee1fcfd):**
- The read lane keeps a diff of named paths (`isScopedGitDiff`, `fileReadShape.ts`) and reads a
  closing bare `| cat` as the identity ([[bash-read-lane]]). A whole commit, `--stat`, `-s`, `git
  log`, a show of a range, paths that spell the whole tree (`.`, `.//`, `src/..`, `'*'`, `*`,
  `..`, `/`), pathspec magic and `--output`/`--ext-diff`/`--textconv`/`--no-index`/`-c` keep
  the cap; a narrower glob is a path. Read credit never counts a diff.
- `git show <rev>:<path>` feeds a bound only when every operand is one (`isRevisionFileShow`,
  beside the scoped diff, behind the same `gitCommand`): a colon in `--format`, a `:!` pathspec
  or a commit beside a blob used to let a whole commit through. `:path` (the index copy),
  `--no-pager` and `-C` are read; `:/text` and a variable rev are not.
- A batch Read applies `offset`/`limit` to every file; `pages`/`encoding` stay single-file.
  `/resume` reads Codex's `null` placeholders as no range, for single Reads too (a bug from
  before this branch).
- A Read of a result this session saved (`resultDirs()`), up to 50k chars
  (`DEFAULT_MAX_RESULT_SIZE_CHARS`), skips the text preview; a paged one past that keeps it.
- The re-read census counts asked batch outlines, piped prints and a batch's offset as they
  are; the feature-usage census keys a WaitFor run on its command and `until`.
- Playwright MCP re-added in ferrous-dns and legendarr with `--browser chromium
  --executable-path /opt/brave-bin/brave`; navigate checked live. A navigate drops a
  `.playwright-mcp/` snapshot dir in the cwd, not gitignored in ferrous-dns.
- A three-agent review (bugs, conventions, regressions) found the whole-tree, range, Codex-null,
  paged-result and census-offset bugs above, plus five mutations no test caught; all fixed with
  red tests first.
- Not built, on purpose (user, 2026-11-26): a `for` variable as the rev (no census case needed
  it), and line filters with no bound after a diff (`| grep '^[-+]'`), since `cat f | grep X` is
  pinned as no read. `prompt.ts` was left alone; only the `file_paths` text names the range.
- Evidence: break-probe `census1126.json`, 43 probes, all red (four lines turned nothing red on
  first passes and got cases). Full suite 19,298 pass. Live on the bundle (Haiku 5.5): `git show
  <sha> -- <file> | head -150` came back as 150 lines in `<bash-output-read>`, `git diff A..B --
  '*' | head -150` was capped at 100, and a `file_paths` Read with `offset: 3, limit: 4` returned
  lines 3-6 of each file.

**Checks for the next census:** Explore caps against this window's 43, and the lane-kept count
in `cut-refetch-census --lane`; batch Reads with `offset`/`limit` succeed; Playwright calls in
ferrous-dns succeed; mergeable read per project, not pooled.
