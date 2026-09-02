---
name: Verifying a feature()-flag fold in the bundle requires cleaning dist/chunks first
description: dist/cli.mjs is a ~6KB loader; real code is code-split into dist/chunks/*.mjs and OLD hashed chunks are never pruned, so grepping the bundle to confirm a flag fold can match a STALE chunk — rm -rf dist/chunks before trusting the grep
type: feedback
---

`dist/cli.mjs` is NOT the bundle — it's a ~6KB / 4-line loader. The application code is code-split into content-hashed `dist/chunks/*.mjs`. Grepping `dist/cli.mjs` for app strings (`tool-result-summary`, env vars, etc.) returns 0; grep the chunks.

**Why this bites:** `bun run build` writes new content-hashed chunks but does NOT prune old ones, so `dist/chunks/` accumulates MULTIPLE compiled versions of the same module across builds. After flipping a `featureFlags` value in `scripts/build.ts` and rebuilding, a naive `grep -r dist/chunks` can match a STALE chunk from a prior build and show the OLD fold. Observed 2026-06-28: after flipping `TOOL_RESULT_JSON_COMPRESSION` false→true, the first matching chunk still compiled `isToolResultJsonCompressionEnabled` to `return!1` (the old false fold); a sibling fresh chunk had `return!0`.

**How to apply:** to verify a `feature('X')` fold (or any code change) in the bundle, first `rm -rf dist/chunks dist/cli.mjs dist/cli.mjs.map`, then `bun run build`, then grep — a clean dist has exactly ONE chunk defining the symbol. The fold is correct when the gate keeps the runtime env override before the folded default, e.g. on-by-default with opt-out reads as `if(env==="1")return!0;if(env==="0")return!1;return!0`. (dist/ is gitignored; the stale chunks are local-only noise, not committed.)
