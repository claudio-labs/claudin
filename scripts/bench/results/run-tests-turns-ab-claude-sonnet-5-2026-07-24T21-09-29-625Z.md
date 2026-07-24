# Bench A/B — RunTests tool over a 15-turn session (with-tool vs Bash-only)

- Timestamp: 2026-07-24T21:09:29.625Z
- Model: `claude-sonnet-5`
- Bench: `scripts/bench/run-tests-turns-ab.ts`
- Turns per arm: 15 (one resumed session per arm)
- Scenarios cycled across turns: `[pass, pass, pass, fail, fail, fail]` (3 passing + 3 failing bun-test fixtures, one test file rewritten before each turn; cwd fixed)
- Arms:
  - **A — with-tool**: `--allowedTools RunTests --disallowedTools Bash` → model runs the suite through the RunTests tool.
  - **B — no-tool (Bash)**: `--allowedTools Bash --disallowedTools RunTests` → RunTests hidden, model runs `bun test` via Bash.
- KPIs: cache read, cache write (creation), total tokens, cost.

## Per-turn — Arm A (with RunTests)

| Turn | Scen | cacheRead | cacheWrite | inTok | outTok | totalTok | cost $ | time |
|---:|:--|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS | 19,253 | 19,253 | 71 | 73 | 38,650 | 0.1226 | 6.5s |
| 2 | PASS | 33,515 | 429 | 4,878 | 49 | 38,871 | 0.0280 | 5.7s |
| 3 | PASS | 33,944 | 0 | 5,084 | 49 | 39,077 | 0.0262 | 3.6s |
| 4 | FAIL | 34,044 | 230 | 5,053 | 133 | 39,460 | 0.0287 | 4.4s |
| 5 | FAIL | 34,654 | 355 | 4,876 | 113 | 39,998 | 0.0288 | 4.5s |
| 6 | FAIL | 35,170 | 260 | 4,975 | 113 | 40,518 | 0.0287 | 6.2s |
| 7 | PASS | 35,690 | 174 | 4,968 | 106 | 40,938 | 0.0282 | 5.3s |
| 8 | PASS | 36,068 | 86 | 4,996 | 49 | 41,199 | 0.0271 | 4.0s |
| 9 | PASS | 36,181 | 81 | 5,138 | 178 | 41,578 | 0.0294 | 6.8s |
| 10 | FAIL | 36,524 | 413 | 4,976 | 169 | 42,082 | 0.0309 | 5.5s |
| 11 | FAIL | 37,316 | 316 | 4,913 | 154 | 42,699 | 0.0301 | 4.7s |
| 12 | FAIL | 37,948 | 301 | 4,898 | 145 | 43,292 | 0.0301 | 5.9s |
| 13 | PASS | 38,550 | 174 | 4,914 | 200 | 43,838 | 0.0304 | 6.1s |
| 14 | PASS | 39,096 | 372 | 4,678 | 110 | 44,256 | 0.0296 | 4.5s |
| 15 | PASS | 39,468 | 0 | 5,006 | 49 | 44,523 | 0.0276 | 4.4s |

## Per-turn — Arm B (Bash-only)

| Turn | Scen | cacheRead | cacheWrite | inTok | outTok | totalTok | cost $ | time |
|---:|:--|---:|---:|---:|---:|---:|---:|---:|
| 1 | PASS | 98,568 | 8,817 | 3,093 | 601 | 111,079 | 0.1008 | 11.7s |
| 2 | PASS | 39,382 | 6,022 | 139 | 148 | 45,691 | 0.0506 | 4.9s |
| 3 | PASS | 39,591 | 6,231 | 139 | 129 | 46,090 | 0.0516 | 4.1s |
| 4 | FAIL | 40,024 | 6,664 | 377 | 225 | 47,290 | 0.0565 | 8.6s |
| 5 | FAIL | 40,526 | 7,166 | 337 | 179 | 48,208 | 0.0588 | 4.9s |
| 6 | FAIL | 40,983 | 7,623 | 337 | 179 | 49,122 | 0.0617 | 4.9s |
| 7 | PASS | 114,824 | 7,856 | 4,117 | 1,839 | 128,636 | 0.1215 | 26.8s |
| 8 | PASS | 70,594 | 10,277 | 806 | 530 | 82,207 | 0.0932 | 10.7s |
| 9 | PASS | 44,445 | 11,085 | 438 | 315 | 56,283 | 0.0859 | 6.4s |
| 10 | FAIL | 45,210 | 11,850 | 929 | 784 | 58,773 | 0.0992 | 15.2s |
| 11 | FAIL | 46,857 | 13,497 | 696 | 466 | 61,516 | 0.1041 | 7.7s |
| 12 | FAIL | 47,774 | 14,414 | 692 | 457 | 63,337 | 0.1097 | 8.5s |
| 13 | PASS | 48,457 | 15,097 | 475 | 439 | 64,468 | 0.1131 | 7.9s |
| 14 | PASS | 48,709 | 15,349 | 395 | 271 | 64,724 | 0.1120 | 5.3s |
| 15 | PASS | 49,206 | 15,846 | 395 | 273 | 65,720 | 0.1151 | 7.3s |

## Arm totals

| Arm | Label | Turns | cacheRead | cacheWrite | totalTok | cost $ | Tools |
|:--|:--|---:|---:|---:|---:|---:|:--|
| A | with-tool (RunTests) | 15 | 527,421 | 22,444 | 620,979 | 0.5265 | `RunTests×15` |
| B | no-tool (Bash) | 15 | 815,150 | 157,794 | 993,144 | 1.3339 | `Bash×20 Read×4` |

## Delta (A with-tool relative to B Bash-only)

| Metric | A | B | Δ |
|:--|---:|---:|---:|
| cache read | 527,421 | 815,150 | **−35.3%** |
| cache write | 22,444 | 157,794 | **−85.8%** |
| total tokens | 620,979 | 993,144 | **−37.5%** |
| cost | $0.5265 | $1.3339 | **−60.5%** |

Bench spend: ~$1.86 total.

## Analysis

- **The RunTests tool is ~60% cheaper per session** than running the same suites via
  Bash, at ~37% fewer total tokens. The dominant driver is **cache write: −85.8%**.
- **Why:** Bash re-caches the raw, noisy `bun test` stdout every turn (157k cache
  creation, plus re-creation spikes at turns 7–9 when the 5m cache tier expires and
  the large output is re-written). RunTests returns only the compact failures-first
  summary, so its cache write stays near-zero after the first turn (0–430 tok/turn)
  and per-turn cost stabilizes at ~$0.028 vs Bash's ~$0.05–0.12.
- **Steady-state per turn (turns 2–15):** A ≈ 39k–44k totalTok / ~$0.028–0.031;
  B ≈ 46k–129k totalTok / ~$0.05–0.12 (noisier, output-token heavy because the model
  narrates parsed Bash output).
- **Arm hygiene:** A used `RunTests` exactly once per turn (15/15, zero Bash — the
  `--disallowedTools Bash` held); B never reached RunTests (disallowed) and fell back
  to `bun test` via Bash (20 calls) + 4 Reads. Both arms exercised the same
  3-pass/3-fail scenario cycle.

## Reproduce

```bash
bun run build
bun run scripts/bench/run-tests-turns-ab.ts --turns=15 --model=claude-sonnet-5
# single-turn 3-pass/3-fail validation variant:
bun run scripts/bench/run-tests-ab.ts --runs=3
```

Note: single-run numbers are noisy (see the turn-1 and turn-7 cache spikes in arm B);
treat the arm totals and the −60% cost delta as the headline, not any single turn.
