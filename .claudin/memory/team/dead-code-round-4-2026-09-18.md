---
name: dead-code-round-4-2026-09-18
description: Fourth dead-code round — 17 commits, −18.5k lines, on branch chore/dead-code-round-4; the empirical throw-probe method that replaced reading, the exports ratchet that now gates CI, two user-visible fixes the removal surfaced, and the 28 second-order findings left for round 5
type: project
---

Branch `chore/dead-code-round-4`, cut from `main` at 76a61870 on 2026-09-18.
**75 files, +2497 / −20962**, 17 commits. Consumes
[[dead-code-round-4-seed]], which is now spent. Plan:
`.claudin/plans/dazzling-orbiting-llama.md`.

## The method that made this round different

Previous rounds read call graphs. This one **broke the code and watched**:

- **For unreachability**, make the entry point `throw` and run the full suite.
  Nine AST entry points (`parseForSecurity`, `parseForSecurityFromAst`,
  `walkProgram`, `checkSemantics`, `nodeTypeId`, `analyzeCommand`,
  `buildParsedCommandFromRoot`, `validateSinglePathCommandArgv`,
  `astRedirectsToOutputRedirections`, `checkSemanticsDeny`) threw at once and
  **10,953 tests stayed green**, the bundle built and the CLI booted. Do NOT
  probe `parseCommand`/`parseCommandRaw` this way — they ARE called, by code
  that correctly handles their `null`, so a throw there masks everything else.
- **For a folded flag**, grep the BUNDLE, not the source. `dispatchHookChainsForEvent`
  appears zero times in the live cli chunk and **no chunk references the emitted
  `hookChains-*.mjs`** — it shipped as an orphan. Same for `updateArcPhase`,
  which survives only inside the `knowledge-*.mjs` command chunk. A `feature()`
  probe under `bun test` proves nothing: every flag reads false there anyway.

## The inventory was half the real size

The seed said "`bashParser/`, 4.5k". The **whole AST layer** was inert:
`ast.ts` (2679) with `checkSemantics` (466 lines, zero callers AND zero tests),
`treeSitterAnalysis.ts` (506), the AST arms of `decide.ts`, `pathValidation.ts`,
`ruleMatching.ts` and `gates.ts`, and the second half of
`bashCommandIsSafeAsync_DEPRECATED`, which re-ran the entire validator chain
against a tree-sitter quote context. **16,957 lines in one commit.**

`SHELL_KEYWORDS` was NOT live, contrary to
[[bash-parser-unreachable-behind-tree-sitter-flag]]: its consumers were
`checkSemantics` and the parser itself.

## Three things that were bugs, not rot

- **`debug()` in the Bash output filter never fired**, since it was written:
  `isEnvTruthy("CLAUDIN_BASH_FILTER_DEBUG")` passes the NAME where `envUtils.ts`
  wants the VALUE. Only such misuse in the tree.
- **The permission dialog's "don't ask again for: ___" field was always empty.**
  `prefix.ts` asked the dead parser for argv. Rewired onto `tryParseShellCommand`;
  `buildPrefix`, `getCommandSpec` and the LCP collapse were live all along, and
  the PowerShell twin already proved the shape (it is untested too — it is a
  structural model, not a net).
- **`EVAL_LIKE_BUILTINS` coverage did not exist.** Ported to a live validator
  (`bashSecurity/validators/evalLike.ts`) BEFORE deleting the AST layer. It reads
  every arm of a compound command, unlike the zsh validator beside it. **Cost:
  `source`, `.`, `exec` and `command` now prompt where a broad allow rule used to
  cover them** — an EXACT allow rule still clears it (`decide.ts:525`). Narrowing
  the list is a one-line change if the friction is not worth it.

## Two things that could NOT be deleted, and why

- **`preparePermissionMatcher` must stay**, returning `() => true`.
  `matching.ts:132` treats a MISSING matcher as "no match", so removing the
  method would flip every `if`-conditioned Bash hook from always-firing to
  never-firing. Only the dead `parseForSecurity` call came out.
- **`knowledgeGraphEnabled`** stays in the config types after `/knowledge` went:
  removing a persisted settings key is a migration, not a deletion.

## The exports ratchet is the durable artifact

`deadcode:exports` (`scripts/verify/deadcode-ci.ts`) closes the hole in
[[deadcode-gate-include-allowlist-hole]]: `--include` is an allowlist, so
`exports`/`types` had never been checked. Modelled on `typecheck-ci.ts` and
sharing its multiset comparison; identity is `<kind> <file>#<name>` with line and
column excluded, entries stored in full so a refresh diff is readable. Verified
by probe in one run: two new unused exports fail it by name, a comment inserted
above a baselined export does not. Now the third gate in `pr-checks.yml`.

It earned its keep three times in this round: it caught `extractCommandArguments`
orphaned by the prefix rewire, `EVAL_LIKE_BUILTINS` exported for no one, and the
28 below. **Honest limit**: knip's view is partial — `src/shared/envUtils.ts` has
zero entries despite an obviously-unused export — so green is not proof.

## Left for round 5

- **28 second-order findings**, exposed when `hookChains.ts` stopped being the
  last importer: exports in `coordinator/teammate.ts`,
  `coordinator/teammateMailbox.ts`, `swarm/teamHelpers.ts`,
  `policyLimits/index.ts`, `bridge/replBridgeHandle.ts`. Baselined, not removed.
- **Off-map flags are down to 11** from 15: BUDDY (a catalog entry gating
  nothing), SLOW_OPERATION_LOGGING, UNATTENDED_RETRY, HOOK_CHAINS and
  CONVERSATION_ARC are gone. The survivors each have their reason in the
  ratchet's header.
- **The keep-alive cache experiment** stays pending by decision, not oversight.
- `bashCommandIsSafe_DEPRECATED` and `RegexParsedCommand_DEPRECATED` are now the
  only implementations; their `_DEPRECATED` suffix is a lie a rename could fix.

## Gate per commit

build, Typecheck (zero new), full `bun test`, smoke, `deadcode:ci`,
`deadcode:prod`, `deadcode:exports`. Final: `rm -rf dist/chunks` then
`verify:privacy` (417 bundle files, clean), `build:strict`, `verify:sdk-types`,
`verify:rules`, `test:floor` (24.82% against a 24.04% floor — it went UP,
because far more source than test was deleted).
