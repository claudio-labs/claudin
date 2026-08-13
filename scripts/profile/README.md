# Performance profile harness

Reproducible benchmarks for the user-perceived hot paths in claudin. Three
dimensions of latency are covered today; each one writes a JSON baseline to
`baselines/` so changes can be A/B compared with real numbers.

## Why this exists

Repeated rounds of "perf optimization" by code inspection were debunked
because nobody had measured. This harness produces numbers, so future
proposals can be validated empirically before being implemented.

## TL;DR — what was found

```
COLD START          (every launch)                                ~525 ms direct
  • paid every time `claudin` is invoked
  • biggest absolute number of any path measured
  • dominated by V8 parse of the 21 MB bundle, not Node boot
  • bin/claudin enables NODE_COMPILE_CACHE → ~282 ms warm (−243 ms)

STREAMING RENDER    (per code block in assistant output)         ~27–40 ms
  • ~85% of the work is cli-highlight re-tokenizing the growing fence
  • defer-fence cuts cumulative work by ~85% (8× speedup, measured)
  • per-snapshot cost is sub-frame — user does not perceive a hitch
  • the win is CPU/battery, not visible smoothness
  • UX trade-off: plain monospace mid-stream, color flash on fence close
  • on by default; opt out via CLAUDIN_DEFER_HIGHLIGHT=0

INPUT LATENCY       (per keystroke, even at 10 KB buffer)        <0.5 ms
  • not the bottleneck; well under one frame

MEMORY SCAN         (200 files)                                   <3 ms
TRANSCRIPT RENDER   (1000 messages, un-cached path)              ~150 ms
  • bounded — only paid on /resume + cache eviction
```

Run `bun run profile` for the unified summary.

## The benchmarks

| Script                  | What it measures                                                       | npm script              |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------- |
| `streaming-bench.ts`    | Streaming markdown render path (`marked.lexer` + `formatToken` + `cli-highlight`) | `bun run profile:streaming` |
| `input-bench.ts`        | Keystroke latency through `Cursor.fromText` + `MeasuredText` + `cursor.render` | `bun run profile:input`     |
| `cold-start-bench.ts`   | Wall time for the bundled CLI to launch + handle `--version` / `--help` and exit | `bun run profile:cold-start` |
| `memory-bench.ts`       | `scanMemoryFiles` cost across N=10/50/100/200 synthetic memory files   | `bun run profile:memory`     |
| `transcript-bench.ts`   | Un-cached `applyMarkdown` across long transcripts (50–1000 messages)   | `bun run profile:transcript` |
| `long-session-bench.ts` | Cap invariant + heap delta for module-level caches under N-cycle load (ROADMAP 5.3) | `bun run profile:long-session` |
| `cache-ab-bench.ts`     | Prompt-cache read/write ratio across a synthetic tool-loop session, claudin vs. claude-code | `bun scripts/profile/cache-ab-bench.ts` |
| `agent-bg-token-bench.ts` | End-to-end token + $ cost of the SAME sub-agent workload (orchestrator spawns N agents, each reads M files), claudin vs. claude-code | `bun scripts/profile/agent-bg-token-bench.ts` |
| `cli-search-edit-ab.ts` | Per-turn context, tokens, cache and $ for one search→edit→build task (find 5 call sites across 10 .js files, rewrite them, get the build green), claudin vs. claude-code — **graded**, so a cheap arm that skipped work is not a win | `bun scripts/profile/cli-search-edit-ab.ts` |
| `run-all.ts`            | All six back-to-back with a unified summary + verdict                  | `bun run profile`           |

### Comparing agents across CLIs (`agent-bg-token-bench.ts`)

Always **pin the model on both sides** — without `--model` each CLI follows its own
default (claudin the active `/provider` profile, claude its own setting) and the cost
column silently compares two different price tiers:

```bash
bun run scripts/profile/agent-bg-token-bench.ts --probe --model=claude-sonnet-5   # 1st: is the run fair?
bun run scripts/profile/agent-bg-token-bench.ts --agents=2 --files=10 --model=claude-sonnet-5 --reps=3
```

