# Claudio — Roadmap Técnico

> Última auditoria: 2026-05-05 | ROI honesto, sem itens marginais | última atualização: 2026-05-15 (7.0 — `/autofix-pr` ✅ entregue)

Roadmap enxuto após auditoria contra o código real. Itens marginais, obsoletos e overengineering foram removidos. Mantém só o que **vale a pena de verdade** + histórico do que já foi feito.

---

## Ativos (13 itens)

### 6.1 — Command-aware bash output filter ⭐ NOVO (P0, top priority)
- **Esforço:** L (8 PRs sequenciados, ~2.200 LoC total)
- **Prioridade:** **P0** — maior ROI absoluto medido em qualquer item ativo do roadmap.
- **Status:** ✅ **Todas as 8 fases concluídas** (2026-05-09). Feature ativa por default em instalações novas.

#### Documentação
- **Discovery:** [`docs/discovery/bash-output-filter/`](docs/discovery/bash-output-filter/) — 8 rodadas, 67/67 cases passing, 35+ comandos analisados, [`optimization-matrix.md`](docs/discovery/bash-output-filter/optimization-matrix.md), [`rtk-comparison.md`](docs/discovery/bash-output-filter/rtk-comparison.md)
- **Spec técnica:** [`docs/tech/bash-output-filter/architecture.md`](docs/tech/bash-output-filter/architecture.md) — rev 2 pós-review aplicado (22 seções, ~900 linhas, 4 bloqueadores + 5 misalignments corrigidos)
- **Phase docs (8):** [`docs/tech/bash-output-filter/phases/`](docs/tech/bash-output-filter/phases/) — um doc por PR, com pré-requisitos, file changes line-by-line, tests, acceptance, PR template

#### Phases (8 PRs, sequenciadas)

Cada phase doc é self-contained — agent/dev pode pickup uma fase lendo só ela + a architecture.md.

- [x] **6.1.0** — [Plumbing](docs/tech/bash-output-filter/phases/phase-0-plumbing.md) (~10 LoC) — extend `isAlreadyCompacted` em `toolResultSummarizer.ts:242` + register 3 config keys em `GLOBAL_CONFIG_KEYS` + export collapse helpers
- [x] **6.1.1** — [Skeleton + harness](docs/tech/bash-output-filter/phases/phase-1-skeleton.md) (~700 LoC) — cria `src/outputFilter/Bash/`, port do `validation/pipeline.ts`, harness com 67 cases, redos scan (módulo é dead code)
- [x] **6.1.2** — [Built-in batch 1](docs/tech/bash-output-filter/phases/phase-2-builtin-batch-1.md) (~400 LoC) — 10 highest-ROI filters em 7 family files (bundle/pytest/ps/rubocop/go-test/ls/rspec/top/cargo/grep-rg/ruff)
- [x] **6.1.3** — [BashTool integration](docs/tech/bash-output-filter/phases/phase-3-bashtool-integration.md) (~30 LoC) — wire pipeline-only no `BashTool.call()` (rewrite vem na 6.1.4)
- [x] **6.1.4** — [Rewrite layer](docs/tech/bash-output-filter/phases/phase-4-rewrite-layer.md) (~150 LoC) — `planFilter` com `rewriteCommand` + 5 rewrite filters (git-log força `--oneline`, git-status força `--porcelain`, gh pr/issue/run list força `--json`)
- [x] **6.1.5** — [Built-in batch 2](docs/tech/bash-output-filter/phases/phase-5-builtin-batch-2.md) (~250 LoC) — git family completa (status/log/blame/pull/add/commit/push), docker (ps/images/logs), network (curl/wget/dig), journalctl
- [x] **6.1.6** — [User filters](docs/tech/bash-output-filter/phases/phase-6-user-filters.md) (~290 LoC) — `~/.claudio/filters.json` + zod schema + ReDoS guards (length cap + denylist + build-time scan)
- [x] **6.1.7** — [Default-on flip](docs/tech/bash-output-filter/phases/phase-7-default-on.md) — `shouldFilterOutput` default-on (`!== false`), toggle em `/config`, tip de performance em `tipRegistry`
- [x] **6.1.9** — [System utilities](docs/tech/bash-output-filter/phases/phase-9-system-utils.md) (~140 LoC) — ping, rsync, tree, ssh, df, du, dmesg, stat, jq + curl-plain. Todos os 10 specs atingem o target (ping 58%, rsync 91%, tree 52%, ssh 98%, df 60%, du 59%, dmesg 27%, curl-plain 78%). Aggregate gain table (41 filtros): **69.9%** de redução.


#### Ganho esperado (medido empiricamente)

Top filtros por ROI medido:
- `bundle install` **96%**, `pytest` **95%**, `ps aux` **93%**, `git log` (rewrite) **92%**, `ls -la` **81%**
- `rubocop` **83%**, `go test -v` **82%**, `rspec` **73%**, `wget` **72%**, `cargo check` **64%**

Cumulativo numa sessão típica 30min: **~50k tokens economizados**, **~72% redução custo input**.

#### Arquitetura (3 toques no codebase, ~20 LoC totais)

1. `BashTool.tsx` (`call`): 2 inserções (`planFilter` antes de `runShellCommand`, `applyFilterToStdout` depois)
2. `toolResultSummarizer.ts:242` (`isAlreadyCompacted`): +2 linhas pra reconhecer markers do filter
3. `config.ts:705` (`GLOBAL_CONFIG_KEYS`): registrar 3 keys flat

Markers vão direto pra `result.stdout` — sobrevivem error path via `ShellError`. `mapToolResult`, `processToolResultBlock`, `Out` schema intactos.

### 6.2 — Bash output filter — tier-1 follow-ups (Linux JS/TS toolchain + tsc + git diff/show)
- **Esforço:** M (1 PR Linux done, 1 PR Windows pending)
- **Prioridade:** **P1** — preenche o gap mais visível pós-6.1: stack TS é a mais comum, e `tsc`/`jest`/`vitest`/`bun test` não estavam mapeados.
- **Status:** ✅ **Linux side concluído** (2026-05-09, 8 specs, ~330 LoC). **Windows/PowerShell pendente** (sub-fase 9, ver doc).

