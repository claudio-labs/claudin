# narration-updates-ab — 2026-09-23T03:16:25.877Z

claudindev, reps=3, CLAUDIN_THINKING_DISPLAY=updates, arms: on, off, carveout (on = default prompt, off = CLAUDIN_ANTI_NARRATION=0, carveout = default + the carve-out sentence).

> **Correction, added by hand after the run.** The block counts this version
> of the script took were doubled: `claudindev`'s stream-json printed each
> assistant event twice (same uuid), and the script did not deduplicate. It
> now does. In the tables below, the ratio column (updates per tool call),
> turns, output tokens and cost are unaffected, and the two count medians are
> zero either way, so the decision stands. The sample lines repeat for the
> same reason.
>
> The 18 runs, per model and arm, with progress updates per run:
> - Opus 5.5: ON 0/0/0, OFF 0/0/1, carve-out 0/0/0
> - Fable 5.1: ON 0/0/0, OFF 0/1/0, carve-out 0/0/0
>
> The control was interactive Claude Code 2.1.280 on the same fixture, with
> the real API and display "updates" by default: Opus 5.5 wrote 0 progress
> updates (3 tool calls), and Fable 5.1 wrote 1 (17 tool calls).

### claude-opus-5-5

| arm | pass | updates/tool (median, range) | progress updates | text narration blocks | turns | output tok | cost |
|---|---|---|---|---|---|---|---|
| ANTI_NARRATION on | 3/3 | 0.00 (0.00–0.00) | 0 | 0 | 13 | 2373 | $0.194 |
| ANTI_NARRATION=0 | 3/3 | 0.00 (0.00–0.08) | 0 | 0 | 12 | 2423 | $0.207 |
| on + carve-out | 3/3 | 0.00 (0.00–0.00) | 0 | 0 | 16 | 2538 | $0.228 |

updates per tool call: OVERLAP → ANTI_NARRATION stays as it is
carve-out vs ON (exploratory): OVERLAP

sample progress updates:
- "I've identified the real call sites: `summary.js`, `checkout.js`, `invoice.js`, and `badge.js` (via an alias). Other files only reference the name in comments/s"
- "I've identified the real call sites: `summary.js`, `checkout.js`, `invoice.js`, and `badge.js` (via an alias). Other files only reference the name in comments/s"

### claude-fable-5-1

| arm | pass | updates/tool (median, range) | progress updates | text narration blocks | turns | output tok | cost |
|---|---|---|---|---|---|---|---|
| ANTI_NARRATION on | 3/3 | 0.00 (0.00–0.00) | 0 | 0 | 16 | 2590 | $0.575 |
| ANTI_NARRATION=0 | 3/3 | 0.00 (0.00–0.10) | 0 | 0 | 11 | 1942 | $0.502 |
| on + carve-out | 3/3 | 0.00 (0.00–0.00) | 0 | 0 | 16 | 2542 | $0.594 |

updates per tool call: OVERLAP → ANTI_NARRATION stays as it is
carve-out vs ON (exploratory): OVERLAP

sample progress updates:
- "I've identified the real call sites—format.js, badge.js, checkout.js, invoice.js, and summary.js—while filtering out lookalikes like formatCurrencyLabel and unr"
- "I've identified the real call sites—format.js, badge.js, checkout.js, invoice.js, and summary.js—while filtering out lookalikes like formatCurrencyLabel and unr"
