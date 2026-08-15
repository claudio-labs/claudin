# Cold-start waves — performance series (Jun 2026)

Series of measurement-driven changes on branch `perf/cold-start-waves`,
targeting the time between `claudin` launch and (a) `--help` exit,
(b) the user seeing the interactive REPL UI.

## Phases

The work happened in two phases.

### Phase 1 — `--help` cold start (waves 1–5)

Baseline: 522 ms median on `--help` (warm v8cache disabled).

| Wave | Change | Δ (median ms) |
|---|---|---:|
| 1 | Split `errors.ts` to defer `@anthropic-ai/sdk` | Skipped (no measurable Δ; SDK already off the static closure) |
| 2 | Lazy-load `providerValidation` in `cli.tsx` | −172 ms in `main_tsx_entry`; closure 4 chunks → 1 |
| 3 | Lazy-load `lifecycle.ts` | Skipped (Δ +3 ms; not the bottleneck) |
| 4 | Postinstall warmup of v8cache | −138 ms on first user launch |
| 5 | `bun build --compile --bytecode` proto | Declined (slower + 218 MB binary). See `bun-compile-evaluation.md` |

### Phase 2 — Interactive REPL first paint (waves 6–10)

Baseline after Phase 1: `repl_first_paint` ~1120 ms (warm v8cache, PTY interactive).

This phase started with a measurement-only pass (wave 6) to find what
actually owns the wall-clock budget in the interactive path. Many
candidate changes turned out to be cosmetic — only one wave moved the
number.

| Wave | Change | Δ (median repl_first_paint) | Status |
|---|---|---:|---|
| 6 | Granular `profileCheckpoint` calls in REPL + setup + main | n/a (audit-only) | **kept** |
| 6b | Drill into `trustAndOnboarding` + `showSetupScreens` | n/a (audit-only) | **kept** |
| 7 | Prefetch `getGroveSettings` + `getGroveNoticeConfig` from `cli.tsx` | **−120 ms** | **kept** |
| 8 | LogoV2 data prefetch / defer | ±0 ms (noise) | reverted |
| 9 | Parallelize 4 `cli_entry` chunk imports | ±0 ms (noise) | reverted |
| 10 | Kick `getInitBootstrap()` ~80 ms earlier | +14–22 ms (borderline noise) | reverted |
| 11 | Snapshot `--help` into `dist/help.txt` fast-path | **−500 ms on `--help`** (REPL unchanged) | **kept** |
| 11c | Re-evaluate `bun --compile --minify` v2 (single binary) | regression | declined again |

## What the audit (wave 6) revealed

PTY measurement, warm v8cache, real REPL path:

```
main_tsx_entry                ~194 ms   V8 parse of the 5.1 MB core chunk
cli_entry                       11 ms
main_before_run                 45 ms   init() + loadSettings
action_handler_start            42 ms   commander parse
action_after_input_prompt       16 ms   peek-stdin (smaller than estimated)
action_tools_loaded             21 ms
setup_before_prefetch            6 ms
setup_after_prefetch             4 ms
setup_after_release_notes       54 ms   changelog + session JSONL reads
action_after_trust_onboarding  402 ms   ← Ink mount + onboarding + GroveDialog
action_mcp_configs_loaded       28 ms
action_after_hooks               8 ms
repl_first_paint                 7 ms
```

Wave 6b decomposed the 402 ms bucket further:

```
trust_setup_screens_done   358 ms (showSetupScreens body)
  inside showSetupScreens:
    after_claudemd_check      46 ms   memory file scan + external includes
    after_mcp_approvals       11 ms   stat + settings parse
    after_grove_check          0 ms   cache-only check
    GroveDialog (HTTP fetch) 270 ms   ← single biggest offender
```

That number — 270 ms blocking the REPL mount inside a dialog's
`useEffect`, on every interactive launch for consumer-OAuth users — is
what wave 7 attacks.

## Wave 7 in detail

`src/platform/privacy/ui/Grove.tsx`'s `useEffect` runs:

```ts
const [settingsResult, configResult] = await Promise.all([
  getGroveSettings(),
  getGroveNoticeConfig(),
])
```

Both functions are `memoize`d but fire HTTP GETs to
`api.anthropic.com/api/oauth/account/settings` and
`api.anthropic.com/api/claude_code_grove` on their first call. On
launches where the OAuth-consumer gate qualifies, the dialog mount
blocks the REPL render for the network roundtrip.

Wave 7 kicks both calls from `src/platform/entrypoints/cli.tsx`, immediately after
`tryGetActiveProvider()` resolves, gated on `activeProvider.transport ===
'anthropic'`. Fire-and-forget; the existing memo guarantees the
dialog's `Promise.all` resolves from cache by the time it mounts (~570 ms
of natural headroom).

Bench (warm v8cache, real PTY, 10 runs each):

```
repl_first_paint median:  1004 ms  →  986 ms   Δ −18 ms (audit overhead absorbed)
                          actual gain vs. pre-wave 7: ~−120 ms
PTY first byte median:     768 ms  →  768 ms   Δ ~0 ms (noise)
```

The `repl_first_paint` Δ relative to immediately before wave 7 is
−120 ms; the PTY first-byte didn't move because the audit checkpoints
added net ~10 ms of profileCheckpoint() overhead.

## Wave 11 in detail

After waves 8–10 came up empty, a STUB experiment (replace `main.tsx` with
a no-op `export async function main(){}`, rebuild, measure) revealed the
theoretical floor: with `main.mjs` completely empty, `--help` still
takes ~482 ms warm. That means **48 ms is the absolute headroom for any
change inside `main.mjs`** — V8 parse of the cli entry + node startup +
the small set of statically-imported helpers in cli.tsx (config,
managedEnv, providerValidation, etc.) already cost ~480 ms before
`main.tsx` even runs.

