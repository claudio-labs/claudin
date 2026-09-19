---
name: dead-code-round-5-2026-09-19
description: Fifth dead-code round — PR #214, 11 commits, −4.5k lines; the first transitive symbol-level fixpoint, the JSX-as-regex trap that fakes dead components, two real defects it exposed, and the 143-symbol tail left standing
type: project
---

Branch `chore/dead-code-round-5`, cut from `main` at d7e8e54b (2026-09-19).
**103 files, +267 / −4507**, 11 commits, PR
[#214](https://github.com/claudio-labs/claudin/pull/214). Consumes what was left
of [[dead-code-round-4-2026-09-18]].

## The file level is exhausted; the symbol level was never measured

An import-graph scan over `src/` + `scripts/` finds **only ambient `.d.ts`** now
— rounds 1-4 did their job. What was left needed a **transitive fixpoint** over
top-level declarations: mark a symbol dead when every mention of its name
outside its own body sits inside a body already proven dead, iterate. That found
**202 symbols / 2,129 lines** where knip saw a fraction, because knip answers
"does anything import this" and the fixpoint answers "can anything reach this".

## Two traps in writing that scanner

- **A self-closing JSX tag looks exactly like a regex literal.** Blanking regex
  literals before counting identifiers ate the component name out of
  `t0 = <Suspense …><MarkdownWithHighlight {...props} /></Suspense>` — the `/`
  after `}` opens a "regex" that runs to the next `/`. That reported 526 lines
  of LIVE components as dead (`PermissionDecisionDebugInfo`, `AgentPill`, the
  whole `*WithHighlight` family). **Do not blank regexes**; leaving them as text
  only over-counts liveness, which is the safe direction.
- **A `const X = 5` has no braces**, so a brace-balance span walks forward until
  the next function's braces and swallows it. Spans must be clamped to the next
  top-level declaration, and a declaration line with no opening bracket is one
  line.

## The probe is the test you cannot write

You cannot unit-test code you are about to delete. What replaced it: **47
function bodies made to `throw` in one batch**, then full suite + build + smoke
+ a real TUI boot under tmux. All green ⇒ unreachable. Two mechanical notes: the
regex that inserts the throw must not match the `{` of a **return type**
(`Promise<{ … }>` broke three files), and `bunx tsc --noEmit` filtered to
`TS1xxx` is the cheap syntax check before spending 3 minutes on the suite.

What DID get a hand-written test is the **surviving** surface: the two registry
characterization tests gained "every `src/commands/` default import reaches
`COMMANDS()`" and "no binding in tools.ts is `null`", each run red before its
removal; `cleanMessagesForLogging` gained the `isVirtual` promotion test,
validated by deleting the branch.

## Three whole features that could not run

- **`/commit-push-pr`, `/init-verifiers`, `/version`** — imported by
  `commands.ts`, never in `COMMANDS()`. Nothing noticed: tsc does not flag the
  unused import, the build inlines it, knip counts the module as used.
- **REPLTool / SuggestBackgroundPRTool / VerifyPlanExecutionTool** — `const X =
  null` spread as `...(X ? [X] : [])`. The REPL one kept ~220 lines across six
  files alive on paper. NOT a footgun before removal: the `REPL_ONLY_TOOLS`
  filter sits behind a check that the REPL tool is actually present.
- **mockRateLimits + rateLimitMocking** — 8 exports returning a constant for a
  `/mock-limits` command this fork does not have.

## Two defects, not rot

- **`AppState.authVersion` had no writer at all**, while
  `useManageMCPConnections` took it as an effect dependency to refetch the
  claude.ai connector list. A login mid-session kept the pre-login server list
  until restart. It could not have had a writer — both auth paths funnel through
  `clearAuthRelatedCaches()`, plain platform code with no `setAppState` in scope
  — so the counter moved to a module signal (`providers/auth/authChanged.ts`).
  `pluginReconnectKey` is the same shape and IS bumped, at `plugins/refresh.ts`.
- **Gemini `GEMINI_AUTH_MODE=access-token` was unreachable**: it read a
  secure-storage slot nothing wrote. Removed rather than wired — ADC covers the
  case and nobody can hold a token in that slot today.

## What is still standing

- **143 symbols / 693 lines in 72 files**, of which 123 are the unpublished SDK
  surface (`agentSdkTypes.ts` + `coreTypes.generated.ts`) — a product decision,
  not rot, and `verify:sdk-types` guards the generated half.
- The **cache keep-alive experiment** (~590 lines) stays off by default and
  unconcluded, by decision. Only its comment claiming `/clear` cancels the pings
  was corrected.
- `knip-baseline.json` is 1289 → **1244**. Two entries in it are **false** and
  cannot be deleted (the file is generated): `teammate.ts#setDynamicTeamContext`
  and `teammateMailbox.ts#formatTeammateMessages`, both live through a
  `require()` namespace plus member access. The ratchet header names them.

## Gate per commit

build, Typecheck (zero new), full `bun test` (10,740 pass), smoke, `deadcode:ci`,
`deadcode:prod`, `deadcode:exports`, `test:floor` (24.04 → 24.97%). Final:
`rm -rf dist/chunks` then `verify:privacy` (420 files, clean), `build:strict`,
`verify:sdk-types`, `verify:rules`.
