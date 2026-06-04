# 08 — Gap: padrões além do COW em isolation/sandbox/worktree

Cobertura COW já em `08-cow-filesystem-isolation.md`, `deep/`, `fit/`.
omp tem camadas em volta que Claudin não tem.

---

## 1. Worker pool + semáforo (concurrency)

**omp**: `coding-agent/src/task/parallel.ts:26-84` `mapWithConcurrencyLimit`
(worker-pool, fail-fast, abort preserva parciais, ordem mantida);
`:89-116` `Semaphore` standalone. Usado em `task/index.ts:357` (async)
e `:1046-1051` (sync). Setting `task.maxConcurrency` em
`config/settings-schema.ts:2366`.

**Claudin**: `AgentTool.tsx:250-432` dispara sub-agents com `Promise.all`
sem cap; `coordinator/coordinatorMode.ts:215` só fala no prompt, sem
enforcement. Satura rate limit em fan-out grande.

**Encaixe**: portar para `src/utils/parallel.ts` (~120 linhas), setting
`agent.maxConcurrency` (default 4) em `AgentTool` quando N>1.

---

## 2. Baseline + delta patch entre worktrees

**omp** (`task/worktree.ts`): `:97-104` `captureRepoBaseline` (HEAD +
staged + unstaged + untracked); `:127-136` inclui nested repos;
`:106-125` `writeSyntheticTree` usa `GIT_INDEX_FILE` temp pra aplicar
baseline e comparar com tree atual; `:138-156` `captureRepoDeltaPatch`
extrai só o delta da task (não acumulado).

**Claudin**: `ExitWorktreeTool` só preserva ou deleta — não emite patch
consumível pelo parent.

**Encaixe**: `src/utils/worktreeDelta.ts` com `captureBaseline(cwd)` +
`captureDelta(worktreeDir, baseline)`. Habilita "sub-agent investiga,
devolve patch, parent revisa".

---

## 3. Auto-merge: branch + patch + stash dance

**omp** (`task/index.ts:1107-1204`): setting `task.isolation.merge`:
- branch: task → `omp/task/<id>`, `mergeTaskBranches`
  (`worktree.ts:437-499`) cherry-pick sequencial, para no 1º conflito,
  reporta `{ merged, failed, conflict }`.
- patch: `canApplyText` dry-run, all-or-nothing.

`worktree.ts:446` `git stash push` antes do replay; `:478-495` pop no
finally, se falha → merge failure preservando branches. `:378-424`
`commitToBranch` com commit-message callback async (`commitStyle: "ai"`
→ LLM). `:1206-1242` `applyNestedPatches` separado para gitlinks.

**Claudin**: ausente. Worktree de sub-agent fica dangling.

**Encaixe**: condicional ao fan-out com auto-merge. Stash dance é a
parte não-óbvia que vale copiar literal. ~150 linhas.

---

## 4. Wall-clock runtime limit por subagent

**omp** (`task/executor.ts:747-763`): `setTimeout(maxRuntimeMs,
requestAbort("timeout"))`. Defense-in-depth contra stream hang que
escapou do provider watchdog; `:776-781` distingue "timeout" vs
"cancelled".

**Claudin**: `AgentTool` só respeita `AbortSignal` do parent. Stream
hang = zumbi indefinido.

**Encaixe**: setting `agent.maxRuntimeMs` (default 0), em
`AgentTool.tsx:~432`. ~15 linhas.

---

## 5. Recursion prevention

**omp** (`task/index.ts:223,254,774-779`): env `PI_BLOCKED_AGENT` —
agent não spawn de si mesmo, erro claro.

**Claudin**: `taskDepth` existe mas sem guard. Explore chamando Explore
recursivo é possível.

**Encaixe**: `AgentTool.tsx:250` checar
`ctx.parentAgentChain.includes(selectedAgent.name)`. ~5 linhas.

---

## 6. Progress eventbus + retry surfacing

**omp** (`task/types.ts:30-58`): canais
`task:subagent:event|progress|lifecycle`. Lifecycle:
`started|completed|failed|aborted`. `executor.ts:782-799`
`PROGRESS_COALESCE_MS=150` evita flood. `types.ts:182-238`
`AgentProgress.retryState` (sleeping em 429 com retry-after) e
`retryFailure` — UI mostra "blocked: rate-limited".

**Claudin**: `services/api/withRetry.ts` faz retry mas estado não vaza
para UI. Sub-agent dormindo 30s é silencioso.

**Encaixe**: campo `retryState` em `SDKStatus` (`agentSdkTypes.ts`),
emitido de `withRetry.ts` no início do sleep.

---

## 7. Output ID allocation cross-session

**omp** (`task/output-manager.ts:24-107`): IDs sequenciais
(`0-Parent.0-Child`), scan no resume.

**Claudin**: usa sessionId + index transient.

**Encaixe**: pular. Só cabe se Claudin adotar `agent://` URL scheme.

---

## 8. Lacunas que OMP TAMBÉM não tem

Para fechar escopo — nada a importar daqui:
- Network isolation (namespaces, firewall).
- Process sandboxing (seccomp, AppArmor, Landlock, `bwrap`).
- Resource limits CPU/mem/disk (`cgroups`, `ulimit`); só
  `MAX_OUTPUT_BYTES/LINES` (`types.ts:24-27`) cap stdout, não recurso.
- Snapshot/restore de processo — `pi-iso` é só start/stop do FS view.
- IPC entre tasks — falam via patches no final.
- Pause/resume granular — lifecycle de 4 estados, sem pause.
- Bash restricted shell / read-only — Claudin tem
  `BashTool/readOnlyValidation.ts` + `utils/sandbox/sandbox-adapter.ts`
  (`SandboxManager`); omp não tem.

**À frente**: bash sandbox/read-only.
**Atrás**: concurrency cap, delta capture, auto-merge, runtime cap,
recursion guard, retry surfacing.

---

## Prioridade

| # | Item | Esforço | Valor | Decisão |
|---|------|---------|-------|---------|
| 1 | Semaphore + maxConcurrency | baixo | médio | portar |
| 4 | Wall-clock runtime cap | trivial | médio | portar |
| 5 | Recursion prevention | trivial | médio | portar |
| 6 | Retry state em SDKStatus | baixo | médio | portar |
| 2 | Baseline + delta patch | médio | alto (cond.) | quando AgentTool tiver merge |
| 3 | Auto-merge branch/patch | alto | alto (cond.) | depende de #2 |
| 7 | Output ID allocation | médio | baixo | pular |
