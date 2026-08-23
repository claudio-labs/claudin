// Real captured command output for the JS package-runner filters
// (bun run / next / biome / oxlint / turbo / nx).
//
// Named for the filter family it serves, matching `filters/js-pkg.ts` — every
// spec whose sample lives here is imported from that module in
// `filters/index.ts`, biome and oxlint included despite the linter-ish names.
//
// NOT a `.test` file — pure data.

import { readSample } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

/**
 * source: recorded session corpus, `bun run smoke` — 9 lines, 579 chars.
 *
 * Two `$ ` echo lines because the script nests (`smoke` shells out to `build`),
 * which is the shape the strip exists for.
 */
export const BUN_RUN_SMOKE = readSample("bun-run-smoke.txt");

/** The KNOWN GAP: a script whose OWN output contains a `$ ` line. The second one
 * here is printed BY the script, not echoed by bun, and is stripped all the
 * same — the stages are stateless per line, so "only at the top" cannot be
 * expressed. Pinned so the behaviour is a decision, not a surprise. */
export const BUN_RUN_ECHOING_SCRIPT = `$ node scripts/deploy.js
preparing release 1.2.3
$ rsync -a dist/ server:/srv/app
uploaded 412 files
`;

// ─────────────── next / biome / oxlint / turbo / nx ────────────────────────
//
// Same provenance convention as the sample modules beside this one: every
// const carries a `// source:` pointer, rtk fixture or public capture.

// source: Next.js 14 production-build console output (vercel/next.js docs +
// the standard App-Router build summary). Clean build → collapses.
export const NEXT_BUILD_OK = `   ▲ Next.js 14.2.3

   Creating an optimized production build ...
 ✓ Compiled successfully
 ✓ Linting and checking validity of types
 ✓ Collecting page data
 ✓ Generating static pages (5/5)
 ✓ Collecting build traces
 ✓ Finalizing page optimization

Route (app)                              Size     First Load JS
┌ ○ /                                    5.3 kB         92.4 kB
└ ○ /about                               1.2 kB         88.3 kB
+ First Load JS shared by all            87.1 kB

○  (Static)  prerendered as static content
`;

// source: nrwl/nx#14558 — verbatim Next.js App-Router type-check failure
// (compile passes, type-check fails → "Failed to compile." + "Type error:").
export const NEXT_TYPE_ERR = `   ▲ Next.js 14.1.0

   Creating an optimized production build ...
 ✓ Compiled successfully
   Linting and checking validity of types  ...Failed to compile.

./app/page.tsx:12:5
Type error: Cannot find module '../../../../app/layout' or its corresponding type declarations.
`;

// source: vercel/next.js#72986 — verbatim Next.js 15 webpack build failure.
export const NEXT_WEBPACK_ERR = `   ▲ Next.js 15.0.3

   Creating an optimized production build ...
Failed to compile.

./app/page.tsx + 1 modules
Unexpected end of JSON input

> Build failed because of webpack errors
`;

// source: ../rtk/src/filters/biome.toml [[tests.biome]]
export const BIOME_DIRTY = `Checked 42 files in 0.5s

src/app.tsx:5:3 lint/suspicious/noExplicitAny ━━━━━━━━━━━━━━━━━━━━
  × Unexpected any. Specify a different type.
  3 │ interface Props {
  4 │   data: any;
  5 │         ^^^

src/utils.ts:12:1 lint/complexity/noForEach ━━━━━━━━━━━━━━━━━━━━
  × Prefer for...of instead of forEach.
 12 │ items.forEach(item => process(item));
    │ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Found 2 errors.
`;

// source: ../rtk/src/filters/biome.toml [[tests.biome]] "clean check"
export const BIOME_CLEAN = `Checked 42 files in 0.3s
`;

// source: ../rtk/src/filters/oxlint.toml [[tests.oxlint]]
export const OXLINT_DIRTY = `  × eslint(no-console): Unexpected console statement.
   ╭─[src/app.ts:5:3]
 5 │   console.log("debug");
   │   ^^^^^^^^^^^
   ╰────

  × eslint(no-unused-vars): 'x' is defined but never used.
   ╭─[src/utils.ts:2:7]
 2 │   let x = 42;
   │       ^
   ╰────

Found 2 warnings on 2 files.
Finished in 12ms on 100 files.
`;

// source: ../rtk/src/filters/oxlint.toml [[tests.oxlint]] "clean output"
export const OXLINT_CLEAN = `Finished in 5ms on 100 files.
`;

// source: ../rtk/src/filters/turbo.toml [[tests.turbo]]
export const TURBO_OK = ` cache hit, replaying logs abc123
 cache miss, executing abc456

3 packages in scope

> myapp:build

Compiled successfully.

Tasks:    2 successful, 2 total (1 cached)
Duration: 3.2s`;

// source: ../rtk/src/filters/turbo.toml [[tests.turbo]] "preserves error output"
export const TURBO_ERR = `> myapp:lint

Error: src/index.ts(5,1): error TS2304

Tasks:    0 successful, 1 total
Duration: 1.1s`;

// source: ../rtk/src/filters/turbo.toml [[tests.turbo]] "empty after stripping"
export const TURBO_CACHED = ` cache hit, replaying logs abc

`;

// source: ../rtk/src/filters/nx.toml [[tests.nx]]
export const NX_OK = `
   > NX   Running target build for project myapp

———————————————————————————————————————
Compiled successfully.
Output: dist/apps/myapp

   > NX   View logs at /tmp/.nx/runs/abc123

   Nx (powered by computation caching)
`;

// source: ../rtk/src/filters/nx.toml [[tests.nx]] "preserves error output"
export const NX_ERR = `ERROR: Cannot find module '@myapp/shared'

   > NX   Running target build for project myapp

Failed at step: build`;
