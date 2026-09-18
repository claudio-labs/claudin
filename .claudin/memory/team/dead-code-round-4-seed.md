---
name: dead-code-round-4-seed
description: What is still dead or inert on main after rounds 1-3 (HEAD 76a61870), re-verified against the live tree on 2026-09-18 — the ~6.3k-line product-decision group, two bugs wearing dead code's clothes, the flag leftovers, and the 1,337-finding exports/types gate that is still ungated
type: project
---

> **SPENT 2026-09-18** — every item here was taken, on branch
> `chore/dead-code-round-4`. Read [[dead-code-round-4-2026-09-18]] first: the AST
> layer turned out to be twice the size estimated below, and three of the entries
> were bugs rather than rot.

Re-verified 2026-09-18 against `main` at 76a61870, after PR #210/#211/#212.
Supersedes the table in [[unreachable-clusters-inventory-2026-09-18]] (rows 3,
4, 6, 7, 9, 10, 12 are now deleted) and spends what was left of
[[dead-code-round-3-plan-seed]]'s group B.

## 1. Ships and cannot run — each needs a human (~6.3k lines)

| cluster | lines | what actually blocks it |
|---|---|---|
| `platform/bash/bashParser/` | 4500 + 127 façade | **No flag any more.** `TREE_SITTER_BASH` has zero `feature()` sites; `bash/parser.ts:38-42` and `:62-66` are hard-coded `return null`, and `:33-36` spells the flag name in prose so the off-map ratchet cannot pin it. It ships only because `bash/ast.ts:21` pulls `SHELL_KEYWORDS` through the façade. Deleting = keep `bashParser/tokens.ts`, point `ast.ts` at it directly, drop the 717-line test. See [[bash-parser-unreachable-behind-tree-sitter-flag]] |
| `platform/lifecycleHooks/hookChains.ts` | 1319 | `feature('HOOK_CHAINS')` at `lifecycleHooks/shared.ts:171`, off-map ⇒ unconditional return. Only `hookChains.test.ts` + `.integration.test.ts` hold it up. The largest *mechanical* item left |
| `agent/context/conversationArc.ts` | 379 (~190 writer-side) | readers live via `/knowledge`; every writer callerless, `CONVERSATION_ARC` gated at `query.ts:348,1246`. This is group C, not rot — see §2 |
| `platform/MagicDocs/magicDocs.ts` | ~150 of 228 | `initMagicDocs()` is still an empty body BUT is called from `backgroundHousekeeping.ts:21`, and `clearTrackedMagicDocs` has a real caller at `commands/clear/caches.ts:112`. Only `updateMagicDoc`/`updateMagicDocs` are dead |

**`platform/entrypoints/sdk/` is NOT on this list any more.** The old claim
("the whole SDK API is uncallable") is wrong: `structuredIO.ts:15` and
`teammateMailbox.ts:14` import `SDKControlElicitationResponseSchema` /
`PermissionModeSchema` as **runtime values**, and `agentSdkTypes.ts` is not in
`sdk/` at all (`platform/entrypoints/agentSdkTypes.ts`, ~15 live type
importers). `scripts/codegen/generate-sdk-types.ts:39-40` also reads
`coreSchemas.ts` as TEXT and `verify:sdk-types --check` fails if the generated
file goes stale. package.json still has no `main`/`module`/`exports`, so the
*surface* is unpublished — but it is not deletable on a grep.

## 2. Two bugs wearing dead code's clothes

- **`debug()` in the Bash output filter has never once fired.**
  `tools/shared/outputFilter/Bash/pipeline.ts:30` is
  `if (!isEnvTruthy("CLAUDIN_BASH_FILTER_DEBUG")) return` — it passes the env
  var *name* where `shared/envUtils.ts:46` expects its *value*, so the string is
  truthy-but-unrecognised and always resolves false. One-line fix
  (`process.env.CLAUDIN_BASH_FILTER_DEBUG`). It is the only such misuse in the
  tree, verified by reading both files.
