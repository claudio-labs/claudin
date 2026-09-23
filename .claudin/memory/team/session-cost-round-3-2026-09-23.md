---
name: session-cost-round-3-2026-09-23
description: Round 3 of the claudin-vs-Claude-Code session A/B (proxy-recorded, N=5, 2026-09-23) — only effort medium moves the 1.3–2× thinking gap; thinking display, ANTI_NARRATION, the rule map and removing tools do not; resubmit-by-reference and the watcher false-note fix shipped on perf/session-cost-round-3
type: project
---

Three runs of `scripts/bench/ab/session-cache-ab.ts --proxy`, every arm of a rep
running at the same time, N=5, Opus 5.5 at `--effort high`. All 90 claudin and
15 Claude Code sessions passed 18/18 hidden tests and made one commit (Claude
Code added an AI trailer 15/15, claudin 0/90). Thinking is the API's count per
message, recorded by the proxy. The run dirs are under `/tmp/session-cache-ab/`, so
they will not survive a reboot.

| median | thinking | cost |
|---|---|---|
| **A** `-201138` prompt/config, build d7680e9f | | |
| claude | 4.8k | $1.22 |
| claudindev / placebo | 10.7k / 6.7k | $1.66 / $1.54 |
| display=updates / ANTI_NARRATION=0 / rule map off | 8.5k / 10.9k / 9.4k | $1.48 / $1.54 / $1.71 |
| effort medium | 3.7k | $1.32 |
| **B** `-203733` tools, same build | | |
| claude / claudindev / placebo | 7.1k / 10.0k / 8.3k | $1.29 / $1.58 / $1.38 |
| no apply_patch / no RunTests+Typecheck / no Git | 5.7k / 8.7k / 8.8k | $1.60 / $1.59 / $1.50 |
| no Build+Grep+Glob+Skill+WaitFor+Monitor / all of these (cclike) | 8.7k / 6.1k | $1.40 / $1.50 |
| **C** `-210735` resubmit, build 4dbf1242 | | |
| claude / claudindev / resubmit off / placebo | 6.0k / 9.0k / 10.9k / 9.0k | $1.27 / $1.49 / $1.66 / $1.43 |
| effort medium | 4.5k | $1.20 |

**What moves the thinking.**
- **Effort medium, and nothing else tested.** Its thinking separates from both claudindev and the placebo in A (3.7k), and in C sits well under claudindev (4.5k). Its cost is Claude Code's: +8% in A and −6% in C, both inside the noise.
  - It verifies less: 16 reads instead of 25, and 2–3 test runs instead of 4–5.
  - It gets more read-gate refusals. The resubmit below now absorbs those.
  - Claude Code's own default on Opus 5.5 is medium; the bench forces high on both CLIs. Changing claudin's default is a product decision and is still open.
- **Not causes** (every one overlaps claudindev in A): `thinking.display` updates, `CLAUDIN_ANTI_NARRATION=0`, `CLAUDIN_DISABLE_RULE_MAP_SYNC=1`. The proxy bodies show both CLIs send `context_management: clear_thinking keep:all` and return prior thinking blocks.
- **Tools (B): no single tool is the cause.**
  - Without apply_patch, thinking drops ~40% but the model makes 48–62 Edit calls, and visible output rises 20–30% (old_string and new_string are re-sent). Cost stays flat.
  - Dropping the six rarely-used tools takes the first request from 28.4k to 21.2k tokens (cost −11%, overlap). But Grep is in 83% of real sessions and Build in 32% ([[request-prefix-size-2026-09-23]]); only Monitor (2.6%) is a cheap deferral.
- **Where the extra thinking sits.** It is spread over more, smaller turns (9 vs 14 turns that think at all). The planning peak, the resume turn and the rest are each about 2× Claude Code's.
- **The untested lever is the system prompt.** In `-p` it is 19.6k chars against Claude Code's 6.2k: `# Delivering work`, `# Corrections`, and a long memory section. The memory section is why claudindev's first command is often `ls .claudin`. Next A/B: `CLAUDIN_WORK_CONTRACT=0` plus a memory-section arm.

**Noise.** Claude Code's thinking moved from 4.8k to 7.1k between runs 26 minutes apart. Identical claudin arms differed by 17–59%. Compare only simultaneous arms, and judge a thinking arm against a placebo arm.

**Shipped on `perf/session-cost-round-3`:**
- **`*** Resubmit`.** A new `Tool.resolveInput` hook runs right after the zod parse. apply_patch keeps the patch when every problem was a served refusal.
  - In C, all 9 served refusals were answered with the sentinel, with 0 failures. The re-sent output was a median of 107 tokens; turns over 200 had a parallel call in them.
  - With `CLAUDIN_DISABLE_PATCH_RESUBMIT=1` the median was 5.6k tokens, over 3 sessions.
  - The first wording carried both "resubmit the same patch" and the sentinel hint. That was fixed before C.
- **Watcher false note** (`changedFile.ts`). Write tools keep the file's final newline in the read-state entry, and a Read's content does not.
  - A byte-identical rewrite was therefore reported as "modified by the user or a linter", with the file's last 9 lines as the change. Examples: `git stash` then `pop`, a `sed -i` undone by `cp`, and `bun run build`'s in-place pass.
  - Run A had 53 such notes in 16 of 30 claudin sessions. The released claudin showed it to this session after every build.
- **Bench.** `--proxy` (`wire-proxy.ts summarize <dir>`), `--arm-args`, API thinking per turn, cost by source, and served/resubmit rows. `--replay` rebuilds every run from its streams.
- **Test leak.** `StreamingToolExecutor.test.ts` re-pinned the live module namespace in `afterAll`, which kept its hanging `runToolUse` installed for later files. It now snapshots a plain copy.