#### Documentação
- **Phase doc:** [`docs/tech/bash-output-filter/phases/phase-8-tier1-followups.md`](docs/tech/bash-output-filter/phases/phase-8-tier1-followups.md)
- **Bench reproducível:** `CLAUDIO_BENCH=1 bun test scripts/profile/bash-filter-gain.test.ts` — 31 filtros, agregado 71% redução

#### Filters adicionados (8 specs, Linux)

- [x] **JS/TS test runners** (5 specs em `tests-js.ts`): `jest` 98.7%, `vitest` 98.5%, `bun test` 98.2%, `mocha` 97.6%, `playwright test` 98.4% — colapso pra sentinela em runs limpos, `unless` guard preserva failures
- [x] **TypeScript compiler** (`tsc.ts`): `tsc` / `tsc --noEmit` 18.2% — strip ASCII underline `~~~` lines + tabela trailing `Errors  Files` redundante
- [x] **git diff / show** (extensão de `git.ts`): `git diff` 10.8%, `git show` 9.4% — strip `diff --git a/X b/X` + `index <hash>..<hash>` + `\ No newline at end of file`; git-show colapsa `Author: Name <email>\nDate: ...` em uma linha

#### Pendente (sub-fase 9 — Windows/PowerShell)

- [ ] `Get-ChildItem` / `dir` — equivalente do `ls -la`
- [ ] `Get-Process` / `tasklist` — equivalente do `ps aux`
- [ ] `Get-Service`, `Get-WinEvent`/`Get-EventLog`
- [ ] `dotnet build` / `dotnet test` / `dotnet restore`
- [ ] `msbuild`

PowerShell tem 2 peculiaridades vs bash (output tabular auto-formatado + object pipeline) que precisam de ajuste em `pipeline.ts` antes de implementar — abrir como Phase 9 dedicada.

#### Arquivos tocados (Linux)

- 2 arquivos novos: `src/outputFilter/Bash/filters/{tests-js,tsc}.ts`
- 1 extensão: `src/outputFilter/Bash/filters/git.ts` (gitDiff + gitShow)
- 1 registry: `src/outputFilter/Bash/filters/index.ts`
- 8 fixtures novos em ambos `src/outputFilter/Bash/__fixtures__/samples/` E `docs/discovery/bash-output-filter/validation/samples/` (harness lê desse último — ver Implementation Notes do phase doc)
- 1 harness extension: `src/outputFilter/Bash/bashFilter.test.ts` (+8 describe blocks, ~50 expect calls)
- 1 bench update: `scripts/profile/bash-filter-gain.test.ts` (+8 cenários)

### 7.0 — `/autofix-pr` — comando unificado de autofix de PR (P0) — ✅ ENTREGUE
- **Esforço real:** M (~7 commits, ~700 LoC TS + testes/snapshots)
- **Status:** ✅ **Concluído** (2026-05-15) em `feat/autofix-pr`. Reativo (sem `--watch`): usuário invoca; comando coleta → triagem → fix → push → reply, loop até 5 iter com anti-stall.

#### Entregue
- `src/commands/autofix-pr/{index.ts, prompt.ts, shared.ts}` + testes colocados.
- Guards reaproveitando `getIsGit`, `getBranch`, `getDefaultBranch`, `fetchPrStatus` (5 falhas curtas: not-git, detached HEAD, default branch, gh não autenticado, sem PR).
- `--dry-run`: paridade com antigo `/pr-comments` + triagem (5 labels: `ok`, `change_request`, `pr_questionable`, `unclear`, `out_of_scope`).
- Modo padrão: collect → triage → AskUserQuestion para `pr_questionable`/`unclear` → fix → typecheck + focused tests → commit (sem `--amend`/`--no-verify`) → push (sem force) → reply em thread.
- Loop até 5 iterações com anti-stall por `(comment_id, updated_at)`.
- Removido: `src/commands/pr_comments/`, registro em `src/commands.ts`, stub `index.js`.
- `--watch` com `CronCreate`: **rejeitado** (reativo é mais elegante; status bar já mostra `reviewState` para o usuário decidir invocar).

### 5.3b — Auditar caches secundários (não cobertos pela 5.3a)
- **Esforço:** S por cache (auditoria estática + bench se sobreviver à triagem)
- **Prioridade:** P3 (nenhum reportado como leak ativo; 5.0 mitigou OOM)
- **Estado:** A 5.3a cobriu 5 dos ~14 sites originalmente listados (Markdown.tokenCache, queryHelpers.toolProgressLastSentTime, imageStore.storedImagePaths, LSPDiagnosticRegistry.deliveredDiagnostics, fileReadCache). Outros 9 sites foram pulados:
  - **Já neutralizados no build aberto:** `services/analytics/growthbook.ts` (4 maps/sets — substituídos por stub vazio em `scripts/no-telemetry-plugin.ts:36-228`), `utils/telemetry/perfettoTracing.ts`, `utils/telemetry/sessionTracing.ts` (telemetry desligada por feature flag).
  - **Verificados por inspeção, sem cap mas com self-cleanup correto:** `utils/auth.ts:1363` pending401Handlers (`finally { delete }` em :1387), `services/lsp/LSPDiagnosticRegistry.ts:60` fileWaiters (cleanup em resolve/timeout em :147-152).
  - **Não auditados ainda:** `services/MagicDocs/magicDocs.ts:38` trackedMagicDocs, `services/api/promptCacheBreakDetection.ts:98` previousStateBySource, `utils/hooks/AsyncHookRegistry.ts:28` pendingHooks, `skills/loadSkillsDir.ts:907,912` dynamicSkills + conditionalSkills, `services/planDossier.ts:469,484` revalidateCache + agentPlanSlugRegistry.
