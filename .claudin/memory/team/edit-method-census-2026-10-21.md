---
name: edit-method-census-2026-10-21
description: Claude Code edits through Bash (python heredocs, sed -i, cat >) because 2.1.28x+ injects a "bash-first" steer in auto AND bypass mode; paired benches Opus 5.5 CC 98% Bash vs Claudin 3%; the 10-21 A/B found it cost-neutral (N=5, within placebo). Any CC-vs-Claudin bench run with --dangerously-skip-permissions carries it
type: project
---

Census 2026-10-21 over `~/.claude/projects` and `~/.claudin/projects`, tool_use deduped by
id, `-tmp*` projects = bench. A Bash call counts as an edit for `sed -i`, `perl -i`,
python `open(…,'w')`/`write_text`, node/bun `writeFileSync`, `cat >`/heredoc, `echo >`,
`tee`, `git apply`, skipping /tmp and scratchpad targets (heuristic, ~10% noise in
plain `>` redirects). The script is `edit-census.ts` in that session's scratchpad, ~250
lines; rebuild it rather than hunt for it.

**Mechanism (CC 2.1.304 binary).** An `auto_mode` attachment with `bashFirst` is emitted
in auto mode *and* in bypass mode (`bypass: s`) when Bash plus Edit/Write are loaded,
gated by `Aln()` (session assignment forced/none/cohort, env `CLAUDE_CODE_THRIFTY_SONIC`).
Strict variant (default): "Do your work through the Bash tool wherever it can … make file
changes with sed, heredocs, or short scripts, rather than using the dedicated Read, Edit,
or Write tools. Fall back to a dedicated tool only when Bash genuinely cannot do the job."
`bashFirstSteer: "relaxed"` (`tengu_cozy_teapot`, `CLAUDE_CODE_COZY_TEAPOT`) is the soft one.
This extends item 3 of [[claude-code-2.1.284-wire-diff]], which saw it in auto mode only.

**Paired benches (same task, same model):**
- Opus 5.5, session-cache-ab 10-09 `-230350`: CC 1 dedicated / 42 Bash; claudindev 35 / 1.
- Opus, 09-23 `-042026`: CC 3 / 31; claudindev 24 / 2.
- Sonnet 5.5, build-project-ab ×5 (09-29): CC 0 / 85; claudindev 50 / 19.
- Sonnet 5.5, session-cache-ab 10-09..10-15: BOTH ~100% python heredocs. That is the model's
  own habit, and Claudin's "Edit (not sed/awk)" Bash text does not move it.
- Controls where CC used Edit: acceptEdits mode (three-cli-ab), a prompt saying "use the
  Edit tool" (relief-ab), and 2.1.278 (cli-search-edit-ab).

**Real traffic.** CC (auto mode, small sample): Opus 41 of 52 edits via Bash, Sonnet 17 of 53.
Claudin: Opus 14% (2,274 / 16,056), Sonnet 3%. October Opus hit 24%, but 1,072 of its 1,514
came on 10-01..05, during the clean-base rewrite, as python heredocs in `/tmp/claudin-rewrite-sandboxes`.

**A/B the same day — cost-neutral.** Run `/tmp/session-cache-ab/20261021-133607` (rep 1) and
`-134048` (reps 2-5), Opus 5.5 medium, N=5, all 30 sessions 11/11 + 7/7. Arms: CC 2.1.304
default (relaxed today), `CLAUDE_CODE_COZY_TEAPOT=strict`, `CLAUDE_CODE_THRIFTY_SONIC=0`
(off: the attachment goes and the Bash description goes back to "Avoid … cat, head, sed");
claudindev; claudindev plus the relaxed text through `--append-system-prompt-file`; placebo.
Every switch was checked first against a local stub (`startStub` from
extract-claude-code-prompt.ts). The CC variants ran through a dispatch shim passed as
`--bin-claudindev`, so their `--version` line in the report is mislabeled.
- Cost medians $0.97–$1.06 in every arm, all ranges overlap. bashfirst vs claudindev −6%,
  placebo vs claudindev −4.4%. Requests +13% (17 vs 15), output −11%, both overlap.
  No cache breaks anywhere.
- Mechanism engaged in Claudin: edits via Bash 58% vs 12% (placebo 7%).
- CC with the steer OFF still edited 79% via Bash (41/52) and read with cat 23 vs Read 6.
  The steer is not what makes CC on Opus 5.5 use the shell.
