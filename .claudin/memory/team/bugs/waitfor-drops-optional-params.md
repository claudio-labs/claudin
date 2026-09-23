---
name: waitfor-drops-optional-params
description: WaitFor ignores until/settle_s/interval_s/timeout_s — every optional param is dropped before call(), so it always settles at the 3s default; reproduced 2026-09-22
type: project
paths: src/tools/WaitForTool/**
---

**Symptom.** Every `WaitFor` call returns `settled after ~3.1s, 4 polls`
regardless of what it was asked for. `settle_s`, `interval_s`, `timeout_s` and
`until` all behave as if absent, so the tool is a fixed 3-second, 1-second-interval
poll and cannot be used to wait for anything slower than that.

**Reproduce (3 seconds, no setup).**

```
WaitFor(command: "echo stable-output", until: "NEVER_MATCHES_XYZ", timeout_s: 8)
→ "settled after 3.1s, 4 polls"
```

That output is impossible if the input arrived: `call()` in
`src/tools/WaitForTool/WaitForTool.ts:261` branches `if (untilRe) {…} else {settle}`,
so a run carrying `until` can only end in `match`, `timeout` or `aborted` — never
`settled`. Reaching the settle arm at exactly `DEFAULT_SETTLE_S` (3) and
`DEFAULT_INTERVAL_S` (1) means `input.until`, `input.settle_s` and
`input.interval_s` were all `undefined`.

**Where it is NOT.** The source is fine and was read at 802a2f07: the schema is
a `z.strictObject` declaring all five optional fields with describes
(`WaitForTool.ts:33`), `call()` reads each with a `?? DEFAULT_*` fallback
(`:230`), and the loop honours them. There is exactly one `WaitForTool` in the
tree and one registration (`src/tools/tools.ts:253`), so it is not a stub or a
duplicate shadowing the real one. The drop is in the **input path** ahead of
`call()`, not in the tool — that is where to look, and it was not chased further.

**Status 2026-09-22: open, unfixed, found as a side effect of a bench run.** The
practical cost is that every "wait for a long job" reverts to `run_in_background`
plus the completion notification; a `sleep`-and-poll loop is refused by the Bash
redirect, so there is currently no working wait primitive for anything over ~3s.
Worth a regression test that asserts `reason === 'timeout'` for the repro above —
the existing `WaitForTool.test.ts` calls `call()` directly and therefore cannot
see this.

**Workaround that works (2026-09-23, still open):** a tiny bun script that polls
the file and sleeps inside itself — `bun wait-for-line.ts <file> <regex>
<seconds>`, a loop over `readFileSync` + `await Bun.sleep(10_000)` until the
regex matches or the deadline passes — run in the foreground with a Bash
`timeout` up to 600000. Bash accepts it (one command, no shell loop), where
`sleep N && …` is refused. Two calls waited out a ~16-minute bench run.