- **Ganho:** Confirmar que nenhum dos 5 não-auditados tem leak real. Provavelmente baixo (5.0 já mitigou OOM e bench da 5.3a passou); abrir só se aparecer pressão de heap em sessões longas reais.
- **Abordagem:** auditoria estática primeiro (eviction? cleanup hook? scoped per-session?). Se algum aparecer suspeito → adicionar exerciser ao `long-session-bench.ts`.
- **Arquivos:** dependentes da triagem.

### 5.1b — Code-splitting follow-up: codexShim + openaiShim helpers
- **Esforço:** M
- **Prioridade:** P3 (ganho marginal, ~50-80 KB)
- **Estado:** A 5.1 cobriu os SDKs grandes (Bedrock/Vertex/Foundry externalizados). `codexShim.ts` (972 LoC) e helpers (`geminiAuth`, `geminiCredentials`, `githubModelsCredentials`, `codexCredentials`) ainda são imports estáticos de `openaiShim.ts:24-78`. Complicação: `convertAnthropicMessagesToResponsesInput`/`convertToolsToResponsesTools` do codexShim são usados também no fallback `/responses` do GitHub Copilot (`openaiShim.ts:1931,1962`), não só em `transport==='codex_responses'`. Splitting requer um getter lazy memoizado.
- **Ganho:** Bundles para usuários puramente OpenAI/Mistral diminuem ~50-80 KB. Marginal.
- **Abordagem:** `const getCodex = lazy(() => import('./codexShim.js'))` com await nos 6 call sites. Idem para gemini/github helpers gated por mode flags.
- **Arquivos:** `src/services/api/openaiShim.ts`

### 5.10 — Lazy bash parser (~12.3k LoC eagerly loaded)
- **Esforço:** S (1-2h)
- **Prioridade:** P1
- **Estado:** `src/utils/bash/*.ts` soma 12 306 LoC (bashParser 4 436, ast 2 679, commands 1 339, heredoc 733, ShellSnapshot 582, treeSitterAnalysis 506, ParsedCommand 318...). Importado por BashTool (`src/tools/BashTool/BashTool.tsx`), bashCommandHelpers, readOnlyValidation, bashPermissions, pathValidation, MonitorTool. Parser é JIT-compilado em todo startup, mesmo em sessões `--print`/plan-mode/MCP-only que nunca chamam Bash.
- **Ganho:** Modesto mas barato. Diferimento de ~12k LoC compilados até a primeira invocação BashTool/MonitorTool. Bench `scripts/profile/long-session-bench.ts` deve mostrar delta claro de retained code size.
- **Abordagem:** Getter `getBashParser()` lazy memoizado, disparado só na primeira invocação real. Cuidado: `bashPermissions.ts`/`pathValidation.ts` rodam em pre-tool-use (validação de prompt) — verificar se já não força carregamento eager via algum hook.
- **Arquivos:** `src/utils/bash/*.ts` consumers, `src/tools/BashTool/*`

### 5.11 — Sub-agents em `worker_threads` (eliminar duplicação de heap)
- **Esforço:** L (multi-dia)
- **Prioridade:** P1 (maior potencial de ganho real — centenas de MB em sessões agent-heavy)
- **Estado:** Confirmado: zero uso de `worker_threads`/`new Worker(` em todo `src/`. `runAgent.ts:1031 LoC` faz `import { query } from '../../query.js'` estático; `coordinator/workerAgent.ts` tem só **18 linhas** (nome enganoso — não é um Worker, é uma fachada in-process). Quando o usuário dispara N AgentTool em paralelo (coordinator mode, ou múltiplas calls numa única resposta), cada sub-agente carrega QueryEngine + registry de tools + closures completas no mesmo heap principal. Em árvores A→B→C o retained-set multiplica.
- **Ganho:** Único candidato com potencial de cortar centenas de MB em sessões pesadas. Worker dispensa Ink/React-reconciler/startupProfiler/TUI inteira; carrega só o subset necessário (api client + tool registry + slice mínimo de utils).
- **Abordagem:** Pool de `worker_threads` (limit configurável; default = `os.cpus().length`). Mensagem entry: `(prompt, agentType, parentMessagesSlice, dossier, permissionContext)` via `postMessage` com structured clone. Worker streama `SDKMessage` de volta. Cuidado com: (1) MCP servers já são child processes — sub-agents precisam reusar conexões parent ou abrir próprias?, (2) permission prompts precisam re-roteados ao parent, (3) `worker_threads` aceita ESM via `--experimental-vm-modules` ou bundle separado, (4) Ctrl-C precisa propagar `terminate()` ao pool.
- **Arquivos:** `src/coordinator/workerAgent.ts` (substituir façade), `src/tools/AgentTool/runAgent.ts`, possivelmente um novo bundle entry `src/entrypoints/agent-worker.ts` para evitar carregar Ink no worker.

### 5.2 — Auditoria de lodash `memoize` por escape de closure
- **Esforço:** S-M (meio dia)
- **Prioridade:** P3
- **Estado:** 116 sites usam `memoize` do lodash. Default mantém Map sem bound, keyed pelo PRIMEIRO argumento. Quando o primeiro arg é objeto/array reference (não primitivo) e o reference é reconstruído por chamada, a Map cresce sem limite. Pior, se a função `memoize`-ada captura state de fora (closure), cada entrada fixa esse state em memória. Auditoria do agent já identificou que `getDeferredToolTokenCount` (`src/utils/toolSearch.ts:125`) tem resolver explícito e está OK; resto não foi auditado.
- **Ganho:** Previne escape silencioso de AppState ou outros state grandes via cache memoize.
- **Abordagem:** Listar todos `= memoize(`, filtrar os que NÃO têm resolver (segundo arg), checar se primeiro arg é primitivo. Para os perigosos, migrar para `memoizeWithLRU` com key-fn explícita.
- **Arquivos:** `src/**` (116 sites — começar pelos `services/api/`, `utils/auth.ts`, `utils/claudemd.ts`)

