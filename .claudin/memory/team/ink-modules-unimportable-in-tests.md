---
name: Importing ink.js pulls the build-stubbed analytics module — unimportable under bun test
description: Any module that transitively imports ../ink.js fails to load under bun test / bun -e; extract pure logic to test it
type: project
---

A `bun test` (or `bun -e`) import of any module whose import chain reaches `src/ink.js` fails with `Cannot find module '@growthbook/growthbook' from '.../services/analytics/growthbook.ts'`.

**Why:** `ink.js` transitively imports `services/analytics/growthbook.ts`, which imports `@growthbook/growthbook`. That package is NOT in node_modules — it only exists as a build-time stub injected by `scripts/no-telemetry-plugin.ts`. Outside the bundler (test runner, `bun -e`) the stub never applies, so the real import is unresolvable. This is why React/ink component `.tsx` files generally can't be imported by a colocated unit test.

**How to apply:** put non-trivial pure logic (tree building, parsing, formatting, selection math) in a separate module that imports ONLY libs + type-only imports + other pure modules — NOT `../ink.js`, React components, or hooks that reach ink. Re-export it from the `.tsx` for the component to consume. Example: `src/components/diff/fileTree.ts` (buildTreeRows) was split out of `DiffFileList.tsx` precisely so `fileTree.test.ts` could load it; `collapse.ts`/`collapse.test.ts` follow the same split. If you must test something that touches ink, mock the analytics module first (see bun-mock-module cross-file-leak caveat).
