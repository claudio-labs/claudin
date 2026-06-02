# Tool coverage: Claude Code vs claudio

Comparison of the agent-facing tools exposed by the **Claude Code** CLI we are
running inside (the multi-agent "fleet" harness — model `claude-opus-4-8`) against
the tools defined in this repo under `src/tools/`.

Focus: **coverage** — which tools each side has, and which are missing. Prompt
text was extracted directly from the live Claude Code tool schemas (no tools were
invoked) and from claudio's `src/tools/*/prompt.ts`.

> **Caveat on scope.** This snapshots the tools surfaced in *this specific*
> Claude Code session. The standard Claude Code product also ships `Glob`,
> `Grep`, `TodoWrite`, and the MCP tool family — they simply aren't surfaced in
> this harness variant (search is folded into `Bash`, todos into the `Task*`
> family, MCP servers appear as direct `mcp__*` tools). So "not surfaced here"
> does **not** mean upstream lacks it. The genuinely interesting column is the
> reverse: tools Claude Code exposes that **claudio has no working equivalent for**.

---

## 1. Tools present in BOTH — prompt comparison

Legend: **= igual** (texto efetivamente o mesmo, à parte nomes/constantes) ·
**≠ mudou** (diverge em conteúdo, parâmetros ou capacidade).

| Claude Code (esta sessão) | claudio (`src/tools/`) | Prompt | O que difere |
| ------------------------- | ---------------------- | :----: | ------------ |
| `Edit`            | `FileEditTool`        | **=** | idêntico (exact string replacement, pre-read obrigatório) |
| `Write`           | `FileWriteTool`       | **=** | idêntico |
| `ToolSearch`      | `ToolSearchTool`      | **=** | idêntico (mesmas query forms, mesmo formato `<functions>`) |
| `Skill`           | `SkillTool`           | **=** | mesma abertura ("Execute a skill within the main conversation") |
| `EnterPlanMode`   | `EnterPlanModeTool`   | **=** | mesmo texto e exemplos |
| `ExitWorktree`    | `ExitWorktreeTool`    | **=** | idêntico (scope, no-op, keep/remove, discard_changes) |
| `TaskCreate/Get/List/Output/Stop/Update` | `Task{...}Tool` | **=** | família inteira com o mesmo texto-base |
| `NotebookEdit`    | `NotebookEditTool`    | **=** | mesma descrição (replace/insert/delete por índice) |
| `Monitor`         | `MonitorTool`         | **=** | mesmo conceito/uso (montado por schema, não `prompt.ts`) |
| `RemoteTrigger`   | `RemoteTriggerTool`   | **=** | mesma API claude.ai (list/get/create/update/run) |
| `Read`            | `FileReadTool`        | **≠** | **claudio é mais rico**: estratégia de "surgical reads" com `view='outline'` + `symbol='X'`; o prompt do CC desta sessão é mais enxuto |
| `Bash`            | `BashTool`            | **≠** | claudio adiciona seção de **sandbox**, bloco git/PR via *attachment*, preferência por Glob/Grep/Read vs `cat/sed`, e regras anti-`sleep`; CC desta sessão é mais curto |
| `Agent`           | `AgentTool`           | **≠** | mesma base, mas claudio inclui **fork de subagente**, `SendMessage` para retomar, dispatch automático do `Explore` e nota de concorrência por tipo de assinatura |
| `AskUserQuestion` | `AskUserQuestionTool` | **≠** | **versões diferentes**: claudio = "ask the user questions during execution"; CC = "**only when you are blocked on a decision**…" (regra mais restritiva, + suporte a `preview`/plan mode) |
| `ExitPlanMode`    | `ExitPlanModeTool` (V2) | **≠** | **parâmetros divergem**: claudio usa `filesToEdit` (monta o "dossier" do implementador); CC usa `allowedPrompts` (permissões prompt-based) |
| `EnterWorktree`   | `EnterWorktreeTool`   | **≠** | **CC é mais novo**: aceita `path` para entrar em worktree existente e expõe o toggle `worktree.baseRef` (`fresh`/`head`). Correção: o claudio **já ramifica de `origin/<default>` por padrão** (= comportamento `fresh`, `worktree.ts:325-343`), com fallback p/ HEAD; o que falta é o param `path` e o toggle explícito de `baseRef` |
| `WebFetch`        | `WebFetchTool`        | **≠** | claudio usa a descrição **verbosa clássica** (bullets "Fetches content… processes it using an AI model"); CC é o formato curto de 4 linhas |
| `WebSearch`       | `WebSearchTool`       | **≠** | reescrito ("You are the Claudio web search tool"); CC é o curto "Search the web… US-only" + regra de "Sources:" |
| `CronCreate/Delete/List` | `ScheduleCronTool` | **≠** | claudio **adiciona durabilidade** (`durable:true` → `.claudio/scheduled_tasks.json`) e condensa o texto; CC é só session-only, com nota "not for live watching → Monitor" e expiração de 7 dias |
| `Workflow`        | `WorkflowTool`        | **?** | descrição gerada dinamicamente — não comparada texto-a-texto nesta passagem |