Two accounting traps this harness now handles, worth knowing before you read any
number it prints:

- **`usage` is parent-only, `modelUsage` is the session.** The final result's `usage`
  block counts just the orchestrator's own turns; sub-agent turns are separate API
  calls and are absent from it, which is why `total_cost_usd` can price out ~2.7x
  higher than `usage` implies. The bench prefers `modelUsage` (the whole-session
  aggregate that reconciles with `total_cost_usd`) and falls back to `usage`.
- **Cache writes are billed by TTL.** 5m costs 1.25x base input, 1h costs 2x — a
  ~1.6x spread on what is usually the largest column. `modelUsage` carries no TTL
  split, so the list-price estimate infers it from the parent's last `usage` block
  and is only a cross-check. **Trust `cost reported by the CLI`**, which knows the
  real TTL per request.

### Grading the work, not just the tokens (`cli-search-edit-ab.ts`)

`agent-bg-token-bench.ts` compares two CLIs on a workload whose *output* nobody
checks — fine there, because reading N files has no wrong answer. A
search→edit→build task does, and the cheapest way to finish it is to do less of
it, so this bench grades every run before believing its numbers:

```bash
bun scripts/profile/cli-search-edit-ab.ts --dry-run                 # 1st: is the fixture an oracle?
bun scripts/profile/cli-search-edit-ab.ts --reps=3 --json
```

The workspace is 10 plain-ESM `.js` files under `/tmp` with five call sites of
one function — one of them reached through an **aliased import**, so a grep for
`formatCurrency(` misses it — plus three decoys (a lookalike identifier, a
comment, a string event name) that a blind global replace destroys. Because the
call sites are ESM *named* imports, a missed one fails `bun build` with "No
matching export": the bundler, not the harness, is the oracle. `--dry-run`
proves that end of it (pristine builds, a missed site goes red, a blind
`s///g` stays green but trips the decoys) before any model token is spent.

Read the output in this order: **task passed** first, then the token table. A
delta between arms that did not both pass is comparing different amounts of
work. Arm order alternates per rep so the cold prompt cache does not land on
the same arm every time, and at `--reps>=3` the summary prints the cost
**ranges** — overlapping ranges mean there is no cost claim to make, however
clean the median looks.

### Investigation-only scripts

These were written during the 2026-06-07 cache-ratio investigation (which
shipped as the defer-cache-marker default in `paramBuilders.ts`). They are
**not** part of `bun run profile` and have no npm script. Kept in-tree so
future regressions can be diagnosed without re-deriving the toolkit:

| Script                       | Use case |
| ---------------------------- | -------- |
| `dump-system-prompt.ts`      | Dump the main-session **and** sub-agent system prompts as plain text, for diffing against Claude Code's. The default mode renders from source with every `feature()` folded **off** (~800 tokens of shipped steering missing); `--flags=ship` shells out to the built `dist/cli.mjs` for what the binary actually sends. Every dump carries a provenance header — never quote one without it |
| `prefix-anatomy.ts`          | Break down the request prefix into system / tools / messages with token estimates per segment |
| `eager-tools.ts`             | Estimate which tools could be lazy-loaded to shrink the static prefix |
| `subagent-cost-bench.ts`     | Per-turn token + $ accounting for a fan-out of sub-agents, to validate fork-vs-fresh cost claims |
| `wire-diff.ts`               | Side-by-side wire dump (claudin vs. claude-code) for the same prompt — used to confirm prompt parity before benching cache behavior. **BROKEN since claude 2.1.220 / claudin 1.0.16**: both CLIs hang before their first API call because of the injected mock `ANTHROPIC_API_KEY`, so 0 requests reach the mock. See the header comment for the repro |

## Usage