- **`/knowledge` can only ever show an empty arc** (conversationArc, above) —
  same class as `AttributionState.fileStates`.

## 3. Flags

- **Build flags: 15 off-map, ratcheted** at
  `scripts/build/feature-flags-source-guard.test.ts:156`; an independent rescan
  with build's own both-quote regex reproduces exactly those 15, zero extras.
  Only `HOOK_CHAINS` and `CONVERSATION_ARC` are large. Small dead locals left:
  `SLOW_OPERATION_LOGGING` (~27 lines, `platform/slowOperations.ts:127-154`),
  `UNATTENDED_RETRY` (~3, `providers/transport/withRetry.ts:127`).
- **The inverse defect**: `BUDDY: true` sits in `scripts/build/build.ts:43` with
  **zero `feature('BUDDY')` call sites** — a catalog entry gating nothing. The
  `/buddy` feature itself is live and ungated.
- **Env: 231 `CLAUDIN_*` names in non-test `src/`, ~221 legitimate.** Nothing
  leaked back from the eight flags round 3 removed. Candidates:
  - the cache-keepalive experiment — `CLAUDIN_CACHE_KEEPALIVE` +
    `_MAX_MIN` + `_MAX_TOKENS` (`agent/cache/anthropic/keepAlive.ts:53,57,62`)
    and `CLAUDIN_MAIN_CACHE_TTL` (`providers/shims/claude/cacheControl.ts:92`),
    all four labelled `EXPERIMENT (2026-09-10)` in their own headers, one of
    which concedes the open question "the bench cannot answer". Conclude or drop
    as a set; while on, it retains one serialized request body per agent key.
  - `CLAUDIN_FRAME_TIMING_LOG` (`terminal/interactiveHelpers.tsx:275`) writes
    per-frame JSONL "for offline analysis by bench/repl-scroll.ts" — **that
    harness does not exist anywhere in the repo**.
  - `CLAUDIN_STATIC_DEDUP` has no reader (the gate was removed, as
    `memory/instructions/claudeMdDelta.ts:58` says), yet
    `providers/shims/staticDedup.shim.integration.test.ts` still saves/sets/
    deletes it at six sites and its header claims the test toggles it. **The
    test is toggling nothing** — fix the test, not the flag.
- **Stale docs** describing flags that were never implemented:
  `CLAUDIN_DISABLE_REWRITE` (`docs/tech/bash-output-filter/architecture.md:544,752`
  + two more files) and `CLAUDIN_DUMP_PREFIX_HASHES`
  (`docs/features/cache-policy.md:118`, listed beside the real
  `CLAUDIN_DUMP_CACHE_ANNOTATIONS`). `scripts/migrations/env-rename-map.json`
  holds 12 more rename targets with no reader — a one-shot migration record,
  low severity.
- `scripts/bench/` is clean: every flag it references resolves to a live read
  site.

## 4. The gate: `exports,types` is still the round-4 item

`deadcode:ci` and `deadcode:prod` both run in `pr-checks.yml` now and both are
green. The dimension still invisible, measured today with
`knip --include files,dependencies,devDependencies,exports,types`:
**931 unused exports + 406 unused exported types = 1,337** (was 1,349 before
round 3 — the rounds moved it by 12, so this is not a backlog the deletions are
eating). It needs a baseline ratchet that does not exist.

Where they cluster, by directory: `platform/entrypoints` 117,
`platform/bash` 70, `terminal/ink` 58, `shared/types` 32, `agent/compact` 30,
`platform/bridge` 29, `platform/lifecycleHooks` 28. The first two and the
seventh **are** the §1 clusters — resolving those alone removes ~215 findings.
`terminal/ink` is the vendored renderer fork and is permanent noise. Apply the
three guards in [[knip-unused-export-is-not-unused]] before believing any single
entry.
