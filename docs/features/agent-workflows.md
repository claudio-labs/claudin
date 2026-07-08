# Agent Workflows (`/workflows`, the `Workflow` tool)

**Status: shipping** behind the `AGENT_WORKFLOWS` build flag (on by default in the open
build). This is a **Claudin-only** feature — distinct from the upstream script-fan-out
`Workflow` tool documented in [`workflows.md`](workflows.md) (which stays a stub here).

An **agent workflow** is a linear state-machine of **phases**. Each phase runs **one or more
worker agents** (in parallel when there are several), and a single **main orchestrator** agent
holds the whole-workflow context, synthesizes the phase's worker output, and decides what happens
next: **advance**, **refine** (re-run the phase), or **handback** (return to an earlier phase).
One workflow run drives one task from start to `done` (or `stalled`).

```
backlog → development → code-review → test → done
                ▲             │
                └──handback───┘
```

Two surfaces share one engine (`src/tools/AgentWorkflow/engine.ts`):

- **`/workflows`** — a two-tab TUI (mirrors `/agents`/`/diff`): **Running** (a live board of runs)
  and **Library** (create / edit / delete workflow definitions and start a run).
- **Tools** the model can call: **`Workflow`** (run a workflow), **`ListWorkflows`** (discover
  them), **`WorkflowStatus`** (inspect a run by id). Opt-in only — the model won't fire a workflow
  unless you ask for one.

## Defining a workflow

Definitions live in **`.claudin/workflows/<name>.md`** (project-local, git-committable — run state
in `.claudin/workflows/.runs/` stays ignored). Frontmatter lists the phases; each phase's `agents`
are `agentType`s from `.claudin/agents/*.md` (or built-ins). `handbackTo` lists the earlier phases
a phase may return to. `main` is the orchestrator agent (defaults to the built-in
`workflow-orchestrator` if omitted). The markdown body is free-form instructions handed to every
agent.

```yaml
---
name: dev-flow
description: Backlog → dev → review → test → done
main: orchestrator            # optional; omit to use the built-in workflow-orchestrator
steps:
  - name: development
    agents: [coder]
  - name: code-review
    agents: [reviewer-bugs, reviewer-perf]   # 2 agents, run in parallel
    handbackTo: [development]
  - name: test
    agents: [tester]
    handbackTo: [development]
  - name: done               # terminal phase (no agents)
---
Follow the repository's house style. Prefer small, verifiable changes.
```

## Runtime model

- **Phases are sequential; agents within a phase run in parallel** (capped at `min(8, cores−1)`).
  A failing worker fails **open** — the phase continues with the survivors and the main is told
  which dropped.
- **The main is the controller.** It is invoked once per phase with the **complete run state**
  (every phase, the full history, all worker outputs so far, prior decisions) and emits a
  schema-validated decision via the `StructuredOutput` mechanism. Worker outputs are capped when
  fed to the main so a large fan-out can't blow up its context.
- **Safety caps:** at most 20 transitions per run and 3 refines/handbacks per phase; exceeding
  either marks the run `stalled`. The main can only `advance` (next phase) or `handback` (an
  allowed earlier phase) — no forward jumps.
- **Permissions:** each agent runs with its own `.claudin/agents/*.md` `permissionMode`, **clamped
  so it never exceeds the current session's permission** (a model-invoked `Workflow` call can't
  self-escalate).
- **Persistence:** run state is written after every phase and decision to
  `.claudin/workflows/.runs/<runId>.json`, so a run survives a restart and the board can replay it.

## The Claudin differentiator: per-agent provider/model

Because each worker is an ordinary Claudin agent, **it uses its own agent definition's `model`** —
which, via Claudin's provider abstraction, can point at a different provider entirely. Run a wide,
cheap fan-out on a fast model and reserve a strong model for the orchestrator:

```markdown
<!-- .claudin/agents/reviewer-bugs.md -->
---
name: reviewer-bugs
description: Reviews a diff for correctness bugs.
model: haiku          # cheap, parallel worker
---
You review the change for correctness bugs only. Report concrete findings with file:line.
```

The upstream fan-out `Workflow` assumes a single Anthropic model; here the phase roster is a set of
independent agents, each free to run on the provider/model that fits its job.

## Worked example

`.claudin/workflows/dev-flow.md` (above) with three agents:

```markdown
<!-- .claudin/agents/coder.md -->
---
name: coder
description: Implements the requested change.
---
Implement the task. Keep the change minimal and matching the surrounding code.
```
```markdown
<!-- .claudin/agents/reviewer-perf.md -->
---
name: reviewer-perf
description: Reviews a diff for performance regressions.
model: haiku
---
Review the change for performance regressions only. Be concrete.
```
```markdown
<!-- .claudin/agents/tester.md -->
---
name: tester
description: Runs and reasons about the tests for the change.
---
Verify the change with the project's tests and report what you observed.
```

Run it from the REPL — `/workflows` → Library → `dev-flow` → Enter a task — or let the model call
`Workflow({ workflow: "dev-flow", task: "…" })` (add `run_in_background: true` to detach and check
progress with `WorkflowStatus`).

## Building blocks (for contributors)

`src/tools/AgentWorkflow/`: `types.ts` (schemas + the decision-schema builder), `transitionReducer.ts`
(pure advance/refine/handback + caps), `promptKit.ts` (pure prompt assembly), `runStore.ts` (run
persistence + `exportRunSummary`), `loadWorkflows.ts` (parse + validation), `orchestratorAgent.ts`
(the built-in main), and `engine.ts` (drives `runAgent` per phase, forcing the decision via
`createSyntheticOutputTool`). The three tools live under `WorkflowTool/`, `ListWorkflowsTool/`,
`WorkflowStatusTool/`; the TUI under `src/components/workflows/`.