```bash
# Unified summary (recommended starting point)
bun run profile

# Individual benchmarks
bun run profile:streaming      # streaming-bench --compare (FORCE_COLOR=3 set internally)
bun run profile:input
bun run profile:cold-start     # requires `bun run build` first

# Direct invocations with flags
bun run scripts/profile/streaming-bench.ts --help
bun run scripts/profile/streaming-bench.ts --compare --fixture=py50
bun run scripts/profile/input-bench.ts --sizes=100,1000,10000 --iters=1000
bun run scripts/profile/cold-start-bench.ts --runs=20

# Machine-readable
bun run profile --json > /tmp/before.json

# CPU profile (Bun → Chrome DevTools)
bun --cpu-prof scripts/profile/streaming-bench.ts --runs=20
# → cpu-*.cpuprofile, open in Chrome DevTools › Performance
```

## Streaming bench

Drives a deterministic line-by-line streaming sequence through the actual
production code path (minus React/Ink reconciliation). Three strategies:

| Strategy      | What it does                                                                |
| ------------- | --------------------------------------------------------------------------- |
| `status-quo`  | Highlight every snapshot, every code token (current production code)        |
| `defer-fence` | Skip highlight while a fence is open; final pass once it closes             |
| `lru-text`    | LRU cache keyed by `(lang, hash(text))` — verifies the round-3 hit-rate claim |

Three fixtures: `ts50`, `py50` (typical 50-line code blocks), `prose` (no
code, control case).

Baseline (FORCE_COLOR=3, 10 runs after 3 warmup, **memoization modeled** —
see "What this measures" below):

```
ts50 (1578 chars, 58 snapshots):
  status-quo   27.2 ms  56 hl calls  43 KB chars highlighted
  defer-fence   3.4 ms   3 hl calls   4 KB chars highlighted   (8.0× faster)
  lru-text     23.8 ms  53 hl calls  38 KB chars highlighted   (1.1×, 5.4% hit rate)

py50 (1225 chars, 46 snapshots):
  status-quo   40.1 ms  44 hl calls
  defer-fence   5.1 ms   3 hl calls                             (7.9× faster)

prose (no code):  ~3 ms in all strategies
```

### What this measures

The harness simulates `StreamingMarkdown` (`src/components/Markdown.tsx:186-235`):
on every line-buffered snapshot it lexes only the unstable suffix and renders
both `<Markdown>{stablePrefix}</Markdown>` + `<Markdown>{unstableSuffix}</Markdown>`.
By default it **models the React Compiler memoization** that
`MarkdownBody` (`Markdown.tsx:133`) gets in production: when `stablePrefix`
doesn't change between snapshots, the cached output is reused (zero
`formatToken` work). Pass `--no-memo` to disable this and recover the
un-memoized harness behavior.

Memoization saves a small amount (~10%) in this fixture because the
expensive work — re-highlighting the growing unstable code block on every
line — happens regardless of memoization. The unstable suffix changes every
snapshot, so it's re-rendered every snapshot in both modes. What
memoization actually saves is the redundant `marked.lexer` + `formatToken`
traversal of the prose `stablePrefix`, which has no code tokens to
highlight.

### Interpretation

- Streaming render is dominated by syntax highlighting (~85–95% of total
  time, depending on memoization mode).
- 28× redundant work: 1.5 KB of source produces 43 KB of cumulative
  highlight work because each line re-highlights the entire growing block.
- **Per-snapshot p95 is ~0.9–1.7 ms — well under Ink's 16 ms throttle, so
  no frame is dropped.** The win is cumulative CPU/battery savings over a
  streaming session, not a visible hitch the user perceives as "smoother".
- `lru-text` confirms the round-3 prediction: 5–7% hit rate. Caching by
  full text doesn't work when text grows monotonically.
- `defer-fence` cuts cumulative highlight work by ~85%. Real-world per-block
  saving: ~24 ms (ts50) / ~35 ms (py50). For a session with 10 code blocks,
  that's ~240–350 ms of CPU saved over the session, not a felt latency win.
- **UX trade-off**: with defer-fence on, the user sees plain monospace code
  during streaming and a one-shot color flash when the fence closes.
