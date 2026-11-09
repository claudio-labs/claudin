---
name: census-2026-11-09-tilde-pipes-interrupt-break
description: Census 11-04..09 (claudin + ferrous-dns + infra-home-lab) — piped Bash never expands `~` since the 07-13 shell-quote bump (54 visible failures since 07-14); one new client-side cache break from Esc + a queued prompt during a running tool; Glob timeouts on a 101G target/; tools 1.27%; WaitFor and slash-glob fixes held; all fixed on fix/census-11-09-tool-errors
type: project
expires: 2027-01-08
---

Window 2026-11-04 → 11-09T18:32Z, the census session left out. 15 main sessions, 44 sub-agent
threads, 3,571 API calls (sub-agents 39%), 5,023 tool uses. $263, about $45/day: cache reads
56%, writes 25%, output 19%. The classifier (`auto_mode`) cost $60 over 1,327 calls, $0.045 per
call (it was $0.048 on 10-30). The 1h TTL premium was $21, where a 5m TTL would have rewritten
about $143.

**Bug: a piped Bash command never expands `~`.** Verified live:
- `ls -d ~/.cache | wc -l` gives `cannot access '~/.cache'`;
- the same command without the pipe works.

Cause: `rearrangePipeCommand` (`src/platform/bash/bashPipeCommand.ts:14`) re-parses a piped
command and rebuilds each word with `quote([entry])` (`:194`). shell-quote 1.12's `quote()`
escapes `~`. The function already bails to the whole-command eval for `$VAR` (`:30`), because
the same round trip would drop the variable.

Corpus since 05-01: 328 piped Bash calls carried a `~/` word and 54 of them visibly failed. The
first failure is on 07-14, the day after the #6 deps bump. None of the 75 unpiped calls failed.
Silent failures (`2>/dev/null`, `| head`) are not in that count. One artifact is a literal
`ferrous-dns/~/.cache/ferrous-318/bin/` directory left on 11-04. The function has no test file.

**Cache: 7 drops on main, about 1.57M tokens rewritten.**
- 4 were idle >1h: 137 min, 166 min, 461 min, and a resume after 4.9 days.
- 2 were relief clips (window lane) at about 733k (`[Cache:]` named both).
- 1 is a new cause: 660bb320 11-09T16:09Z, `messages mutated at 164/185 (user: tool_result,text)`,
  7 thinking blocks dropped, 138k rewritten. The user pressed Esc and submitted a prompt while
  WaitFor was running. The transcript records the prompt BEFORE the aborted tool_result, and both
  have the WaitFor tool_use as parent. An Explore trace of the source
  (bytes were not captured):
  - `onCancel` calls `queryGuard.forceEnd()` (`REPL.tsx:1664-1705`), so `useQueueProcessor`
    submits the prompt before the aborted query yields its tool_result and interrupt marker;
  - from the next turn on, `normalize.ts:840-851` and `:1028` merge and hoist that message
    differently;
  - from the source, `sessions/resume/chain.ts:144-150` would leave the prompt off the resumed
    chain. Not reproduced.

**Context:** no compactions, overflows or `max_tokens`. p50 136–156k, p90 492–555k, max 735k.
32% of calls were over 250k.

**Tools: 64 errors in 5,023 calls (1.27%; 10-30 had 1.1%).**
- Bash 23/1,702:
  - 4 classifier denials, each with a sound reason;
  - the `~` bug;
  - the rest are real exit codes.
- Git 15/330:
  - 7 real failures;
  - 4 refusals of an operator glued inside a word: `--grep=(web)`, `issues?a=1&b=2`;
  - 1 call with more than 10 commands.
- Grep 9/741:
  - 6 paths that do not exist, 2 of them several paths in one `path` string;
  - 2 patterns with a literal `\n` and no multiline.
- Glob 3/32: all were 20 s ripgrep timeouts in ferrous-dns sub-agents. `glob.ts:215-226` bounds
  the depth of an anchored pattern only under `respectGitignore`, so `migrations/*.sql` walks the
  101G `target/`: 0.51 s warm against 0.003 s with `--max-depth 2`.
- Patch 1: a `[clipped: …]` placeholder written 27 s after a relief clip. The guard refused it.

**Held from 10-31 ([[tool-repeat-calls]]):**
- WaitFor re-polls went 35 → 5, and none followed a timeout.
- CI polls that timed out went 25/30 → 2/9.
- Empty slash-glob Greps under another path went 24/28 → 3/31.

**Re-reads and cuts:**
- True duplicates on main: 9 of 917, against 37 on 10-30.
- An outline was followed by a full body Read only 6 times; the other follow-ups were ranges.
- The core mergeable union is 8.4% of calls (18% on 09-24).
- In sub-agents, a Bash cap now doubles recovery: 29.2% (14/48) against 15–17% after uncut
  output. Mostly it is `cd X && …` and `git diff` asked again. On main a cap adds nothing
  (1/8).
- The lane kept 0 of 56 caps whole.

**Fixed on `fix/census-11-09-tool-errors` (2026-11-09).** There is a red commit with 37
census-input tests, then one fix per cause. Every fix line is probed in
`scripts/migrations/probes/census1109.json` (24/24 red).
- **Bash:** a piped command now runs as `eval '<cmd>' < /dev/null`, the path the
  `$VAR`/loop commands already took. The rebuild is deleted. Checked live: `ls -d ~/.cache | wc -l`
  prints `1`, and `{a,b}` expands.
- **Esc:** `onQuery` settles an older turn before it appends (`cancelledTurn.ts`, ≤5 s; a
  turn past that is abandoned and its late messages are dropped).
  - Guards: the loopPrefix "a turn cancelled mid-tool" scenarios and `useOnQuery.wiring.test.ts`.
  - Live, Esc on WaitFor and on Bash then a prompt at once: a linear chain, hits of 98–99%, and
    the model saw the abort. Both tools answered the abort in about 80 ms, so the slow-abort race
    itself was NOT reproduced live, only in the harness.
- **Resume:** `chain.ts` recovers a prompt that sits beside an aborted result and has nothing
  below it.
- **Glob:** an anchored pattern walks from its literal base, bounded by its depth
  (`rebaseAnchoredPattern`). On ferrous-dns the three census patterns ran in 2–23 ms with the
  same counts.
- **Git:**
  - no batch cap (past 50 it asks, as Bash does);
  - a `(`/`&` inside an argument is told to quote it.
- **Grep:**
  - a space-separated `path` searches every piece, with a permission check per piece;
  - an unescaped `\n` turns on `-U`.
- **Smaller fixes:** TaskStop on a stopped task succeeds; an escaped md heading is found;
  `limit: 0` means no limit; Edit on a missing file names Write.

**How to apply:** use this as the baseline for the next census. After the merge, piped `~`
failures, Grep multi-path/`\n` refusals and Glob timeouts should be 0. A cache break named
`messages mutated … (user: tool_result,text)` after an Esc means a tool whose abort ran past
5 s, or a turn that started without going through `onQuery`.
