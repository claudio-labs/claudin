---
name: claudin -c hijacks the session you are working in
description: Verifying multi-turn behavior with `claudin -c -p` resumes the CURRENT project session, replaying your own transcript — always use an isolated cwd
type: feedback
---

`node dist/cli.mjs -c -p "..."` resumes the most recent session **for the current
working directory**, which during a coding session is the session you are
running inside. The run replays your own conversation and emits a reply as if it
were you, so its output looks like your own summary text and lands in your
transcript. Observed 2026-07-26: the run also hung ~300s and the task-list dir
under test disappeared.

**Why:** headless resume is keyed by project dir, not by anything that
distinguishes "the agent driving the test" from "the agent under test".

**How to apply:** to verify any multi-turn runtime behavior, run both turns in a
throwaway cwd (`mkdir /tmp/check && cd /tmp/check`, fixture files inside, invoke
the bundle by absolute path). One-shot `-p` in the repo is safe; `-c`/`--resume`
in the repo is not. If a `-c` run produces text that reads like your own voice,
it is replay — do not treat it as a result.