**Resumo da seção:** ~10 tools com prompt **igual**, ~9 com **mudanças** (a maioria
são o claudio estando *à frente* — Read/Bash/Agent/Cron mais ricos — ou *atrás* —
EnterWorktree e AskUserQuestion são versões mais antigas que as desta sessão do CC).

---

## 2. Claude Code HAS — claudio is MISSING or STUBBED  ⚠️ (actionable gaps)

These are the real coverage gaps for the open build.

### `ScheduleWakeup` — **absent in claudio**
No match anywhere in `src/`. Drives `/loop` *dynamic mode*: lets the model
schedule its own next wake-up (cache-aware delay picking, the `<<autonomous-loop-dynamic>>`
sentinel, etc.). claudio's only scheduling primitive is cron (`ScheduleCronTool`),
which fires on wall-clock, not model-paced self-resume.

### `LSP` — **service exists, tool not exposed**
claudio ships a full LSP layer at `src/services/lsp/` (LSPClient, server manager,
diagnostic registry) but uses it only for **passive diagnostics** appended to tool
results (`diagnosticsForToolResult.ts`, `passiveFeedback.ts`). There is **no
`src/tools/LSPTool/`** — the model cannot actively query the language server.
Claude Code's `LSP` tool exposes 9 operations: `goToDefinition`, `findReferences`,
`hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`,
`prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`. Lowest-effort high-value
port: the plumbing already exists.

### `PushNotification` — **referenced but stubbed → no-op**
`src/tools.ts:52` does `require('./tools/PushNotificationTool/PushNotificationTool.js')`,
but `src/tools/PushNotificationTool/` does not exist in the repo. It's an
Anthropic-internal module, so the build pre-scan stubs it → the tool is a no-op in
the open build. Desktop/phone notification when a long task finishes or a decision
is needed is therefore unavailable.

---

## 3. claudio HAS — not surfaced in this Claude Code session

Most of these exist in upstream Claude Code too and are just not exposed in *this*
harness; a few are claudio- or environment-specific. Not coverage gaps for claudio.

| claudio tool | Why not seen here |
| ------------ | ----------------- |
| `GlobTool`, `GrepTool` | this harness folds search into `Bash` |
| `TodoWriteTool` | this harness uses the `Task*` family instead |
| `MCPTool`, `McpAuthTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool` | MCP surfaced here as direct `mcp__*` tools |
| `PowerShellTool` | Linux session |
| `SendMessageTool` | referenced by `Agent` here ("use SendMessage with the agent's ID") but not a standalone listed tool |
| `REPLTool` | not surfaced |
| `ConfigTool`, `BriefTool`, `SuggestBackgroundPRTool`, `SyntheticOutputTool`, `SleepTool`, `TeamCreateTool`, `TeamDeleteTool`, `TungstenTool`, `VerifyPlanExecutionTool` | harness/coordinator-specific; not in this session's registry |

Note: claudio's `SleepTool` overlaps conceptually with Claude Code's
`ScheduleWakeup` but is a passive blocking sleep, not a model-paced resume scheduler.

---

## 4. Summary

- **Functional parity is high**: ~20 tool families exist on both sides with
  matching prompts/behavior.
- **Three genuine gaps in claudio**, in priority order:
  1. `LSP` tool — service already exists, just needs a model-facing tool wrapper.
  2. `ScheduleWakeup` — no equivalent; needed for `/loop` dynamic self-pacing.
  3. `PushNotification` — currently stubbed; would need an open re-implementation.
- Everything claudio "lacks" relative to this session is a harness display
  difference (Glob/Grep/TodoWrite/MCP), not a missing capability.
