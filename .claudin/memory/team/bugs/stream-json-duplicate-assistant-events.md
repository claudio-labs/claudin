---
name: stream-json-duplicate-assistant-events
description: claudin -p --output-format stream-json --verbose prints every assistant event twice (same uuid); Claude Code prints it once — benches that count blocks must dedupe by uuid
type: project
---

**Symptom.** `claudin -p … --output-format stream-json --verbose` writes each
`{"type":"assistant"}` event **twice**, byte-identical, with the same `uuid`.
For a one-reply turn the output is `system:init, assistant, rate_limit_event,
assistant, result`. Claude Code 2.1.280 on the same mock prints `system:init,
assistant, rate_limit_event, result`. Every SDK or stream-json consumer sees
each assistant message twice.

**Found** 2026-09-23 by `scripts/bench/ab/narration-updates-ab.ts`, whose first
run counted every content block twice: 14 events, 7 distinct blocks, each one
exactly twice. The script now dedupes by `uuid`. `cliUsage.timelineFrom` (by
message id) and three-cli-ab's `lanesFrom` (by tool id) already deduped, which
is why the older benches never showed it.

**Reproduce** with no real API calls. Point both CLIs at a local mock that
answers one text reply (`ANTHROPIC_BASE_URL`). Then run
`-p hi --output-format stream-json --verbose --no-session-persistence` and
count `assistant` lines per `uuid`.

**Status 2026-09-23:** not investigated, not fixed — out of scope for the
beta round. The duplicate lands after `rate_limit_event`, which points at the
headless print loop re-emitting the last message, but that is unconfirmed.