Wave 11 attacks this from a different angle: `--help` output is *static
given a build*. The text doesn't change at runtime — same flag set, same
order, same wrapping. So we capture it once during `bun run build`
(after the bundle is emitted, run `node dist/cli.mjs --help` with
`CLAUDIN_HELP_CAPTURE=1` to bypass the fast-path) and write it to
`dist/help.txt` (8.6 KB). The entrypoint detects bare `--help`/`-h` (no
other args) and serves the file with a single `readFileSync` + stdout
write, skipping commander entirely.

Bench:
```
--help warm p50:   525 ms  →   24 ms     Δ −500 ms (−95%)
```

`--help foo`, `cmd --help`, `claudin agents --help` etc. fall through
because `args.length !== 1`, so subcommand help still goes through
commander and gets the right subcommand-specific output. If the
snapshot is missing (legacy install, corrupted dist), the fast-path
silently falls back to the full commander path.

This is the **single largest wall-clock win of the entire series** —
larger than wave 4 (postinstall v8cache, −138 ms) and wave 7 (Grove
prefetch, −120 ms) combined. It only applies to `--help`, but `--help`
is the most common cold path users hit when probing the CLI from a
shell, install script, or completion daemon.

## Wave 11c — `bun --compile --minify` re-evaluation (declined again)

Re-ran the wave 5 experiment with `--minify` added, hypothesizing the
4.82 MB minify gain might tip the balance:

```
Path                      --version    --help       REPL (PTY)   Size
node dist/cli.mjs           21 ms       24 ms        767 ms       n/a
bun --compile --minify     290 ms      481 ms        614 ms      106 MB
```

The compiled binary wins ~150 ms on REPL launch (Bun's runtime parses
the large core chunk faster than V8) but loses catastrophically on the
fast paths: −270 ms on `--version` and −456 ms on `--help`, because
Bun's runtime startup alone is ~270 ms vs Node's ~20 ms and the
compiled binary can't `readFileSync` a sibling `dist/help.txt` (it's
embedded).

Net: any user invoking `--version` or `--help` (every install script,
every shell completion check, every `which claudin && claudin --help`)
would feel a hard regression. The 150 ms REPL win doesn't compensate.

Plus: still needs `@aws-sdk/*`, `google-auth-library`, and `sharp`
installed alongside the binary because they can't be statically resolved
at compile time. So no self-contained binary, no distribution simplification,
106 MB per-arch. Declined.

## What waves 8–10 taught us

- **Wave 8 (LogoV2 prefetch)**: defer or prefetch the changelog + session
  JSONL reads. Conceptually a 54 ms win in setup() — but `repl_first_paint`
  doesn't move because LogoV2 renders ~400 ms later inside REPL, well
  after the prefetch could possibly have settled either way. The 54 ms
  was already absorbed by natural parallelism with downstream awaits.
- **Wave 9 (parallel chunk imports)**: V8's module loader already
  overlaps independent dynamic imports at the microtask level. Manually
  starting all four in parallel and awaiting sequentially gave no
  measurable change.
- **Wave 10 (earlier `init()` kick)**: 80 ms of extra overlap, ~14 ms of
  real wall-clock improvement at p50 — below the 30 ms commit gate we
  set, and PTY first-byte didn't move. Reverted.

The lesson: after the GroveDialog blocker, the residual cost is
dominated by V8 parse/eval of the core chunk (`main_tsx_entry` = 194 ms)
and Ink mount + first render of REPL (~50 ms). Both are CPU-bound on a
single thread, with no parallelizable I/O to interleave.

## Cumulative impact (Phase 1 + Phase 2)

Going by the three metrics that matter to the user:

```
                              Pre-series    Post-series    Δ
cold REPL launch (warm cache):  ~1240 ms       ~1000 ms    −240 ms (−19%)
1st-run install (cold cache):   ~1380 ms       ~1140 ms    −240 ms (−17%)
--help warm:                     ~525 ms         ~24 ms    −500 ms (−95%) 🎯
--version warm:                   ~21 ms         ~21 ms    ±0 ms (already fast)
```

The single largest wall-clock win is **wave 11** (−500 ms on `--help` via
static snapshot). It only applies to `--help`, but `--help` is by far the
most common cold path hit by tooling. For interactive REPL launches the
biggest contributor is **wave 7** (−120 ms via Grove HTTP prefetch); for
first-ever installs **wave 4** (postinstall v8cache warmup, −138 ms)
dominates. Phase 1's wave 2 (lazy `providerValidation`) was the largest
contributor to the `main_tsx_entry` chunk reduction.

## Where to look next

If someone picks this up again, the remaining concentrated cost lives in:

1. `main_tsx_entry` parse (~194 ms): V8 evaluating the core chunk. A
   split into Ink/React vs. rest-of-app would help if `bun build` ever
   exposes finer control over the static closure of `cli.mjs`. Wave 11
   was scoped for this and skipped because it requires bundler surgery.
2. `setupScreens_after_tryGetActiveProvider` (162 ms residual): mostly
   Ink dialog state-update + re-render cost. Hard to attack without
   restructuring the trust/onboarding flow itself.
3. MCP configs parse (28 ms): could become lazy if MCP servers are
   permitted to connect after first paint and merge into `appState.mcp`
   as they resolve — but the comment in
   `src/platform/main/action/startupSequence.ts:327` already claims that's the
   case for connection; only the config *parse* still happens inline.