### 3.12 — Wildcard permission rules (last-match-wins)
- **Esforço:** M (~80 LoC + revisão de UX `/permissions`)
- **Estado:** `tools.allow`/`deny` é all-or-nothing por tool. Sem padrão `bash:rm -rf /* → deny`, `bash:git push → ask`, `bash:* → allow`.
- **Ganho:** Granularidade real para usuários em modo `--auto`. Único item de feature de produto no roadmap.
- **Inspirado em:** OpenCode `permission/evaluate.ts:9-15` (`findLast` sobre regras `{permission, pattern, action}`).
- **Arquivos:** `src/permission/`, `src/commands/permissions/`

### 4.1 — Testes para caminhos críticos
- **Esforço:** L
- **Prioridade:** P0
- **Estado:** Sem testes em `QueryEngine.ts` (core agent loop), `coordinator/`, `grpc/server.ts`, `tools/AgentTool/`, `main.tsx`, `screens/REPL.tsx`, `bridge/`.
- **Ganho:** Reduz risco de regressão silenciosa no core.

### 1.10 — Tool registry membership stability (LSP/MCP/provider/coordinator flips)
- **Esforço:** M
- **Prioridade:** P1
- **Estado:** Após `cc_workload` ser removido (commit `bec0336` + `155e8a7`), o próximo cache-break frequente vem de mudanças de **membership** no array de tools entre turnos da mesma sessão. O sort interno de `assembleToolPool` em `src/tools.ts:343-365` preserva ordem, mas a entrada/saída de tools muda os bytes da seção de tools (que vem após o system prompt no prefixo cacheado). Eventos reais que disparam: (1) **LSP connect** — `getAllBaseTools()` em `src/tools.ts:222` faz `isLspGloballyEnabled() && isLspConnected()` direto no array, então a `LSPTool` entra na lista no momento em que o LSP server termina o handshake; (2) **`/provider` switch** — `WebSearchTool.isEnabled` em `src/tools/WebSearchTool/WebSearchTool.ts:542-562` chama `getProviderMode()`/`getAvailableProviders()`/`isCodexResponsesWebSearchEnabled()`, que mudam ao trocar profile; (3) **MCP server connect/disconnect** — tools MCP entram/saem via `mcpTools` argumento de `assembleToolPool`; (4) **`/coordinator` toggle** — `getTools()` lines 278-281, 289-294 ligam/desligam `TaskStopTool`, `getSendMessageTool()`, `AgentTool`. Bench atual em `scripts/measure-cache-invalidation-budget.ts` mede ~16 334 break tokens (5m discount) por add/remove de 1 tool — confirmado experimentalmente.
- **Ganho:** Cada flip de membership rebila ~16k tokens. Em sessões com LSP ligado tarde (servidor aquece em 2-5s), `/provider` switch para testes, ou MCP servers conectando assincronamente, são vários eventos por sessão.
- **Abordagem:** três opções (avaliar antes do plan):
  1. **Eager-load determinístico** — incluir todas as tools `getAllBaseTools()` retorna independentemente de `isEnabled`, e gate o uso runtime em vez do registry. Schemas idênticos turn-a-turn; LLM "vê" mais tools mas não pode invocar as desabilitadas. Custo: prompt fica ligeiramente maior; tools registradas mas não-funcionais podem confundir o modelo.
  2. **Cache breakpoint após o registry** — acrescentar um `cache_control` breakpoint imediatamente após o array de tools, de forma que mudanças posteriores (mensagens) ainda cacheiam mas tools-section vira "instável" (rebill só dela). Requer entender quantos breakpoints sobram (Anthropic permite 4).
  3. **Estabilizar o subset que muda** — para LSP/MCP especificamente: emitir o slot da tool com schema completo desde o início e flip um campo "available: true/false" interno, mantendo bytes do schema iguais. Pode não funcionar com Anthropic se o servidor descartar tools sem `description` válida.
- **Tests requeridos:** snapshot do `getTools()` array (nomes + schema bytes hash) antes/depois de simular: LSP connect, MCP connect, /provider switch, /coordinator toggle. Falham hoje em todos os 4; passam após o fix.
- **Bench:** estender `scripts/measure-cache-invalidation-budget.ts` com cenários `lsp-connect`, `mcp-connect`, `provider-switch` quantificando o rebill por evento.
- **Arquivos:** `src/tools.ts`, `src/tools/WebSearchTool/`, `src/services/api/claude.ts` (cache breakpoint placement em `splitSysPromptPrefix`).

### 1.11 — Coordinator MCP server list determinístico
- **Esforço:** XS (1 linha + test)
- **Prioridade:** P3 (latente — só morde em sessões coordinator com reconexão de MCP)
- **Estado:** `src/coordinator/coordinatorMode.ts:99-101` faz `mcpClients.map(c => c.name).join(', ')` em ordem de input. A ordem do array vem de async connect timing — não-determinística entre sessões. Quando coordinator mode está ativo, esse texto entra no `getCoordinatorUserContext` que vai pro system context. Hoje é dormente para a maioria dos usuários (coordinator mode é gated por env var). Test source-level já existe em `src/coordinator/coordinatorMode.test.ts` (commit `1597130`) documentando o bug e pronto pra flipar.
- **Ganho:** Marginal em uso normal; protege sessões coordinator de invalidação de cache em reconexões MCP.
- **Abordagem:** `mcpClients.slice().sort((a, b) => a.name.localeCompare(b.name)).map(c => c.name)`. Flipar o test source-level pra `expect(src).toMatch(/\.sort\(/)`.
- **Arquivos:** `src/coordinator/coordinatorMode.ts`, `src/coordinator/coordinatorMode.test.ts`.

