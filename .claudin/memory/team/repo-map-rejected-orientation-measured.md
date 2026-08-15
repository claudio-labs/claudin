---
name: repo-map-rejected-orientation-measured
description: Porting an aider-style repo map (and generating a navigation rule from transcripts) was rejected on measured data 2026-08-07 — orientation is real but almost none of it is *locating*; the shipped answer was rule-upkeep instead
type: project
---

Two related proposals were measured and settled on 2026-08-07: porting
openclaude's aider-style `repoMap`, and generating a `search-strategy.md` from
session history. **Both rejected as content generators.** What shipped instead
is rule *upkeep* — see `src/memory/instructions/rulesLint.ts`, `/doctor`, `/refresh-rules`.

**Why:** measured over 503 local transcripts (257 with main-thread tool calls,
21.4M tool_result chars):

- Orientation is real in *time* — median 20 tool calls and 49.3k chars before
  the first `Edit`, 32.3% of all tool_result chars aggregate.
- But almost none of it is *locating*: within that prefix, Read is 64.6% and
  **Glob is 0.3%**. Discovery-shaped calls (Glob, Grep `files_with_matches`/
  `symbols`, Read `outline`, `ls`/`find`) are **2.14% of all chars**; the
  absolute ceiling, assuming a map displaced every Grep too, is 5.4%.
- No static artifact can reach the tail: **59.5%** of the 462 distinct paths
  read during orientation appear in exactly one session. Leave-one-out, a
  static top-50 list covers 33.4% of orientation reads (~623 tokens), top-200
  covers 61.1% (~2.5k tokens) — against a rule already costing 4,462.
- **No task→location signal.** Clustering sessions by first-message keyword
  gives top-5 sets with 0/5 overlap between clusters, which looks strong and is
  noise: the `test` cluster's top file appears in 2 of 57 sessions, and the
  `tool` cluster's five files trace to ~10 sessions of one repeated
  investigation. Zero Glob patterns repeat across sessions.

The corollary that redirects effort: the orientation prefix is dominated by
**Read (64.6%)**, which is roadmap item D3 in [[dev-tooling-token-roadmap]] —
a ~58% target versus repo map's 2%.

**How to apply:** do not re-open the repo-map port or a "generate the project
index" feature without new measurement — the numbers above are the answer, and
they were reproduced from two independent directions. Do treat rule *accuracy*
as the live problem: the audit that produced these numbers found this repo's own
`search-strategy.md` omitting `tsconfig.json` (9 sessions) and `bunfig.toml`
(7), and describing `context/` as a React-providers directory while
`src/agent/context.ts` — which holds `getSystemContext` — went unnamed. A rule that
misdirects is worse than no rule, and that class is invisible to every
mechanical check, which is why `/refresh-rules` exists alongside the linter.
