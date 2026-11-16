---
name: census-2026-11-16-grep-env-prompt-map-drop
description: Census 11-14..16 (claudin + ferrous-dns, first field data for v1.2.2) — main cache clean; three things broken (a negated Grep glob asked for .env on 34 of 34 Grep prompts and dropped the .env exclusions, the navigation map deleted web/ on every sync, Playwright MCP unused behind a stale memory) and four cost leaks (agent_summary +57% over the agents, child writes as diff notes, the dream forking the whole parent, classifier reads up); fixed on fix/census-2026-11-16; dream-without-conversation eval kept the switch off
type: project
expires: 2027-01-16
---

Window 2026-11-14 → 11-16, claudin and ferrous-dns, the census session left out: five whole
sessions on v1.2.2 and the tail of one on v1.2.1, 17 sub-agents, 1,456 calls (34% in
sub-agents), 2,061 tool uses. $129 in the transcripts (~$52 a day; $45 on 11-09).

**Spend, $161 over the five whole sessions (cost-state `sourceUsage`):**

| Source | $ | share |
|---|---|---|
| main thread | 107.80 | 67% |
| auto-mode classifier | 20.22 | 12.6% |
| Code / Explore sub-agents | 14.76 / 1.07 | 9.2% / 0.7% |
| auto_dream | 6.09 | 3.8% |
| agent_summary | 6.05 | 3.8% |
| extract_memories | 4.78 | 3.0% |

**Main-thread cache: nothing new.** Three rewrites, 1.16M tokens (~$9, 7% of spend): two idle
over an hour (290 and 564 min) and one relief clip at 719k. No compaction, no overflow. Context
in ferrous-dns: p50 282k, p90 553k, 47% of calls over 250k (32% before); cache reads are 57% of
spend.

**The counters, against 11-09:**
- Re-reads: real duplicates 7 of 415 main reads (9 of 917), 10 of 558 in sub-agents; outline
  then the whole body 6. No tool was called twice with the same input and nothing between.
- Mergeable requests: 8.4% of main (158 of 1,891), unchanged; 11.2% in sub-agents. Deferred
  tools called directly 329 times at 98.5% success; ToolSearch 6.
- Bash caps 9, recovered 2 of 4 on main and 1 of 5 in sub-agents; the read lane keeps none.
- WaitFor 51 calls, 0 re-polls (5 before). Slash-glob Greps that came back empty: 2 of 9.
- Tool errors 23 of 2,061 (1.1%; 1.27% before), 7 of them the user's rejections. What #346
  fixed stayed at zero: `~` in a pipe, multi-path Grep, Glob timeouts.
- Agents: 17 calls (10 Explore, 7 Code), 0 errors. Of the 92 reads the parent made right after
  an agent, 30 were of files that agent had read (the read gate, by design).
- MCP: 25 Playwright tools deferred, 0 calls.

**Broken, and fixed on `fix/census-2026-11-16` (2026-11-16):**
- **A Grep glob led by `!` asked for `.env` approval** — 34 of 34 Grep prompts, ~46 min waited,
  a regression of #352 in v1.2.2. picomatch reads the `!` as negation, so `!*.test.*` "matched"
  `.env`. Approved, the search also ran without the `.env` exclusions and could print a dotenv
  file. One 864 s wait expired a Haiku sub-agent's 5m cache (117k rewritten). The fix is in
  Grep (`namesEnvFile`), not in `globCouldMatchEnvFile`: Bash reaches that helper too, and
  there `!(*.md)` is an extglob that can select `prod.env`.
- **A look-around pattern was refused** (3 in a row in one sub-agent), the error naming a
  `--pcre2` flag the tool cannot pass. Grep now searches once more with PCRE2 when ripgrep says
  the pattern needs it.
- **The navigation map deleted `web/` from ferrous-dns on every sync.** It counts only the
  dominant extensions (`.rs`, `.sql` there), so a directory of 61 tracked js/css/html files
  read as zero and lost its line and annotation, 27 s after being restored by hand. Details and
  the consequence are in [[rule-map-end-of-turn]].
- **Playwright MCP:** see "Outside this repo" below.