- The defer-fence path is the production default. Set
  `CLAUDIN_DEFER_HIGHLIGHT=0` to fall back to status-quo (always-highlight).
  In this harness, `--strategy=status-quo` reproduces the opt-out behavior
  and `--strategy=defer-fence` reproduces the default — production code
  matches the harness's measured win exactly.

## Input bench

Measures one keystroke at the end of a buffer of varying size. Each iter is a
full `Cursor.fromText` + `MeasuredText` (which calls `text.normalize('NFC')`)
+ `cursor.render(...)` (lazy `wrapAnsi` + grapheme segmentation).

Baseline:

```
buffer size  p50 ms   p95 ms   p99 ms
        100   0.01    0.01    0.01
        500   0.02    0.02    0.03
       2000   0.07    0.08    0.08
       5000   0.14    0.15    0.27
      10000   0.22    0.25    0.26
```

All sizes are well under the 16 ms frame budget. **Input is not the
bottleneck** — the round-2 finding ("memoize Cursor.fromText") would save
sub-ms and is not user-visible.

## Cold-start bench

Spawns the bundled CLI with `--version` (fast path in `cli.tsx`) and `--help`
(Commander parse + `commands.ts` registration), measures wall ms end-to-end.

Baseline:

```
invocation     p50 ms   p95 ms   max ms
--version       475      493      493
--help          682      688      688
delta          ~207                       ← lower bound for everything past
                                            the version short-circuit
```

The `--version` time is what the user pays even on the fastest possible
launch path. `--help` adds Commander parse + command-table registration but
still doesn't load tools, MCP, providers, or memory — so the real REPL
launch is _at least_ the `--help` number, almost certainly more.

This is the largest absolute number any benchmark measured. **Worth a
dedicated investigation with `node --cpu-prof` on a real launch.**

## Memory bench

Builds N synthetic memory `.md` files in `/tmp`, runs the real
`scanMemoryFiles` against them. Models the cost of `findRelevantMemories`
(once per turn) and `extractMemories` (every ~15 turns).

Baseline:

```
 files   p50 ms   p95 ms   ms/file
    10    0.21    0.42      0.021
    50    0.74    1.24      0.015
   100    1.33    1.81      0.013
   200    2.77    3.40      0.014
```

Per-file cost is flat (~0.014 ms/file). Even a heavy user with 200 memory
files pays <3 ms per scan. **Not a bottleneck** — the round-1 finding
("scanMemoryFiles concurrency cap") was correctly debunked; on modern SSDs
the readdir+frontmatter-parse cost is invisible.

## Transcript bench

Drives `applyMarkdown` across N synthetic messages of mixed shape
(headings, lists, tables, prose, plus optional `--with-code` for
TypeScript code blocks every 5th message). Measures the cost of the
un-cached path that fires on `/resume` first paint or when scrolling back
past `Markdown.tsx`'s LRU(500) tokenCache.

Baseline (`--with-code`):

```
 messages   total ms   per-msg ms
       50      10.3       0.206
      200      36.9       0.184
      500      76.8       0.154
     1000     151.2       0.151
```

Per-message cost is ~0.15 ms; a 1000-message transcript pays ~150 ms once
on cold paint. Bounded and one-time. **Not a bottleneck**, but a useful
canary if someone changes `applyMarkdown` and accidentally regresses
per-message cost.

## Long-session bench

Drives the five module-level caches that grow per-turn / per-tool-call /
per-LSP-publication with N distinct entries each, and measures: declared
cap vs observed size, total heap delta, per-cycle heap delta. Companion
to `src/utils/cacheBoundsInvariants.test.ts` — that test runs in CI to
catch a future regression dropping the eviction call; this bench produces
the numbers for the baseline.

Caches covered: `Markdown.tokenCache` (LRU 500), `queryHelpers.toolProgressLastSentTime`
(FIFO 100), `imageStore.storedImagePaths` (FIFO 200),
`LSPDiagnosticRegistry.deliveredDiagnostics` (LRU 500), `fileReadCache` (FIFO 1000).

Requires `--expose-gc` for honest heap deltas — the npm script sets it.

