# Workflows (`/workflows`, the `Workflow` tool)

**Status: not yet in claudin.** `src/tools/WorkflowTool/constants.ts` is an explicit stub
(`// Stub — WorkflowTool not included in source snapshot`) — only the tool name exists, there
is no engine, no prompt, no `/workflows` command, and no `WORKFLOW_SCRIPTS` flag in
`scripts/build.ts`. This doc specifies the feature as it ships in the upstream Claude Code
2.1.201 reference, so it can be ported. Where it names a file, that path is **proposed**, not
present.

A `Workflow` is a **deterministic multi-agent orchestrator**: the model writes a small
JavaScript script that fans work out across many subagents, and the runtime executes that
script — loops, conditionals, fan-out and all — in the background. The tool call returns
immediately with a task id; a `<task-notification>` arrives when the whole script finishes.
`/workflows` watches live progress.

The script is where the *structure* of the work lives. A single agent decides its next step one
turn at a time; a workflow encodes the plan up front — what runs in parallel, what verifies what,
what synthesizes the result — and runs it the same way every time.

**Single-phase archetypes** the prompt names, each one well-scoped fan-out:

| Archetype | Shape |
|---|---|
| **Understand** | parallel readers over relevant subsystems → structured map |
| **Design** | judge panel of N independent approaches → scored synthesis |
| **Review** | dimensions → find → adversarially verify (the worked example below) |
| **Research** | multi-modal sweep → deep-read → synthesize |
| **Migrate** | discover sites → transform each (worktree isolation) → verify |

For larger work, **chain several in sequence** across turns — read each result before deciding the
next phase. You stay in the loop; each workflow is one fan-out, not the whole job.

## The problem

A plain agent loop is model-driven: each tool call is chosen in the moment, in one context
window. That is the right shape for most tasks, but it hits three walls:

| Wall | Symptom |
|---|---|
| **Breadth** | "Review these 40 files" / "migrate every call site" serializes into one context that fills up and degrades long before the work is done. |
| **Confidence** | A single pass produces plausible-but-wrong findings; there is no independent second opinion, no adversarial check before the answer is committed. |
| **Scale beyond one context** | An audit or sweep that can't fit in a single window has nowhere to go — the agent summarizes, drops detail, and loses the thread. |

The escape hatch is more agents — but ad-hoc `Agent` calls are still model-driven and
non-deterministic. A workflow makes the fan-out *structured and repeatable*: decompose, cover in
parallel, verify independently, synthesize.

## What it does

The model passes a self-contained script. Every script starts with a pure-literal `meta` block,
then a body built from a handful of hooks.

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],   // one entry per phase() call
}