**Cost leaks:**
- **agent_summary: $6.05 for 76 calls in one session, 57% on top of what its agents cost**
  ($4.26 for 16 in another). Every background sub-agent forked its whole conversation every
  30 s on its own model for a 3-5 word line the Agents row does not need. **Decision (user,
  2026-11-16):** off in the default TUI. It runs in coordinator mode, when the SDK asks for
  progress summaries, or with `CLAUDIN_AGENT_SUMMARY=1`; where it runs, a transcript that has
  not grown is not summarized again. Why one tick writes 10–49k tokens of cache was not measured.
- **59 `edited_text_file` notes, 248K chars, 28.6 per 1k calls (7.6 on 10-24), none from the
  user:** 38 were memory files the session's own forks rewrote and 21 files its background Code
  agents edited. A child's writes now reach the parent as one `child_written_files` note with
  names only ([[own-writes-next-census-checks]]).
- **A Read inside `.claudin/worktrees/<agent>/` attached that checkout's AGENTS.md and seven
  rules again** (~14K chars, once). An identical copy whose main-checkout counterpart is in
  context is now skipped; a differing one still attaches.
- **auto_dream forks the whole parent:** $3.49 for one run reading 487k on each of 24 calls.
  `CLAUDIN_AUTO_DREAM_FRESH=1` drops the parent's messages. The eval
  (`scripts/bench/results/dream-fresh-eval-2026-11.md`, 3 reps, placebo arm) kept quality
  (9 of 9 checks in every rep) and read less per call, but wrote about twice the output and cost
  × 1.64 in the bench, where the parent is one `ok`. Break-even is a parent past ~90k tokens.
  **The switch stays off.** Candidate, not built: keep the first message, which carries the
  memory indexes, and drop the rest.
- **The classifier's window budget saved 18% in the field, not the replay's 32%:** writes halved
  ($0.054 → $0.044 a call) but reads went from ~59k to 97–147k tokens a call.
  `CLAUDIN_CLASSIFIER_WINDOW_CHARS` (200k–800k) now lowers the cap. Replayed over this window:
  800k $12.63, 400k $11.48, 250k $10.29
  (`scripts/bench/results/classifier-window-cap-replay-2026-11.md`). The default stays 800k:
  the live A/B cannot test a cap yet ([[classifier-transcript-stable-cut]]).

**Also fixed there:**
- **Patch after a `cd` (decision: user):** a 14-file patch was lost to "the file does not exist"
  after `cd web/static`. An Update or Delete whose path is missing under the shell's directory
  and present under the session root goes to the root and the result says so; its Move follows
  it; an Add stays under the shell's directory. Read, Edit and Write remain cwd-relative.
- Two census counters: a batch Read was one read of an empty path (61 reads, 572K chars under a
  blank basename), and "spend by source" summed sessions with no call in the window.

**Outside this repo:** the ferrous-dns memory `playwright-mcp-schema-fallback` still blamed a
schema bug #298 fixed on 10-15, and 19 Playwright scripts (78K chars) were written by hand in
the window. Checked live: the server there fails only because it is configured with
`--executable-path /usr/bin/chromium`, which is gone; with `/opt/brave-bin/brave` it works. The
memory was rewritten with `expires:`; the config was not changed.

**Measured and not addressed:** context size (early compaction was decided against,
[[large-window-compaction]]); `extract_memories` at $4.78 in one long session, 43% of it 1h
cache writes for a fork of at most five turns; a plan-mode refusal of a Git batch that names no
command (1 case); persisted Grep results fetched again 4 of 4 times in sub-agents; a 28-slice
walk of one 281K HTML file in ferrous-dns; a live A/B of the classifier cap.

**Checks for the next census:** 0 Grep prompts carrying a `!` glob; no `(gone)` for a directory
that still has tracked files; `edited_text_file` back near 7.6 per 1k calls, with
`child_written_files` in its place; no `agent_summary` source in default-TUI sessions; Patch
results carrying `resolved against the project root`; Playwright MCP calls in ferrous-dns.

Evidence: break-probe `census1116.json` (28 probes; two lines of the child-write record turned
nothing red on the first pass and got tests). Full suite 18,723 pass. Every fix was also checked
live on the bundle (tmux, Haiku 5.5), and the map on a clone of ferrous-dns with its damaged
file: one sync brought `web/`, `static/` and `vendor/` back, a second was a no-op.