Two modes; default `--mode=both` runs both:

**Isolated mode** — feed each cache N=10000 distinct entries, one cache at
a time. Confirms each cap independently. Baseline:

```
fileReadCache                                   1000   1000    3.4 MB  357 B/cycle  175 ms
Markdown.tokenCache                              500    500    1.2 MB  123 B/cycle  294 ms
queryHelpers.toolProgressLastSentTime            100    100   75.2 KB    8 B/cycle    8 ms
imageStore.storedImagePaths                      200    200  113.1 KB   12 B/cycle   13 ms
LSPDiagnosticRegistry.deliveredDiagnostics       500    500  510.8 KB   52 B/cycle   17 ms

total heap delta: 5.3 MB across all five caches at 10k cycles each
```

**Mixed-session mode** (`--mode=mixed --turns=2000`) — closest thing to a
real Claudin session on a large project. Each turn interleaves: 5 file
reads, 3 markdown renders, 2 LSP diagnostics, 2 tool progress events,
+1 image every 50 turns. Snapshots heap every 10% of turns to surface
the *growth curve*, not just start vs end. Saturation check passes if
heap delta in the second half stays within 5% of the midpoint value
(plateau, not monotonic growth). Baseline (2000 turns ≈ multi-hour session):

```
turns: 2000
workload: 10000 file reads, 6000 markdown renders, 4000 LSP diagnostics,
          4000 tool progress events, 40 images
final heap delta: ~2 MB total (within GC noise)
saturation: PASS — every cache plateaus by turn ~200 and stays flat
```

What this confirms: every cache plateaus at its declared cap. After
saturation (~10% of turns in mixed-session), heap stops growing entirely.
The OOM @ 4 GB originally hypothesized for 5.3 cannot come from these
caches; it was mitigated by the heap-pressure trigger + 8 GB bump in 5.0.

**Not covered**: `auth.ts pending401Handlers` (uses `finally { delete }`
self-cleanup; verified by inspection at `src/utils/auth.ts:1383-1390`).
Other module-level Maps in 179 files are reachable through the discovery
pattern in this bench if a future regression appears — the systematic
sweep is documented in `~/.claudin/plans/immutable-jingling-hare.md`.

## Caveats

- **React/Ink reconciliation** is not measured here. Worth a separate harness
  if someone wants to verify there's no re-render storm, but unlikely to
  dwarf the numbers above.
- **Terminal redraw cost** of writing N more KB of ANSI codes to the screen
  (status-quo emits ~19 KB extra ANSI vs defer-fence per ts50 run). On a
  slow terminal this could add user-visible cost; not measured here.
- **Network/model TTFB.** Streaming chunks arrive at whatever rate the
  provider produces them; the streaming bench assumes the per-line snapshot
  rate is the correct unit (matches `REPL.tsx:1506`'s line-buffered display).
- **Cold-start bench measures the bundled binary**, so it includes Bun's TS
  source loader cost when run via `bun run`. We use `node` to spawn for
  consistency. `dist/cli.mjs` must exist (run `bun run build` first).

## Comparing changes

```bash
# Capture before
bun run profile --json > /tmp/before.json

# Make your change

# Capture after
bun run profile --json > /tmp/after.json

# Eyeball the diff
diff <(jq '.streaming.ts50.results[].summary.median.totalMs' /tmp/before.json) \
     <(jq '.streaming.ts50.results[].summary.median.totalMs' /tmp/after.json)
```

The committed `baselines/*.json` are reference points — overwrite them when
production behavior changes meaningfully so future contributors see the
post-change numbers.

## Adding a new benchmark

Pattern is the same:

1. Read the production code path you want to measure.
2. Drive it with deterministic input that mirrors the real call shape.
3. Use `performance.now()` around the unit of work, run N+warmup iterations.
4. Emit human + JSON output controlled by a `--json` flag.
5. Wire it into `run-all.ts`, the npm scripts in `package.json`, and the
   table at the top of this README.
6. Save a baseline in `baselines/`.