- The one Claudin-specific cost: a file it Read and then changed via Bash comes back as
  `edited_text_file`. That happened in 3 of 5 bashfirst sessions and in none of the other arms;
  one session got 11 notes, ~30k chars, and a 6.4k resume write. Own writes is the fix (`CLAUDIN_OWN_WRITES`, still off).
- Claudin arms think about 2× as much as CC arms (4.5k vs 2.4k, SEPARATED). That holds with or without the steer.
- The run took about 50% of the Max 5x 5-hour window (4→54%), and the 7-day window went 4→7%.

**Follow-up census — "file modified" notes in real Claudin traffic (Sep–Oct).** There were 2,146
`edited_text_file` notes, deduped by uuid (`own-writes-census.ts`, same scratchpad). For only
111 (5%) did the last 6 tool calls hold nothing that could have changed the file:
- 660 came after a Bash/Git call naming the file, 267 of them a classified edit;
- 588 after a git checkout/stash/reset/rebase;
- 146 after a build (the in-place preprocess), 143 after `bun test`, 118 after a formatter;
- 380 after some other command.
That is ~4.5M chars, ~1.1M tokens. The note claims the user made the change. On main at the
time, `ownWrites.ts` was hooked only in BashTool.tsx, so Git/Build/RunTests were not covered.
The bashfirst arm above (Read, then a Bash edit) is the bench the parked own-writes decision
asked for ([[bash-read-lane]]).

**Implemented the same day: branch `fix/own-writes-every-tool`, pushed 10-21, no PR yet.**
- What it does now:
  - `settleOwnWrites` (`src/agent/attachments/ownWrites.ts`) runs in `runToolUse` after `call()`
    settles, whether it returned, threw or was interrupted, and before PostToolUse hooks.
  - It runs when `tool.mayChangeFiles?.(input) ?? !tool.isReadOnly(input)`. AgentTool is
    `isReadOnly()=true` for permissions, so it sets `mayChangeFiles` to true.
  - The paths go on the tool_result message (`refreshedFiles`), and `extractReadFilesFromMessages`
    rebuilds them for any tool.
  - The switch is `CLAUDIN_OWN_WRITES=1`, still OFF.
- Zero-cost proof: read-credit-e2e scenarios 17, 18 and 24-26 pass through the bundle (a failing
  Bash run, a Git checkout, the off control). Scenarios 2, 7 and 10 fail on main too: stale
  read-gate expectations, not from this branch.
- Live A/B `/tmp/session-cache-ab/20261021-145847` (bashfirst text; off, on and placebo; N=3;
  caps 20,15). Against the gates set before the run:
  1. ON had 0 notes, against 12 notes (14.6k chars) in 4 of the 6 off/placebo sessions. PASS.
  2. All 9 sessions passed the hidden tests. PASS.
  3. **Cost FAIL**: ON $0.998, OFF $0.926, placebo $0.927. The band was only $0.001 because the
     placebo median happened to equal OFF. Requests went 22 against 17/19, and the call
     sequences show different exploration paths, not re-reads of the claimed files.
  4. No resume write in ON over 1.2k. PASS.
  - One call's `git stash && bun test` claimed 5 src files at once, correctly.
  - The window went 61→76%. A rerun at N=5 needs about 25%, so it waits for the reset.
  - Default not flipped.
- **Why the requests rose: path variance, not the switch.** ON r3 never fired at all, and r1/r2 were
  already behind before their first claim, where the history is byte-identical to OFF's. No claim
  was followed by a re-read of the file it named.
- **Branch-point replay** (`own-writes-replay.ts`, a scratchpad script, not committed):
  - 4 OFF sessions were recorded `--proxy` (`/tmp/session-cache-ab/20261021-151654`), giving 10
    branch points.
  - Each branch point's ON twin is the same body, with the notes removed and the claim line put in
    the first note's place. Each twin was sent 4× without streaming.
  - Results:
    - next action checks the named file: 0/40 vs 0/40;
    - tool mix the same;
    - mean output 1742 vs 1660 tokens;
    - context 367–1627 tokens smaller per event, −$0.073 over 4 sessions (≈ −2% of session cost).
  - That run took the 5h window from 84% to 92%.

**How to apply:** a CC arm under `--dangerously-skip-permissions` edits with Bash by design.
So an edit-shape, read-gate or own-writes comparison against it compares prompts, not
models. To compare tool choice, run CC in `default`/`acceptEdits`, or pin the variant
through those env vars. Bash edits are also what `ownWrites.ts` (`CLAUDIN_OWN_WRITES`)
exists for.