### 1.12 — `getMcpInstructions` sort determinístico
- **Esforço:** XS (1 linha + test)
- **Prioridade:** P3 (dormente sob flag default — `isMcpInstructionsDeltaEnabled()` retorna `true` por padrão e o delta path substitui esta seção; só morde se `CLAUDE_CODE_MCP_INSTR_DELTA=0` for setado)
- **Estado:** `src/constants/prompts.ts:516-521` joina `mcpClients` em ordem de input. Wrapper `DANGEROUS_uncachedSystemPromptSection('mcp_instructions', ..., 'MCP servers connect/disconnect between turns')` em `src/constants/systemPromptSections.ts:43` força recompute por turno mas devolve `null` quando delta está ativo (caminho default).
- **Ganho:** Quase zero em uso default. Vale documentar como guard pro caso de o delta path ser desabilitado.
- **Abordagem:** sort por nome antes do filter+join. Adicionar test que falhe quando o sort some.
- **Arquivos:** `src/constants/prompts.ts`.

### 1.13 — `should1hCacheTTL` latch-on documentation
- **Esforço:** XS (comentário + opcional test)
- **Prioridade:** P3 (não é bug, é intentional)
- **Estado:** `src/services/api/claude.ts:414-425` flipa o TTL do cache de 5m para 1h quando o tamanho cumulativo do prompt cruza o threshold pela primeira vez na sessão. É **latch-on / high-water-mark**, não one-shot — uma vez ligado, fica ligado. Causa **um** cache miss por sessão (no primeiro crossing) que é depois amortizado pelo TTL maior. Análise inicial classificou como "one-shot" (errado) → auditor corrigiu pra "latch-on" (correto). Tudo working as intended.
- **Ganho:** Zero código, mas vale um comentário explicando o latch-on no source. Test opcional que asserta o latch (uma vez true, sempre true) protegeria contra refactors que acidentalmente tornassem o flip volátil.
- **Abordagem:** comentário em `claude.ts:414`. Test em `src/services/api/claude.test.ts` (se existir) ou criar `should1hCacheTTL.test.ts` próprio.
- **Arquivos:** `src/services/api/claude.ts`.

---

## Concluídos ✅

### 5.8 — `/clear` agora drena `fileReadCache`; bench corrigido
Bench original alegava que `cache.clear()` "não libera RSS V8". Investigação encontrou duas falhas: (1) `fileReadCache.clear()` **não era chamado em produção em lugar nenhum** — `/clear` (`src/commands/clear/caches.ts`) drenava ~15 caches mas pulava esse, então o sintoma só aparecia em benches sintéticos rodando direto contra o singleton; (2) o bench fazia `gc()` síncrono logo após `clear()` e tirava snapshot — JSC sweep é lazy, não roda na mesma microtask. Bench corrigido amostra heap em t=0/50/250/500 ms: heap volta abaixo do baseline em ~50 ms, RSS solta ~633 MB em ~500 ms. RSS retido depois disso é o alocador (jemalloc/glibc) mantendo páginas livres pra reuso, não leak. Fix: `clearSessionCaches` agora chama `fileReadCache.clear()`; bench mostra trajetória de decay em vez de snapshot único; doc no `clear()` explica semantics. Tentei agendar `gc()` forçado mas o tempo de settle do JSC é dependente do tamanho do heap (50-200+ ms sob churn realista) — delay fixo é frágil; o engine sweepa naturalmente quando há pressão.

Arquivos: `src/utils/fileReadCache.ts`, `src/commands/clear/caches.ts`, `scripts/profile/file-read-cache-saturation-bench.ts`.

### 5.7 — Cap/poda de `QueryEngine.mutableMessages` + REPL React state em sessões longas (26ed91c, 9ab73a9)
`mutableMessages` (`src/QueryEngine.ts:187`) crescia sem cap; tool_results de 50-200 KB ficavam retidos até `/clear`. Wire path já emitia esses como stubs determinísticos (microcompact size-based trigger + `applyStableStubs` em `claude.ts`/`openaiShim`/`codexShim`), mas `applyStableStubs` retornava array NOVO — os blocos originais continuavam vivos em `mutableMessages`. Solução: substituir `mutableMessages = applyStableStubs(mutableMessages)` no início de `submitMessage` e deixar GC reclamar os blocos antigos (commit `26ed91c`).

**Lacuna identificada (commit `9ab73a9`):** o `mutableMessages` do `QueryEngine` era substituído, mas o array `messages` do React state do REPL (`src/screens/REPL.tsx`) — cópia espelhada mantida para scrollback da UI — nunca recebia os stubs. Isso causava crescimento ilimitado do heap mesmo após a 5.7 original: ao longo de uma sessão longa a pressão de GC aumentava até travar o event loop, impedindo que `/clear`, `/compact` e Ctrl+C processassem. Solução: aplicar `applyStableStubs(messagesRef.current)` após cada turno no `onQueryImpl`, antes de `onTurnComplete`, com identity guard que pula o `setMessages` quando `clippedIds` está vazio (fast path para sessões normais).

Bench (200 turns, 100 KB payload/tool): sem correção **~201 KB/turn** → ~39 MB array; com correção **~2.3 KB/turn** → ~467 KB array (~85× redução). os originais. gRPC (`src/grpc/server.ts:201`) aplica a mesma compactação antes de cachear o snapshot cross-stream. Identity-preserving fast-path adicionado em `applyStableStubs` cobre 2 casos no-op (set vazio + set sem matches), pra guard `compacted !== this.mutableMessages` evitar reatribuição em todo turno. Bench (1000 turnos × 50 KB tool_results, 2 tools/turn): array bytes 99.0 MB → 1.4 MB (−98.6%), RSS/turno 220.9 KB → 84.6 KB (−62%). 459 testes provider passam; 3 testes novos em `src/grpc/server.test.ts` + 3 em `stableStubState.test.ts` (identity guard, GC-eligibility, sub-agent isolation).