const DIMENSIONS = [{key: 'bugs', prompt: '…'}, {key: 'perf', prompt: '…'}]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA}),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, {phase: 'Verify', schema: VERDICT_SCHEMA})
      .then(v => ({...f, verdict: v}))))
)
return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict?.isReal) }
```

### The `meta` block

Required `name` and `description`; optional `whenToUse`, `phases`, `model`. It **must be a pure
literal** — no variables, calls, spreads, or interpolation — so the runtime can read it without
executing the body. Phase titles in `meta.phases` are matched exactly against `phase()` calls to
group the progress display.

### Body hooks

| Hook | What it does |
|---|---|
| `agent(prompt, opts?)` | Spawn one subagent. Returns its final text (string), or — with `opts.schema` (a JSON Schema) — a validated object (the subagent is forced to call `StructuredOutput`, retrying on mismatch). Returns `null` if the user skips it mid-run or it dies on a terminal error after retries, so `.filter(Boolean)` results. `opts`: `label`, `phase`, `schema`, `model`, `effort`, `isolation:'worktree'`, `agentType`. |
| `pipeline(items, ...stages)` | Run each item through all stages **independently — no barrier**. Item A can be in stage 3 while B is still in stage 1. Wall-clock = slowest single-item chain. The default for multi-stage work. Each stage gets `(prevResult, originalItem, index)`; a stage that throws drops that item to `null` and skips its remaining stages. |
| `parallel(thunks)` | Run thunks concurrently, **await all (a barrier)**. A throwing thunk resolves to `null` (the call never rejects) — `.filter(Boolean)` the result. |
| `phase(title)` | Start a progress group; subsequent `agent()` calls are grouped under it. |
| `log(msg)` | Emit a narrator line to the user above the progress tree. |
| `args` | The value passed as the tool's `args` input, verbatim — parameterizes named workflows. |
| `budget` | The turn's token target (`{total, spent(), remaining()}`) from a `+500k`-style directive. Hard ceiling: once `spent()` hits `total`, further `agent()` calls throw. |
| `workflow(nameOrRef, args?)` | Run another workflow inline as a sub-step (one level of nesting only). |

**`agent()` option nuances that matter:**

- `model` — **default to omitting it.** The agent inherits the main-loop (session) model, which is
  almost always right; override only when confident a different tier fits.
- `effort` — `low` for cheap mechanical stages, higher tiers only for the hardest verify/judge
  stages; omit to inherit the session effort.
- `phase` — set it explicitly inside `pipeline()`/`parallel()` stages so concurrent stages don't
  race on the global `phase()` state; the same string groups agents into the same box.
- `isolation:'worktree'` — **expensive** (~200–500 ms + disk per agent). Use *only* when agents
  mutate files in parallel and would otherwise conflict; the worktree is auto-removed if unchanged.
- `agentType` — use a custom subagent type (e.g. `code-reviewer`); composes with `schema`.

**`budget` gotcha:** guard dynamic loops on `budget.total`. With no target set, `remaining()` is
`Infinity`, so `while (budget.remaining() > …)` would run straight to the 1000-agent cap — write
`while (budget.total && budget.remaining() > 50_000) { … }`.

**`workflow()` semantics:** pass a saved name or `{scriptPath}`. The child shares this run's
concurrency cap, agent counter, abort signal and token budget (its agents count toward
`budget.spent()`). Nesting is one level only — `workflow()` inside a child throws. It also throws on
an unknown name / unreadable path / child syntax error, so `catch` to degrade gracefully.

## Execution model

- **Background.** The tool returns a `runId` immediately; the script runs detached. A
  `<task-notification>` re-invokes the caller when it completes. `/workflows` streams live
  progress (the phase tree, per-agent labels, narrator `log()` lines).
- **Concurrency.** Concurrent `agent()` calls are capped at `min(16, cores − 2)` per workflow;
  excess calls queue. Lifetime cap of 1000 agents (a runaway backstop); a single
  `parallel()`/`pipeline()` call takes at most 4096 items.
- **Authoring & iteration.** The script is passed **inline** via `script` — not written to a file
  first. Every invocation auto-persists it under the session directory and returns that path in the
  tool result; to iterate, edit that file and re-invoke with `{scriptPath}` instead of resending the
  whole script. The `args` input reaches the script as the `args` global **verbatim** — pass
  arrays/objects as real JSON values, not a JSON-encoded string (a stringified list arrives as one
  string and breaks `args.map`/`args.filter`).
- **MCP access.** Workflow agents can reach all session-connected MCP tools via `ToolSearch`
  (schemas load on demand per agent). Caveat: interactively-authenticated MCP servers may be absent
  in headless / cron runs.
- **Resume.** Relaunch with `{scriptPath, resumeFromRunId}` — the longest unchanged prefix of
  `agent()` calls returns cached results instantly; the first edited/new call and everything after
  it re-runs. Same script + same args → 100% cache hit. The per-run `journal.jsonl` records each
  agent's actual return value — read it before diagnosing why a run returned empty, rather than
  assuming cached results were non-empty.

## `pipeline` by default; `parallel` only for a real barrier

The single most important authoring rule. A barrier (`parallel` between stages) is justified
**only** when stage N needs cross-item context from all of stage N−1 — dedup/merge across the full
result set, an early-exit on the total count, or a prompt that references "the other findings". It
is **not** justified by "I need to flatten/map/filter first" (do that inside a pipeline stage) or
"it's cleaner". Barrier latency is real: if the slowest finder takes 3× the fastest, a barrier
wastes 2/3 of the fast finders' idle time.

```js
// Barrier IS correct — dedup across ALL findings before expensive verification:
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS})))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))
const verified = await parallel(deduped.map(f => () => agent(verify(f), {schema: VERDICT})))
```

## Quality patterns

The catalog the prompt ships with — compose freely, scale to what the user asked for:

| Pattern | Shape |
|---|---|
| **Adversarial verify** | Spawn N skeptics per finding, each prompted to *refute*; kill it if a majority refute. Stops plausible-but-wrong findings from surviving. |
| **Perspective-diverse verify** | When a finding can fail in more than one way, give each verifier a distinct lens (correctness / security / perf / does-it-reproduce) instead of N identical refuters. |
| **Judge panel** | Generate N independent attempts from different angles, score with parallel judges, synthesize from the winner while grafting the best of the runners-up. |
| **Loop-until-dry** | For unknown-size discovery, keep spawning finders until K consecutive rounds return nothing new — dedup against everything *seen*, not just what was confirmed, or it never converges. |
| **Multi-modal sweep** | Parallel agents each search a different way (by-container, by-content, by-entity, by-time); each is blind to what the others surface. |
| **Completeness critic** | A final agent asks "what's missing — modality not run, claim unverified, source unread?"; its answer becomes the next round. |
| **No silent caps** | If a workflow bounds coverage (top-N, no-retry, sampling), `log()` what was dropped — silent truncation reads as "covered everything" when it didn't. |

## When it runs (opt-in)

Because a workflow can spawn dozens of agents and burn a large amount of tokens, it is
**explicit opt-in only**. The tool fires when: the user typed the keyword `ultracode`; ultracode
is on for the session; the user asked for a workflow / multi-agent orchestration in their own
words; a skill or command told the model to call it; or the user named a saved workflow.
Otherwise the model uses individual `Agent` calls or asks first. **Ultracode mode** flips the
default: author and run a workflow for every substantive task, quality over token cost.

## Script constraints

Plain JavaScript, not TypeScript (no type annotations / interfaces / generics). Standard built-ins
are available **except** `Date.now()` / `Math.random()` / argless `new Date()` — they would break
resume, so pass timestamps via `args` and vary randomness by index. No filesystem / Node APIs.

## How it would land in claudin

- **Flag.** Add `WORKFLOW_SCRIPTS: true` to `featureFlags` in `scripts/build.ts`; gate the tool
  registration in `src/tools/tools.ts` (`getAllBaseTools`) behind it, matching the existing
  `feature()`-gated tools.
- **Tool.** Flesh out `src/tools/WorkflowTool/` (currently the stub `constants.ts`): the tool
  schema (`script` / `scriptPath` / `name` / `args` / `resumeFromRunId`), the prompt (this
  catalog), and the engine that evaluates the script with the `agent`/`pipeline`/`parallel`/
  `phase`/`log`/`budget`/`workflow` hooks bound to claudin's existing `AgentTool` runner.
- **Reuse.** claudin already has the hard parts: background agents + `TaskOutput`/`TaskStop`,
  fork subagents, worktree isolation (`EnterWorktree`), the `COORDINATOR_MODE` worker-delegation
  machinery (`src/agent/coordinator/`), and the `TOKEN_BUDGET` flag for `budget`. The engine is mostly
  glue over those.
- **`/workflows` command.** A live progress viewer (`src/commands/workflows/`) over the run's
  phase tree + per-agent labels + `log()` narrator lines.

## References

- Upstream reference: Claude Code 2.1.201 `Workflow` tool (schema + prompt).
- claudin building blocks: `src/agent/coordinator/coordinatorMode.ts`, `src/tools/AgentTool/`,
  `src/tools/WorkflowTool/constants.ts` (stub), `scripts/build.ts` (`featureFlags`).
- Related: `docs/features/report-findings.md` (a structured verifier output that pairs with the
  review/verify workflow shape).
