# `bun build --compile` evaluation (declined)

Date: 2026-06-03  
Branch: `perf/cold-start-waves` (cold-start optimization series)

## TL;DR

Tested `bun build --compile` and `--compile --bytecode` as a faster
distribution channel for `claudin`. **Both are slower than `node dist/cli.mjs`**
on our workload. Declining the change. Postinstall v8cache warmup (the
preceding wave) already covers the "first-launch is cold" UX gap with no
distribution overhead.

## Hypothesis going in

The `WebResearcher` agent (see `valiant-chasing-cerf.md`, wave 5) suggested
`bun build --compile --bytecode` should deliver cold start <200 ms by
serializing JSC bytecode into the executable, bypassing both module parsing
and the V8 compile-cache populate cost on first launch.

## Methodology

Built two single-executable binaries from the existing `dist/cli.mjs`
bundle (the bundle already has all dynamic imports pre-resolved to chunk
files; bun rebundles them into the binary):

```bash
# Plain compile
bun build --compile --target=bun-linux-x64 \
  --external='@aws-sdk/*' \
  --external='google-auth-library' \
  --external='@anthropic-ai/{bedrock,vertex,foundry}-sdk' \
  --external='sharp' \
  --outfile=dist/compiled/claudin-linux-x64 dist/cli.mjs

# Compile + bytecode
bun build --compile --bytecode --target=bun-linux-x64 \
  ...same externals... \
  --outfile=dist/compiled/claudin-bytecode dist/cli.mjs
```

Without the `--external` list, bun refuses to compile: it tries to
statically resolve `import('@aws-sdk/client-bedrock')` calls inside our
provider code (Bedrock and Vertex are lazy because they only load when the
user picks that provider). Marking them external keeps the compile happy;
the calls remain `await import(...)` against the installed `node_modules`.
That, of course, means the compiled binary still needs a `node_modules`
sitting next to it at runtime for those providers — which kills the "ship
one self-contained executable" pitch.

## Numbers

Measured on Linux x86_64, 5 cold runs each, taking median:

| Path | `--version` | `--help` | Binary size |
|---|---:|---:|---:|
| `node dist/cli.mjs` (fast-path) | **25 ms** | 522 ms | n/a |
| `bin/claudin --help` warmed v8cache | n/a | **433 ms** | n/a |
| `bun --compile` binary | 366 ms | 555 ms | **114 MB** |
| `bun --compile --bytecode` binary | 384 ms | 600 ms | **218 MB** |

Bytecode made things *worse*, not better.

## Why bun --compile lost

A few effects compound here, in rough order of impact:

1. **The `--version` fast-path is Node-specific.** `src/entrypoints/cli.tsx`
   checks `process.argv[2] === '--version'` and `process.exit()`s before any
   real import. On `node`, that path completes in ~25 ms because v8's
   startup-snapshot machinery is heavily optimized for the CLI use case.
   The bun-produced binary instead boots the entire JSC + bun runtime first
   (which takes 200–300 ms by itself), so the fast-path can't even fire
   until we're already past the cost the binary was supposed to save.
2. **JSC's startup vs V8's startup.** JSC is great in steady-state but
   noticeably slower at "spin up an isolate, run a few thousand lines of
   top-level code, exit". V8's startup snapshot ships warm intrinsics that
   Bun's compiled binary still has to materialize.
3. **218 MB of mmap-ed binary.** The bytecode binary doubles in size
   because it stores both the source and the serialized JSC bytecode. On a
   fresh launch the kernel has to populate the page cache for the entire
   read region the loader touches — that's not free at 218 MB.
4. **`--external` defeats the value prop.** We can't actually ship a
   self-contained binary because `@aws-sdk/*`, `google-auth-library`, and
   `sharp` have to stay external to make compile succeed. The user would
   still need `npm install` to run the binary, so there's no distribution
   simplification either.

## Decision

**Skip.** No measurable win, large size cost, broken self-containment
promise, separate per-arch CI matrix needed.

Postinstall v8cache warmup (committed in the wave preceding this one)
already gives the "first launch is fast" UX without any of these
tradeoffs: −138 ms on first launch, 3 MB of cache per user, zero
distribution changes.

## Re-evaluate when

- Bun's compiled-binary startup itself drops below ~50 ms (currently
  ~250 ms just for the runtime).
- Bun adds a `--node-compat-fast-startup` mode that snapshots the way
  Node's `--build-snapshot` does.
- We need to ship to an environment without Node (e.g. distroless / minimal
  containers). Today every claudin target ships with Node available.

## Reproduce

```bash
cd /path/to/claudin
bun run build
mkdir -p dist/compiled
bun build --compile --bytecode --target=bun-linux-x64 \
  --external='@aws-sdk/*' --external='google-auth-library' \
  --external='@anthropic-ai/bedrock-sdk' --external='@anthropic-ai/vertex-sdk' \
  --external='@anthropic-ai/foundry-sdk' --external='sharp' \
  --outfile=dist/compiled/test dist/cli.mjs
for i in 1 2 3 4 5; do
  S=$(date +%s%N); ./dist/compiled/test --help > /dev/null; E=$(date +%s%N)
  echo "$(( (E-S)/1000000 )) ms"
done
```