### 5.5 — Versão do pacote no nome dos chunks em release builds
Investigação inicial mostrou que a premissa original do item (usar `[dir]` para nomear chunks por subdiretório de fonte) era inviável: o token `[dir]` em `naming.chunk` deriva do entrypoint que puxa o chunk, não dos módulos-fonte que o compõem, e como temos só dois entrypoints na mesma pasta (`src/entrypoints/cli.tsx` e `mcp.ts`) o `[dir]` expande pra vazio. Bun nomeia ~213 chunks por módulo dominante (`App-*`, `REPL-*`, `AgentTool-*`...) automaticamente, mas restam ~195 chunks compartilhados que ficam `cli-XXXX.mjs` sem identificação. Solução adotada: gate `naming.chunk` em `CLAUDIO_RELEASE_BUILD=1` (set por `package.json:build:release`) que injeta `${version}` no template — em release o chunk vira `cli-0.1.5-XXXX.mjs`, dando rastreabilidade pra stack traces de produção sem sourcemap. Local builds preservam o nome curto. Teste em `scripts/release-chunk-naming.test.ts` (4 asserts) trava o template + a env var no `package.json`.

### 5.1 — Code-splitting de provider SDKs (Anthropic family externalizados)
Bun estava deduplicando os 3 SDKs Anthropic (`@anthropic-ai/{bedrock,vertex,foundry}-sdk`, ~3.6 MB combinados) em um único shared chunk de 6.1 MB — pulled por todos os branches de dynamic-import em `client.ts`. Externalizados em `scripts/build.ts:541-553` (junto com `@aws-sdk/*`, `@azure/identity`, `google-auth-library` que já eram external). Agora são resolvidos em runtime de `node_modules` em vez de bundlados; nenhum chunk contém mais as classes `AnthropicBedrock|AnthropicVertex|AnthropicFoundry`. Sessões puramente Anthropic native nunca parseiam código de bedrock/vertex/foundry. Guard test em `scripts/provider-sdks-external.test.ts` previne regressão (assert no `external` array + scan dos chunks). Verificado: bundle pré 63 MB / 412 chunks → pós 62 MB / 408 chunks (delta de disco modesto, mas mais relevante: 3.6 MB de código de provider sai do hot-path V8 parse). Smoke + 459 provider tests + verify:privacy passam.

### 5.4 — GC do V8 compile cache (`~/.claudio/v8cache/`)
Sweep lazy de entradas com `mtime > CLAUDIO_V8CACHE_TTL_DAYS` (default 14d) em `scripts/v8cache-gc.mjs`, disparado async pelo `bin/claudio` após `enableCompileCache`. Subdirs de fingerprint (`vNN-x64-<hash>-<uid>`) ficam vazios depois da varredura e também são removidos. Opt-out via `CLAUDIO_V8CACHE_GC=0`. Verificado empiricamente: 14 MB / 622 entradas / 2 fingerprint dirs → 628 KB / 1 dir após uma execução com TTL agressivo. 6 testes em `scripts/v8cache-gc.test.mjs` cobrem TTL boundary, dir cleanup, missing dir, stray files, injeção de `now` para determinismo.

### 2.4 — Gerenciamento de memória em sessões longas (a629290, ff4ee09, f86cca9)
`fileReadCache` ganhou `maxEntryBytes = 256 * 1024` (`src/utils/fileReadCache.ts:21,51`) — alinhado com `MAX_OUTPUT_SIZE` em `file.ts`. Worst-case RSS do cache: ~250 MB em vez de unbounded. `writeTextContent()` (`src/utils/file.ts:98`) chama `fileReadCache.invalidate(filePath)` após cada write, eliminando o risco de stale read entre FileEditTool/FileWriteTool/NotebookEditTool e o próximo Read no mesmo segundo. 11 testes em `fileReadCache.test.ts` cobrem hit/miss/eviction/size-guard/invalidate/clear. Claim original sobre listeners imbalanceados em REPL.tsx era falsa (corrigido na descrição original).

### 5.3a — Bench de cap invariants para caches conhecidos
Bench `scripts/profile/long-session-bench.ts` + invariantes em `src/utils/cacheBoundsInvariants.test.ts` validaram empiricamente que os 5 caches module-level mais quentes respeitam seus caps sob 10k cycles cada. Resultado: total heap delta 5.3 MB (esperado: ~cap × bytes/entry × 5 caches), zero crescimento unbounded. Para cobertura: ver `baselines/long-session.json`. OOM original (4 GB) ficou explicado pelo combo "token threshold alto + V8 heap cap default 4 GB" e foi mitigado pela 5.0; não havia leak per-turn nos containers auditados.

Arquivos: `src/components/markdownTokenCache.ts` (extraído de Markdown.tsx para isolar de React/Ink), `src/components/Markdown.tsx`, `src/utils/queryHelpers.ts`, `src/utils/imageStore.ts`, `src/services/lsp/LSPDiagnosticRegistry.ts` (cada um com getter `__TEST_ONLY_*`), `src/utils/cacheBoundsInvariants.test.ts` (5 testes), `scripts/profile/long-session-bench.ts`, `scripts/profile/baselines/long-session.json`, `scripts/profile/run-all.ts`, `scripts/profile/README.md`, `package.json` (script `profile:long-session`).

### 5.0 — Heap-pressure backup trigger para autocompact (3a67e41, e6aa174, 89bc281)
OOM em sessões longas (relatado: 2h ativas → 4 GB heap → mark-compact infrutífero). Causa: autocompact é triggered por TOKEN count (~967k pra Opus 1M), mas em memória 967k tokens com objetos React/Ink/strings facilmente vira 1-2 GB de heap — V8 estoura o cap default de 4 GB muito antes do token threshold disparar. Três commits:

1. `fix(autocompact): trigger compaction on V8 heap pressure` — adiciona `isAboveHeapPressureThreshold` em `shouldAutoCompact`. Dispara compact quando `used_heap_size / heap_size_limit > 0.7` (configurável via `CLAUDIO_HEAP_PRESSURE_RATIO`). Guarded por `MIN_MESSAGES_FOR_HEAP_TRIGGER=20` pra não compactar sessão recém-aberta.
2. `chore(launcher): bump default V8 heap limit to 8 GB via re-exec` — `bin/claudio` re-exec com `--max-old-space-size=8192` (override `CLAUDIO_MAX_HEAP_MB`, opt-out `CLAUDIO_NO_HEAP_BUMP=1`). Dá margem pro trigger de heap-pressure rodar summary antes do OOM.
3. `perf(memory): hint V8 GC at natural release points` — `globalThis.gc?.()` em `runPostCompactCleanup` e no finally de `runAgent.ts`. Re-exec do launcher agora inclui `--expose-gc` por default.

### 3.6 — Keep-alive por provider (não global)
`let keepAliveDisabled` → `Map<string, boolean>` em `proxy.ts`. `disableKeepAlive(provider)` e `getProxyFetchOptions({ provider })` agora são scoped por provider. Callers atualizados: `withRetry.ts` passa `getAPIProvider()`, `openaiShim.ts` passa a variável `provider` local, `codexShim.ts` passa `'codex'`, `client.ts` passa `'anthropic'`. Test isolado garante que ECONNRESET no DeepSeek não afeta o Anthropic.

### 1.8 — `countTokensViaHaikuFallback` agora usa `countTokens` (free)
`anthropic.beta.messages.create` (cobrava input + 1 output token por chamada de fallback) trocado por `anthropic.beta.messages.countTokens`, que é gratuito e suporta os mesmos parâmetros (thinking, tools, betas) que precisávamos. Test em `tokenEstimation.test.ts` garante que `create` nunca é chamado nesse caminho.

### 1.7 — Remover dead code de ContentType / compression ratios (54ce9a9)
`ContentType`, `COMPRESSION_RATIOS`, `detectContentType()`, `getCompressionRatio()`, `estimateWithBounds()` (~95 linhas) deletados; único caller em `staticDedup.integration.test.ts` agora chama `roughTokenCountEstimation(s, 2)` direto.

### 4.4 — Error boundary real (substituir SentryErrorBoundary) (61d8e5b)
`SentryErrorBoundary` substituído por `ErrorBoundary` real com fallback visível + `logError` em crash. `SentryErrorBoundary.ts` virou re-export de `ErrorBoundary` para manter os 4 callsites sem mudança. Testes em `ErrorBoundary.test.tsx`.

### 4.8 — Renomeado `writeFileSyncAndFlush_DEPRECATED` → `writeFileSyncAndFlush` (9ec5c63)
A deprecação era aspiracional — os 3 callers (config writes, settings writes, file edit writes) são sync por design. Renomear + atualizar jsdoc remove o marcador enganoso sem refactor M-L de propagar async.

### 1.1 — Strip progressivo de thinking blocks (de7b67d)
`stripOldThinkingBlocks()` agora roda em todos os providers, não só Bedrock/Vertex.

### 1.2 — Estimativa de tokens por modelo
`roughTokenCountEstimation()` já usa `getActiveModelBytesPerToken()` memoizado, com `MODEL_TOKENIZER_CONFIGS` cobrindo 19 famílias de modelo. Auditoria descobriu que estava feito mas não marcado.

### 1.4 — Stable-stub tool_result compression (7b6b374, 2e6c638, ed80303, ff59bc3)
Set monotônico per-sessão de tool_use_ids clipados, byte-stable cross-turn. Funciona em Anthropic native, Bedrock, Vertex, OpenAI shim, Codex shim. Permitiu deletar `compressToolHistory.ts` (~1.8k linhas).

### 1.6 — Tabela de preços para modelos não-Claude (163a180)
`NON_CLAUDE_MODEL_COSTS` cobre 30+ patterns (gpt/gemini/deepseek/grok/cohere/phi/...). DeepSeek a $0.14/Mtok não aparece mais como $5/Mtok.

### 1.9 — Estimativa de imagens por provider (14f0416)
Per-provider implementado (Anthropic, OpenAI, Gemini com fórmulas próprias).

### 3.11 — `retry-after-ms` + HTTP-date no `Retry-After` (3dace3a)
`parseRetryAfterValue` aceita integer/decimal seconds + RFC 7231 HTTP-date. `getRetryAfterMs` prefere `retry-after-ms` (extensão Anthropic/OpenAI) sobre `retry-after`. 21 testes.

---

## Oportunidades — pesquisa de comunidade (2026-05-01)

> Fonte: GitHub issues, HN, Reddit (r/LocalLLaMA, r/ClaudeAI), RedMonk, Stack Overflow Survey 2025, JetBrains 2025.  
> Ainda não priorizados; listados para avaliação de ROI.

| ID | Feature | Esforço est. | Evidência |
|----|---------|-------------|-----------|
| C1 | **AGENTS.md** — ler `.agents/skills/` além de `.claude/skills/` | XS | 3 000+ upvotes anthropics/claude-code#31005; Cursor, Codex, Amp já suportam; Anthropic parada há 7+ meses |
| C2 | **Hidden CLAUDE.md** — aceitar `.claude/CLAUDE.md` como fallback | XS | anthropics/claude-code#54183; mudança mínima de lookup |
| C3 | **Custo inline por turno** — `$0.xx` no status bar em tempo real | S | 66% dos devs citam custo imprevisível como bloqueador; `/cost` existe mas não é inline |
| C4 | **Local-first UX** — wizard de setup Ollama + docs proeminentes | S | Ollama já funciona; r/LocalLLaMA (266k membros) busca ativamente isso |
| C5 | **Issue tracker via MCP** — bundles pré-configurados GitHub Issues + Linear no `/provider` | M | anthropics/claude-code#10998; "implement issue #64" sem copy-paste |
| C6 | **`/spec <file>`** — pinar requirements.md ao contexto que sobrevive à compactação | M | Devs querem requirements como fonte de verdade cross-compaction |
| C7 | **Session rollback / checkpoint** — `/rewind` equivalente sem precisar de git | M | Claude Code tem `/rewind`; Zed tem restore por edição; Claudio não tem nada |
| C8 | **Wildcard permission rules** | M | Já em roadmap ativo como 3.12 — mencionado aqui por correlação com C9 |
| C9 | **Sandboxing / least-privilege** — scoping de permissão por tool/agente | L | 30+ CVEs em AI coding tools; prompt injection via MCP (CVE-2025-61260) |
| C10 | **Multi-agent dashboard** — progresso de agentes paralelos visível | L | RedMonk #5 de 10 necessidades agentic IDE; coordinator mode existe mas sem UI de visibilidade |

---

## Removidos da auditoria

**Já feitos (movidos para Concluídos):** 1.2, 1.6.

**Bug do roadmap:** 2.6 e 4.6 eram o **mesmo item duplicado** ("preprocessamento de feature flags") em pilares diferentes — removidos. SIGINT/SIGTERM já tratado no `build.ts`; SIGKILL é raro o bastante para aceitar `git checkout --`.

**Premissa falsa:**
- **3.5** (rate-limit headers Bedrock/Vertex/Gemini) — esses providers **não emitem** `x-ratelimit-reset-*`. Bedrock usa AWS SDK error metadata, Gemini usa `RetryInfo` em gRPC details. Não é "estamos ignorando", é "não existe pra ignorar". Escopo real >> M.
- **5.9** (lazy registry de tools em `tools.ts`) — desclassificada após bench empírico em 2026-05-04. Premissa original era "dezenas de MB de retained code+ICs". Bench (`scripts/profile/cold-start-retained-bench.ts` com 14 probes per-candidate, baseline em `baselines/cold-start-retained.json`) mostrou que TODOS os candidatos puxam ~30 MB de heap idêntico via stack transitiva compartilhada (Tool.ts + zod + ink + prompt helpers). Delta do módulo próprio do tool é <1 MB cada — única exceção foi AskUserQuestionTool (13 MB vs 30 MB, único que não puxa a stack completa). Ganho real estimado: 3-5 MB total no melhor caso, não dezenas. Adicionar isso justifica o custo de Proxy traps + audit de cross-imports + refactor de identity-checks em `PermissionRequest.tsx`. Roadmap-killer: dois reviews independentes (Plan agent) também identificaram bloqueadores (identity comparisons quebram com Proxy, no-Suspense em REPL, memo cache do react-compiler). Os 4 testes escritos durante a investigação (`src/__tests__/lazyToolImports.test.ts`, `src/__tests__/lazyToolModuleLoad.test.ts`, `src/components/permissions/PermissionRequest.test.ts`, e os probes adicionais no `cold-start-retained-bench.ts`) ficam como guarda — `lazyToolImports` previne re-eagerização acidental de tools que hoje só são importados por `tools.ts`, e `PermissionRequest.test` trava drift entre `tool.name` e a constante NAME exportada.

**Parcialmente cobertos por código existente:**
- **3.1** (resposta parcial em streaming) e **3.8** (timeout configurável) — `STREAM_IDLE_TIMEOUT_MS` já existe em `claude.ts:1840`, configurável via env, com warning intermediário. Resume-from-checkpoint é caro de implementar (L) para ganho marginal.

**Overengineering / ganho hipotético:**
- 1.3 (redução de tool schemas) — vai pra cache 1h; ganho só nos misses
- 1.5 (threshold cache 8k→4k) — sessões reais já passam de 8k logo
- 1.10 (filtragem dinâmica de tools) — Cron/Worktree custam <300 tokens cada
- 2.1 (defer imports main.tsx) — Anthropic-internal já são stubs no-op
- 2.2 (bundle 21MB) — Node parseia em <100ms
- 2.3 (decompor REPL.tsx) — feio mas funciona
- 2.5 (sync I/O 530 calls) — quase todas em bootstrap, ganho zero
- 2.7 (cache CWD) — 1ms total, abaixo do ruído
- 2.8 (Yoga layout) — sem evidência de gargalo
- 3.2 (failover cross-provider) — UX manual via `/provider` é aceitável
- 3.3 (hardening gRPC) — uso nicho, sem demanda
- 3.4 (retry por provider) — curva única funciona
- 3.9 (classificação erros) — catch-all >=408 raramente erra
- 3.10 (OAuth refresh async) — refresh raro, bloqueio invisível
- 3.13 (protected paths TCC) — usuários macOS já têm TCC OS-level
- 4.2 (decompor arquivos gigantes) — manutenibilidade pura, sem ganho funcional
- 4.3 (eliminar double casts) — refactor preventivo, código funciona
- 4.5 (limpeza TODOs) — cosmético
- 4.7 (validação schema settings.json) — settings.json editado quase só via `/provider`

---

## Total

**9 ativos** (2× P0: **7.0**/4.1; 1× P1: 6.2-Windows; 2× P1: 5.10/5.11; 3× P3: 5.2/5.3b/5.1b; +3.12 sem prio) + **20 concluídos** (6.1 incl. 6.1.9 + 6.2 Linux side). 5.9 desclassificada por bench empírico — ver "Premissa falsa" em Removidos.

**7.0 — `/autofix-pr`** concluído em 2026-05-15 (P0 entregue). **Próxima entrega:** revisar próximo P0 do backlog. 6.1 — Command-aware bash output filter concluído em 2026-05-13 (9 fases, ~2.340 LoC). Filtro ativo por default, toggle em `/config`, tip de performance. Ganho medido: top 10 comandos com 50-98% redução de output, ~50k tokens economizados por sessão típica de 30min, ~72% redução de custo input. **6.1.9 — System utilities** concluído em 2026-05-13: 10 specs (ping/rsync/tree/ssh/df/du/dmesg/stat/jq + curl-plain), 41 filtros totais, agregado **69.9%** redução medido em fixture corpus de 200.6 KB. **6.2 — Tier-1 follow-ups (Linux)** concluído em 2026-05-09: 8 specs (jest/vitest/bun-test/mocha/playwright + tsc + git-diff/show). Sub-fase Windows/PowerShell em aberto.
