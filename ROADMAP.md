# Roadmap — Claudin

Itens priorizados por ROI (ganho / esforço). Atualizado em 2026-05-29.

Convenção: cada item tem **Arquivo**, **Problema**, **Ganho**, **Esforço**, **Risco** e checkbox de status.

---

## Tier 1 — Quick wins (esforço baixo, risco baixo)

### [x] 1. Regex em escopo de módulo
- **Arquivos:** `src/services/api/providerConfig.ts:237-240,295,362,395,566`, `src/services/api/withRetry.ts:63`, `src/services/api/cacheMetrics.ts:147-152,526-527`
- **Problema:** Regex compilada dentro de funções em hot path. Viola `.claudin/rules/typescript-patterns.md`.
- **Ganho:** baixo (CPU) — **Esforço:** trivial — **Risco:** nenhum.

### [x] 2. Paralelizar dynamic imports do startup
- **Arquivo:** `src/entrypoints/cli.tsx`
- **Problema:** Imports dinâmicos sequenciais no boot; vários são independentes.
- **Ganho:** médio (cold start visível) — **Esforço:** baixo — **Risco:** baixo (preservar ordem onde houver dep).

### [x] 3. Cache de `isEnabled()` por tool
- **Arquivos:** `src/tools.ts:179-249`, consumido em `src/screens/REPL.tsx:703`
- **Problema:** `useMemo` invalida por turn e escaneia ~30 tools chamando `isEnabled()` (toca env/config/flags).
- **Ganho:** médio — **Esforço:** baixo (invalidação por evento de config) — **Risco:** baixo.

### [ ] 4. Imports relativos → alias `src/...`
- **Arquivo:** `src/services/api/openaiShim.ts:26-34` (8 imports)
- **Problema:** Viola regra do projeto; quebra em moves.
- **Ganho:** manutenibilidade — **Esforço:** trivial — **Risco:** nenhum.

### [ ] 5. `any` → `unknown` + guard em `isQuotaExhausted`
- **Arquivo:** `src/services/api/withRetry.ts:109`
- **Problema:** `any` no hot path de retry, sem type safety.
- **Ganho:** correção / segurança de tipos — **Esforço:** trivial — **Risco:** baixo.

---

## Tier 2 — Alto impacto (esforço médio, payoff grande)

### [ ] 7. Delta-write no `recordTranscript`
- **Arquivo:** `src/QueryEngine.ts:733-762`
- **Problema:** Re-serializa array inteiro de mensagens por content block do stream — N×M.
- **Ganho:** alto em sessões longas — **Esforço:** médio — **Risco:** médio (resume/recovery depende do formato).

### [ ] 8. `WeakMap` cache para `JSON.stringify(tu.input)` na conversão
- **Arquivo:** `src/services/api/openaiShim.ts:585-589`
- **Problema:** Re-stringify de tool_use inputs a cada conversão; escala com histórico × tool calls.
- **Ganho:** médio — **Esforço:** baixo — **Risco:** baixo.

### [ ] 9. Write-coalescing no `void recordTranscript`
- **Arquivo:** `src/QueryEngine.ts:760`
- **Problema:** Fire-and-forget enfileira closures retendo referência ao `messages` (cresce a cada bloco) — pressão de GC.
- **Ganho:** médio — **Esforço:** médio — **Risco:** médio (durability/resume).

### [ ] 10. Extrair `tryParseMailboxMessage<T>` (7 `catch {}` duplicados)
- **Arquivo:** `src/services/teammateMailbox.ts` (a partir da linha 438)
- **Problema:** Padrão repetido de `catch {}` engole diagnóstico; viola regra "no silent error swallow".
- **Ganho:** robustez — **Esforço:** baixo — **Risco:** baixo.

---

## Tier 3 — Saúde estrutural (PRIORIDADE — quebra de arquivos gigantes)

> Promovido a prioridade em 2026-05-17: arquivos acima de ~3k linhas estão virando gargalo de navegação, review e onboarding. Ordem proposta abaixo segue ROI/risco (utils primeiro, raízes Ink por último).

### [x] 11a. Split de `src/utils/messages.ts` (5.711 linhas, 198 KB)
- **Sugestão:** separar por responsabilidade — normalização, serialização, content-block helpers, render helpers, pricing/usage.
- **Ganho:** alto (util compartilhado em todo lugar) — **Esforço:** alto — **Risco:** médio (alto reuso → muitos call sites).

### [x] 11b. Split de `src/cli/print.ts` (5.559 linhas, 206 KB) — parcial
- Caracterização (26 testes) + split em 11 módulos sob `src/cli/print/`: `promptBatching`, `uuidDedupe`, `structuredIOFactory`, `orphanPermission`, `permissionGlue`, `controlHandlers`, `initHandler`, `mcpReconcile`, `messageOps`, `sessionLoad`, `runHeadless`. `print.ts` vira barrel de 50 linhas. A sugestão original ("formatters, stream renderers, json/text emitters") não se aplicava — toda emissão vive em `StructuredIO`/`RemoteIO`; split foi por responsabilidade do driver headless.
- **Deferido para 11c**: extração de `runHeadlessStreaming` em arquivo próprio com DI explícita (`HeadlessStreamingDeps`). Hoje vive em `runHeadless.ts` (4.094 linhas) capturando estado por closure léxica.

### [x] 11c. Split de `src/utils/sessionStorage.ts` (5.361 linhas, 183 KB)
- **Sugestão:** dividir em `{persistence, resume, indexing, migrations}`.
- **Ganho:** alto — **Esforço:** alto — **Risco:** médio (formato em disco; cobertura por snapshot antes).

### [x] 11d. Split de `src/utils/hooks.ts` (5.210 linhas, 161 KB)
- **Sugestão:** um arquivo por tipo de hook (PreToolUse, PostToolUse, UserPromptSubmit, etc.) + core runner.
- **Ganho:** alto — **Esforço:** médio-alto — **Risco:** baixo (fronteira clara).

### [x] 11e. Split de `src/screens/REPL.tsx` (5.015 → 4.261 linhas)
- **Sugestão:** extrair subcomponentes (input, transcript, status bar, overlays) e custom hooks.
- **Ganho:** alto — **Esforço:** alto — **Risco:** **alto** (cuidar de React identity — ver memória team `<Activity>`).
- Cluster `src/screens/repl/` com leaves UI (`TranscriptModeFooter`, `TranscriptSearchBar`, `AnimatedTerminalTitle`), utils (`median`, `getFocusedInputDialog`), hooks (`useReplExit`, `useReplLifecycle`), service (`resumeSession`), e subviews (`REPLTranscriptView`, `REPLStatus`, `REPLDialogs`). REPL.tsx mantém controllers (`onSubmit`/`onQuery*`) e composição. Cobertura: 6 baselines snapshot + harness em `src/screens/__testutils__/replTestHarness.ts` (15 snapshots estáveis através do split). Controllers ficam para um trabalho futuro.

### [x] 11f. Split de `src/utils/bash/bashParser.ts` (4.436 linhas, 128 KB)
- **Sugestão:** separar tokenizer, AST, validators, command-detection tables.
- **Ganho:** médio-alto — **Esforço:** médio — **Risco:** baixo (puro, testável).

### [x] 11g. Split de `src/main.tsx` (4.379 linhas, 212 KB)
- **Sugestão:** extrair parsing de CLI args, montagem do app Ink, signal handlers, lifecycle.
- **Ganho:** alto — **Esforço:** alto — **Risco:** alto (entrypoint; muitos side effects no boot).

### [x] 11h. Split de `src/utils/attachments.ts` (4.346 linhas, 138 KB)
- **Sugestão:** dividir por tipo (image, pdf, text, paste) + pipeline comum.
- **Ganho:** médio — **Esforço:** médio — **Risco:** baixo.

### [x] 11i. Split de `src/services/mcp/client.ts` (3.366 linhas, 117 KB)
- **Sugestão:** transporte (stdio/sse/http) separado de gerenciamento de servidor/sessão.
- **Ganho:** médio — **Esforço:** médio — **Risco:** médio (protocolo MCP; testes de integração).
- **Concluído:** barrel `client.ts` + `client/{errors,authCache,fetch,transport,connection,toolResult,callTool,fetchCapabilities,ide,sdkClients}.ts`. Testes de regressão em `client.regression.test.ts`.

### [x] 11j. Split de `src/services/api/claude.ts` (3.218 linhas, 117 KB)
- **Sugestão:** isolar request builder, response parser, streaming, retries.
- **Ganho:** médio — **Esforço:** médio — **Risco:** médio (hot path do provider Anthropic).
- **Concluído:** barrel `claude.ts` + `claude/{types,cacheControl,paramBuilders,metadata,messageConverters,nonStreaming,nonStreamingRequest,streaming,convenience}.ts`. `queryModel` mantido íntegro em `streaming.ts` (decomposição interna fica como follow-up futuro). `cacheControl.ts` e `nonStreamingRequest.ts` extraídos como módulos folha para quebrar ciclos (`paramBuilders↔messageConverters` e `streaming↔nonStreaming`). Testes de regressão em `claude/__tests__/regression.test.ts`.

### [x] 11k. Split de `src/services/api/openaiShim.ts` (2.275 linhas)
- **Concluído:** barrel `openaiShim.ts` + `openaiShim/{constants,types,helpers,headers,providerModes,urlRedaction,messageConverter,toolConverter,streamParser,messagesClient}.ts`. Surface pública intacta (`createOpenAIShimClient`, `convertTools`). `_doOpenAIRequest` (~570 linhas) mantido íntegro em `messagesClient.ts` — decomposição interna (`bodyBuilder`/`requestRunner`) fica como follow-up se necessário, igual ao padrão 11j. Asserts text-based em `bugfixes.test.ts` migrados na fase 3.

### [—] 11l. `src/bridge/bridgeMain.ts` (2.975 linhas) — **adiado**
- Vive sob `feature('BRIDGE_MODE')` desabilitado no build aberto. Refatorar não tem payoff em runtime atual.

### [—] 11m. `src/utils/ansiToPng.ts` (334 linhas, 210 KB) — **não refatorar**
- Tamanho vem de assets/fontes embutidas em base64, não de lógica. Quebrar não reduz nada.

### [ ] 12. Cobertura de testes para `src/QueryEngine.ts`
- **Arquivo:** `src/QueryEngine.ts` (1.346 linhas, **sem `.test.ts` colocalizado**)
- **Problema:** Coração do agent loop sem cobertura unitária.
- **Ganho:** alto — **Esforço:** alto — **Risco:** baixo.

### [x] 13. Cobertura de tools sem teste
- **Coberto:** Task* (6), PlanMode (2), Worktree (2), MCP (4), Cron + Monitor (4), Team mem (2), Glob, Config, ToolSearch, AskUserQuestion, Brief, NotebookEdit, SendMessage, SyntheticOutput — 26 tools, 229 tests, 488 expects.
- **Restante:** `PowerShellTool` (Windows-only, será tracked à parte). `WebSearchTool`/`WorkflowTool`/`SkillTool` já tinham testes.
- **Ganho:** alto — **Esforço:** alto — **Risco:** baixo.

### [ ] 14. Reconciliar doc vs código sobre flag `--provider`
- **Arquivos:** `CLAUDE.md` diz removido; `src/main.tsx:992` ainda enumera providers.
- **Ganho:** clareza — **Esforço:** baixo — **Risco:** baixo.

### [ ] 15. `checkAutoModeClassifierPrompts()` deveria falhar, não apenas warn
- **Arquivo:** `scripts/build.ts`
- **Problema:** Se `TRANSCRIPT_CLASSIFIER=true` e `.txt` faltar, auto-mode cai silenciosamente para auto-allow. **Risco de segurança.**
- **Ganho:** segurança — **Esforço:** baixo — **Risco:** baixo.

---

## Tier 4 — Novas capacidades

### [x] 16. Smart Code Navigation (folded file views)
- **Arquivos:** `src/tools/shared/codeOutline/scanSymbols.ts` + `renderOutline.ts` (novos), `src/tools/FileReadTool/` (params `view`/`symbol`, variante de saída `outline`, caminho over-cap), `src/tools/GrepTool/` (`output_mode: 'symbols'`), `scripts/profile/code-outline-bench.ts` (bench).
- **Problema:** `Read` em arquivo acima dos caps (256 KB / 2000 linhas / ~25k tokens) só tem duas saídas, ambas ruins — throw "use offset/limit" (~100 bytes, modelo cego) ou truncar no cap (~25k tokens). Experimento upstream #21841 (Mar 2026) já testou e reverteu a truncagem; ver `limits.ts:9-13`.
- **Solução:** uma primitiva `scanSymbols` alimenta três vistas — `outline` (esqueleto de assinaturas, ~1-2k tokens), `unfold` (corpo de um símbolo), `search` (símbolos casados cross-file). Enxertadas em `Read`/`Grep`, sem tool nova e sem dependência (depth-scanner com masking de strings/comentários/regex; tree-sitter fica para v2 só se necessário). Fail-open: degrada para `Read`/`Grep` normal.
- **Ganho:** alto — bench `profile:code-outline` mede ~10k vs ~391k tokens no fluxo típico de "uma função de arquivo grande" (~97% economizado) — **Esforço:** médio — **Risco:** baixo (caminho over-cap hoje já é erro).
- **Entrega:** sem feature flag (toda a fonte está no repo); entregue na branch `feat/smart-code-navigation`. Fase 1 — `scanSymbols`/`renderOutline` + params `view`/`symbol` + auto-outline no over-cap. Fase 2 — `GrepTool output_mode: 'symbols'`.
- **Doc:** [docs/features/7.1-smart-code-navigation.md](docs/features/7.1-smart-code-navigation.md)

---

## Tier 5 — Insights do discovery ohmypi

> Adicionado em 2026-05-25. Síntese de 3 ondas de análise (insight → deep-dive → fit → gap) comparando `oh-my-pi` com Claudin. Cada item aponta para o doc de estudo mais profundo (preferindo `gap/` quando ele revisa o original, depois `fit/`, depois raw).
>
> Convenção: priorização cross-ondas — as melhores ideias vieram dos `gap/`, não dos insights originais.

### Sub-tier 5.A — P0 (alto valor, esforço médio)

#### [x] T5.1 LSPTool write-ops (rename, code_actions, rename_file)
- **Problema:** `src/tools/LSPTool/schemas.ts:14-166` só tem read-ops. "Rename amplo" hoje cai em `FileEditTool` com string match frágil.
- **Ganho:** alto — resolve a maior dor que motivaria AstEditTool, **sem WASM, sem dep nova**, aproveitando LSP já conectado.
- **Esforço:** médio — **Risco:** baixo (LSP devolve workspace edit pronto, só aplicar).
- **Doc:** [docs/discovery/ohmypi/gap/07-tree-sitter-ast-edits.md](docs/discovery/ohmypi/gap/07-tree-sitter-ast-edits.md)

#### [x] T5.2 Late LSP diagnostics injection
- **Problema:** Diagnostics que chegam **depois** do tool result já ter retornado não entram no histórico do modelo. Usuário tem que apontar o erro.
- **Ganho:** alto — 80% da infra já existe (`src/services/lsp/diagnosticsForToolResult.ts`, `awaitDiagnosticsForFile.ts`, `diagnosticTracking.ts`); falta canal `queueDeferredMessage` entre turnos em `QueryEngine.ts`.
- **Esforço:** baixo-médio — **Risco:** baixo.
- **Doc:** [docs/discovery/ohmypi/gap/04-report-tool-issue.md](docs/discovery/ohmypi/gap/04-report-tool-issue.md) §6

#### [ ] T5.3 Checkpoint/Rewind tool (sandbox cognitivo)
- **Problema:** Sem mecanismo para investigação especulativa **model-callable**: dead-ends entram no histórico e causam drift de contexto em sessões longas. O usuário já tem `/rewind` (slash command em `src/commands/rewind/index.ts`, alias `checkpoint`), mas o modelo não consegue se "rebobinar" sozinho após uma exploração.
- **Proposta (Opção A — reuso):** Expor a semântica de `/rewind` como tool model-callable atrás de flag `CHECKPOINT_REWIND`, **reusando** `rewindConversationTo` (`src/screens/REPL.tsx:3218-3264`) + `recordContextCollapseSnapshot` (`src/utils/sessionStorage/persistence/record.ts:204`) para JSONL persistence. Dois tools:
  - `CheckpointTool({ goal })` → snapshot leve (índice `mutableMessages` + `fileHistoryMakeSnapshot` em `src/utils/fileHistory.ts:198` para co-rewind de arquivos opcional). `isReadOnly: () => true` para compor com plan-mode hard-gate (mesmo truque de `EnterPlanModeTool.ts:73-75`).
  - `RewindTool({ checkpointId, report })` → dispara o path de `compact_boundary` (precedente exato em `QueryEngine.ts:962-987`) com `trigger='checkpoint_rewind'`, marca JSONL via `recordContextCollapseSnapshot`, injeta o `report` consolidado como única mensagem sobrevivente do intervalo.
- **Ganho:** alto — modelo explora livre + descarta + só relatório consolidado entra. JSONL/SDK/UI plumbing vem de graça do `compact_boundary`. `--resume` se comporta corretamente (snapshot já marca prefixo como arquivado).
- **Esforço:** baixo-médio — **Risco:** baixo. Sem novo path de mutação em `messages[]`; reusa o de `compact_boundary` (`:956-957`, `:971-977`).
- **Gotchas explícitos (não cobertos no doc original):**
  - `applyStableStubs` (`QueryEngine.ts:253-255`) pode substituir `mutableMessages` entre user turns → `checkpointId` só é válido dentro do mesmo `submitMessage`. Invalidar checkpoints em transição de turn.
  - Top-level only: checar `ctx.agentId` em `src/Tool.ts:259` (precedente em `EnterPlanModeTool.ts:80-82`). Sub-agents (AgentTool spawns) rejeitam o tool.
  - Cowork/coordinator (`src/coordinator/`): rewind precisa rejeitar quando `isCowork`, ou estado distribuído dessincroniza.
  - Reconciliar com `HISTORY_SNIP` + `src/services/compact/snipCompact.ts` (stub meio-planejado) — Checkpoint/Rewind não deve duplicar.
- **Não-objetivos:** não reimplementar `/rewind` UI; não modelar como CRDT/multi-checkpoint stack na v1 (single most-recent checkpoint).
- **Doc:** [docs/discovery/ohmypi/gap/04-report-tool-issue.md](docs/discovery/ohmypi/gap/04-report-tool-issue.md) §2 (proposta original — reescrita acima usa Opção A do estudo de fit)

#### [ ] T5.4 BM25 tool gating em providers OpenAI-compat
- **Problema:** `src/services/api/openaiShim.ts` não tem equivalente de `defer_loading` da Anthropic — manda **todo schema sempre** (~18.384 tokens/turno medidos, 30 tools). Cauda longa de 27 deferred = ~11.948 tokens (~65%).
- **Ganho:** alto — **30-55% redução de input tokens/turno** em DeepSeek/Groq/OpenRouter/Codex/Ollama. Topologia "deferred + search" já existe; falta substituir ranking linear por BM25 + wire para non-1P.
- **Esforço:** médio (3 PRs propostos, flag `BM25_TOOL_GATING`) — **Risco:** baixo.
- **Doc:** [docs/discovery/ohmypi/fit/01-bm25-tool-gating.md](docs/discovery/ohmypi/fit/01-bm25-tool-gating.md) + [docs/discovery/ohmypi/gap/01-bm25-tool-gating.md](docs/discovery/ohmypi/gap/01-bm25-tool-gating.md)

#### [ ] T5.5 3 quick wins AST sem tree-sitter no FileEditTool
- **Problema:** `replace_all` estraga docstrings; ambiguidade de match em arquivos grandes; rename de import quebra.
- **Ganho:** ~70% da dor do "AstEditTool" sem dep WASM. Três adições:
  - `add_import` helper TS puro
  - `scope_hint` no `FileEditTool` (desambiguação)
  - `skip_comments_and_strings` flag em `replace_all`
- **Esforço:** baixo cada — **Risco:** baixo.
- **Doc:** [docs/discovery/ohmypi/fit/07-tree-sitter-ast-edits.md](docs/discovery/ohmypi/fit/07-tree-sitter-ast-edits.md)

#### [ ] T5.6 Cinco prompts cirúrgicos para `.md` (após hardening)
- **Problema:** Loader `.md` em `scripts/build.ts:397-431` é subaproveitado (só `src/skills/bundled/` usa). Stub silencioso `export default ''` mascara typos.
- **Ganho:** diff readability + ~10-15% LOC nos 5 prompts mais estáticos.
- **Pré-requisito:** trocar stub silencioso por erro fatal.
- **Candidatos:** `TeamCreateTool/prompt.ts`, `ToolSearchTool/prompt.ts`, `TodoWriteTool/prompt.ts`, `exploreAgent.ts`, `planAgent.ts`.
- **Esforço:** baixo — **Risco:** baixo.
- **Doc:** [docs/discovery/ohmypi/fit/03-prompts-as-md.md](docs/discovery/ohmypi/fit/03-prompts-as-md.md)

#### [ ] T5.7 `prompt.format` + CI check (sem engine)
- **Problema:** Sem convenção uniforme em `.claudin/rules/*.md` e skills — `**MUST**` vs `NEVER`, ASCII triplo-ponto vs `…`, etc.
- **Ganho:** linter de prompt cross-projeto. ~150 LOC port (subset `normalizeRfc2119` + `replaceAsciiSymbols`), zero dep Handlebars.
- **Esforço:** baixo — **Risco:** nenhum (fail-open).
- **Doc:** [docs/discovery/ohmypi/gap/03-prompts-as-md.md](docs/discovery/ohmypi/gap/03-prompts-as-md.md) §3.2

### Sub-tier 5.B — P1 (condicional, médio retorno)

#### [ ] T5.8 MCP tool-list cache (30d + config-hash)
- **Problema:** `src/services/mcp/client/authCache.ts:6,29` cobre só "needs auth". **Não existe cache de tool-list/schema MCP** — cada reconexão paga schema fetch.
- **Ganho:** médio — cold-start MCP fica instantâneo; reconexões em sessão longa não pagam mais nada.
- **Esforço:** baixo (SHA-256 estável do config como invalidation key).
- **Doc:** [docs/discovery/ohmypi/gap/02-two-tier-ttl-cache.md](docs/discovery/ohmypi/gap/02-two-tier-ttl-cache.md) §1.3

#### [x] T5.9 WebFetch in-memory contadores + soft/hard TTL
- **Problema:** `WebFetchTool` hoje é fresh-or-miss (LRU 15min). Re-visita paga ~1.5-3s + 5-15k input tokens (chamada Haiku de summarização).
- **Ganho:** médio — sem persistência em disco na v1 (privacidade), só instrumentação.
- **Esforço:** baixo — **Risco:** baixo. Medir hit-ratio antes de estender pra disco.
- **Doc:** [docs/discovery/ohmypi/fit/02-two-tier-ttl-cache.md](docs/discovery/ohmypi/fit/02-two-tier-ttl-cache.md)
- **Extensão:** infra extraída pra `src/tools/shared/twoTierCache.ts` e aplicada também no `WebSearchTool` (paths adapter + codex, modo no-stale, TTL 60s). Native streaming fica fora. Plano: `~/.claudin/plans/immutable-giggling-oasis.md`.

#### [x] ~~T5.10 Prefix-invalidation triggers em `toolResultCache`~~ — **descartado (já implementado)**
- Validação 2026-05-27: `toolExecution.ts:1245` já chama `invalidateCacheForWrite` após cada tool; dispatcher em `:1762-1779` cobre `FileEditTool`/`FileWriteTool`/`NotebookEditTool` (→ `invalidateForPath`) e `BashTool`/`PowerShellTool` (→ `invalidateAll`). `LSPTool/workspaceEdit.ts` também invalida em rename/edit. `invalidateForPath` faz prefix-match bidirecional (`toolResultCache.ts:150-164`) → write em vizinho derruba Grep/Glob cacheado. Testes em `toolResultCache.test.ts:108-128`. A premissa do roadmap (linha `:63` só checa mtime do próprio file) estava errada: `:63` é o construtor do LRU; o mtime self-check (`:92-105`) só roda pra `Read`.

#### [ ] T5.11 `report_tool_issue` JSONL local-only
- **Problema:** `isError` propaga em 15 arquivos sem coleta agregada; zero sinal estruturado de bugs de tool.
- **Ganho:** médio — feedback loop interno (especialmente filter / plan mode / openai shim).
- **Storage:** JSONL append-only em `~/.claudin/projects/<dir>/tool-issues/YYYY-MM.jsonl` (fora do scan de memdir, que só ingere `.md`).
- **Esforço:** ~300-500 LOC — **Risco:** baixo (gate `REPORT_TOOL_ISSUE` default OFF; settings checked-in liga só pro próprio repo — dogfooding).
- **Doc:** [docs/discovery/ohmypi/fit/04-report-tool-issue.md](docs/discovery/ohmypi/fit/04-report-tool-issue.md)

#### [ ] T5.12 Reviewer structured findings (confidence + priority)
- **Problema:** `src/commands/review/` e `/security-review` não retornam output estruturado nem confidence scoring.
- **Ganho:** médio-alto — viabiliza filtros por priority P0-P3 e batch review.
- **Esforço:** médio — schema zod com `confidence: number(0-1)`, `priority: enum`, `findings[]` com line ranges.
- **Doc:** [docs/discovery/ohmypi/gap/04-report-tool-issue.md](docs/discovery/ohmypi/gap/04-report-tool-issue.md) §3

#### [ ] T5.13 Worker pool + Semáforo nos sub-agents
- **Problema:** `AgentTool` paralelo usa `Promise.all` sem cap; N sub-agents saturam CPU/memória.
- **Ganho:** médio — estabilidade em coordenador multi-agent (`COORDINATOR_MODE`).
- **Esforço:** baixo — semáforo simples.
- **Doc:** [docs/discovery/ohmypi/gap/08-cow-isolation.md](docs/discovery/ohmypi/gap/08-cow-isolation.md) §1

#### [ ] T5.14 Memories pipeline 2-stage em `.md`
- **Problema:** `src/services/extractMemories/prompts.ts` tem 7944 chars com 16 interpolações em `.ts`. Diff/review pesado.
- **Ganho:** baixo-médio — só vale após T5.6 (loader hardening) e T5.7 (formatter).
- **Esforço:** médio — pipeline `{consolidation,extract,stage1-system,stage1-input}.md`.
- **Doc:** [docs/discovery/ohmypi/gap/03-prompts-as-md.md](docs/discovery/ohmypi/gap/03-prompts-as-md.md) §3.1

### Sub-tier 5.C — Quick wins (esforço pequeno, sem risco)

#### [ ] T5.15 Terminal breadcrumb (auto-resume por tty)
- **Problema:** Resume sem id por terminal não existe; usuário tem que escolher na lista.
- **Ganho:** DX — `~/.claudin/projects/<dir>/breadcrumbs/<tty-hash>.txt` com último session id.
- **Esforço:** ~50 LOC — **Risco:** nenhum (aditivo, sem schema change).
- **Doc:** [docs/discovery/ohmypi/gap/05-cas-blob-store.md](docs/discovery/ohmypi/gap/05-cas-blob-store.md) §1 (Terminal breadcrumb)

#### [ ] T5.16 Draft persistence (Ctrl+C buffer + restore)
- **Problema:** Ctrl+C no REPL com texto digitado descarta a entrada.
- **Ganho:** DX — sidecar `draft.txt` no dir da sessão; single-shot read+unlink no resume.
- **Esforço:** pequeno — **Risco:** baixo.
- **Doc:** [docs/discovery/ohmypi/gap/05-cas-blob-store.md](docs/discovery/ohmypi/gap/05-cas-blob-store.md) §1 (Draft persistence)

#### [ ] T5.17 `titleSource: user|auto` no header
- **Problema:** `extractMemories`/auto-title pode sobrescrever um título manual.
- **Ganho:** trivial — 1 bool no header impede overwrite.
- **Esforço:** trivial — **Risco:** nenhum.
- **Doc:** [docs/discovery/ohmypi/gap/05-cas-blob-store.md](docs/discovery/ohmypi/gap/05-cas-blob-store.md) §1 (titleSource)

#### [ ] T5.18 IRC dedupe (anti-loop em streaming)
- **Problema:** Modelos OpenAI-compat ocasionalmente loop em uma linha repetida N×.
- **Ganho:** defensiva — util `textDedupe.ts` colapsa runs >3 idênticas em `[…N×]`, hard-cap 4KiB.
- **Esforço:** pequeno — **Risco:** nenhum (fail-open).
- **Doc:** [docs/discovery/ohmypi/gap/04-report-tool-issue.md](docs/discovery/ohmypi/gap/04-report-tool-issue.md) §7

#### [ ] T5.19 Guard test prompt-size em `src/tools/*/prompt.ts`
- **Problema:** Prompts inflando sem limite acordado; sem pressão progressiva pra fragmentar.
- **Ganho:** invariant de saúde — falhar build se template literal > 500 chars sob `src/tools/*/prompt.ts`.
- **Esforço:** pequeno — padrão alinhado ao `feature-flags-source-guard.test.ts` existente.
- **Doc:** [docs/discovery/ohmypi/gap/03-prompts-as-md.md](docs/discovery/ohmypi/gap/03-prompts-as-md.md) §3.5

#### [ ] T5.20 `createIf` capability gate no `buildTool`
- **Problema:** Tools que dependem de capability (env, settings, provider) hoje abortam dentro de `call()` ou checam `isEnabled` separado.
- **Ganho:** API mais limpa — `buildTool({ ..., createIf: (ctx) => ctx.settings.foo === 'bar' })`.
- **Esforço:** pequeno — **Risco:** baixo.
- **Doc:** [docs/discovery/ohmypi/gap/01-bm25-tool-gating.md](docs/discovery/ohmypi/gap/01-bm25-tool-gating.md) §1.9

#### [ ] T5.21 Wall-clock cap + recursion prevention em sub-agents
- **Problema:** `AgentTool` sem timeout máximo nem detecção de sub-agent spawnando sub-agent.
- **Ganho:** defensiva — evita run-away.
- **Esforço:** trivial — **Risco:** nenhum.
- **Doc:** [docs/discovery/ohmypi/gap/08-cow-isolation.md](docs/discovery/ohmypi/gap/08-cow-isolation.md) §4 e §5

### Sub-tier 5.D — P2 (nicho ou bloqueado por demanda)

#### [ ] T5.22 Structural summary AST (elisão por linguagem no Read)
- **Ganho:** maior ROI em arquivos grandes (`openaiShim.ts` 2.2k linhas vira outline semanticamente correto). Maior que `view='outline'` atual (depth-scanner) porque AST não engana com strings/comentários.
- **Bloqueio:** grande — requer tree-sitter (WASM ou NAPI), conflita com single-file bundle.
- **Doc:** [docs/discovery/ohmypi/gap/07-tree-sitter-ast-edits.md](docs/discovery/ohmypi/gap/07-tree-sitter-ast-edits.md) §1

#### [ ] T5.23 CAS blob store (só para imagens/anexos binários)
- **Trigger:** entrar fluxo de imagens/anexos inline no JSONL. Hoje dedup real ~250KB (6.4%) — não vale dual-read.
- **Doc:** [docs/discovery/ohmypi/fit/05-cas-blob-store.md](docs/discovery/ohmypi/fit/05-cas-blob-store.md)

#### [ ] T5.24 COW reflink seedar `node_modules`/`dist`
- **Trigger:** workers paralelos lendo workspace. Hoje `git worktree add` = 100ms (gitignore esconde GBs).
- **Encaixe:** opção pequena de reflink em `performPostCreationSetup` + doc do hook `WorktreeCreate` existente.
- **Doc:** [docs/discovery/ohmypi/fit/08-cow-isolation.md](docs/discovery/ohmypi/fit/08-cow-isolation.md)

#### [ ] T5.25 SQLite + FTS5 para history search
- **Trigger:** `/resume` em projeto com muitas sessões fica lento (scan de N JSONLs).
- **Doc:** [docs/discovery/ohmypi/gap/05-cas-blob-store.md](docs/discovery/ohmypi/gap/05-cas-blob-store.md) §1 (History DB)

#### [ ] T5.26 Compaction entry tipada no JSONL
- **Trigger:** querer navegar pré/pós-compact sem grep manual.
- **Ganho:** transcript fica árvore append-only navegável.
- **Doc:** [docs/discovery/ohmypi/gap/05-cas-blob-store.md](docs/discovery/ohmypi/gap/05-cas-blob-store.md) §1 (Compaction inline)

#### [ ] T5.27 Hindsight reflect-only (tool `/reflect`)
- **Trigger:** experimento — ortogonal a `extractMemories` que já popula `.md` automaticamente.
- **Bloqueio:** backend 100% local (sem RPC).
- **Doc:** [docs/discovery/ohmypi/gap/04-report-tool-issue.md](docs/discovery/ohmypi/gap/04-report-tool-issue.md) §1

#### [ ] T5.28 Oracle agent (second-opinion / first-principles)
- **Trigger:** útil com fallback chain de provider (primário fraco + escalation para modelo forte).
- **Doc:** [docs/discovery/ohmypi/gap/04-report-tool-issue.md](docs/discovery/ohmypi/gap/04-report-tool-issue.md) §4

#### [ ] T5.29 Inline terminal images (Kitty/iTerm2)
- **Trigger:** demanda concreta. Issue upstream `anthropics/claude-code#2266` existe mas nada interno pedindo.
- **Encaixe:** `ink-picture` atrás de flag `INLINE_IMAGES`, restrito a Kitty + iTerm2 (Sixel sai por risco de scrollback corrompido).
- **Doc:** [docs/discovery/ohmypi/deep/10-inline-terminal-images.md](docs/discovery/ohmypi/deep/10-inline-terminal-images.md)

---

## Tier 6 — LSP-first agent (descoberto via `docs/discovery/code-review-graph/`)

**Tese central — Search + Read são onde está o ganho real.**

Claudin já tem LSP forte (13 ops, 12 servers embarcados em `src/services/lsp/builtinServers.ts:461-609`) e `scanSymbols` regex-puro em `src/tools/shared/codeOutline/scanSymbols.ts`, mas o agente:

- **Lado Search** — cai em Grep regex (texto ruidoso, sem resolução simbólica) mesmo quando LSP entregaria a resposta correta em 1 chamada (`prepareCallHierarchy`, `findReferences`).
- **Lado Read** — lê arquivos inteiros (~6k tokens) quando precisa mexer em 40 linhas. Já existe `Read view='outline'` e `Read symbol='nome'` que reduzem 10-20×. Quase não é usado.

**T6.6** é agora o coração do Tier — tweak de tool description, custo de horas, ganho potencialmente desproporcional. Os outros itens (`/review` orquestrado, cache, índice) são consequências derivadas, gated por evidência empírica. **T6.1 (descriptions LSP-first) foi descartado por bench A/B** — ver bloco DROPADO abaixo.

Itens nasceram do estudo de `code-review-graph` (`docs/discovery/code-review-graph/00-insights.md` → `09-roadmap-validation.md`) **com revisões críticas aplicadas**: o que parecia infra nova quase sempre vira "fazer o agente usar o que já existe". Evita o overclaim que o próprio CRG comete (ver `02-arquitetura-e-mecanismo.md §9`).

Ordem: **T6.6 (core) → medir → decidir tudo mais**. T6.1 e T6.4 dropados. T6.5 em DEFER.

### [~] T6.1 Tool descriptions de LSPTool/GrepTool — **DROPADO**
- **Razão:** dois benches A/B (claudin e openclaude, `docs/discovery/lsp-vs-grep-ground-truth/`) mostraram **LSP=0 em todas as runs** mesmo com a tabela LSPTool-first reaplicada e o GrepTool sinalizando "para callers/refs prefira LSP". Descriptions globais não deslocam o agente para LSP nesses prompts.
- **Achado paralelo (não previsto):** o bench expôs um bug crítico de roteamento em `getBuiltinLspServers` — `biome` (linter-only) podia shadowar `typescript-language-server` em arquivos `.ts/.tsx` por ordem não-determinística do `Promise.allSettled`. Corrigido em commit separado com teste de regressão. Sem o fix, qualquer experimento Tier 6.1 era inválido de antemão.
- **Próxima tentativa lógica:** **T6.6** (description do FileReadTool com cross-ref para LSP `outgoingCalls`) — mais perto do ponto de decisão. Se T6.6 também falhar, mover hipótese para system prompts de Explore/Plan agents (originalmente vetado em T6.1, reavaliar com evidência nova).

### [ ] T6.2a Parser de hunks no `/review` (sem LSP)
- **Arquivos:** `src/commands/review.ts:9-31` (consumidor), `src/utils/gitDiff.ts:114,200` (reuso de `fetchGitDiffHunks`/`parseGitDiff` que **já existem**).
- **Problema:** `/review` joga `gh pr diff` cru no LLM — sem ordenação, sem identificação de hub files, mesmo prompt para patch trivial ou refactor crítico.
- **Mudança:** pipeline que extrai do diff uma tabela estática `arquivo | linhas_mudadas | hunks | é_teste?` e injeta no prompt. **Sem chamadas LSP nesta fase.**
- **Ganho:** médio (review prioriza arquivos grandes) — **Esforço:** baixo (~3 dias) — **Risco:** baixo. Reusa código existente.
- **Kill criteria:** se em 5 PRs reais o LLM não usar a tabela injetada (verificar via review do output), parar antes de T6.2b.

### [ ] T6.2b Risk score em `/review` com LSP (gated por T6.2a)
- **Arquivos:** mesmos de T6.2a + `src/tools/LSPTool/LSPTool.ts` (consumir `findReferences`/`incomingCalls` internamente).
- **Problema:** mesmo do T6.2a, mas com ranking de impacto.
- **Mudança:** para cada símbolo modificado no diff (cap em N=20 para evitar N×M blow-up), chamar `LSPTool.findReferences` paralelo (cap 8); compor score com `callerCount + isTestModified + securityKeyword`. **Pesos calibrados empiricamente em ≥10 PRs reais antes de commitar como default** (ver `07-crg-mining-for-roadmap.md` Eixo 2 — CRG usa pesos arbitrários; não copiar).
- **Ganho:** médio em PRs grandes (>10 arquivos) — **Esforço:** médio (1-2 sem) — **Risco:** **médio-alto** — reproduz o anti-pattern do CRG `get_review_context(default)` se cap não for respeitado (`09-roadmap-validation.md §2 Eixo 2`).
- **Kill criteria:** se em PRs pequenos (<5 arquivos) o tempo de orquestração > tempo do prompt naive atual, restringir a `--deep` opt-in em vez de default.

### [ ] T6.3 Cache in-memory de `documentSymbol` por sessão
- **Arquivos:** novo wrapper sobre `src/services/lsp/LSPServerManager.ts:265` (`sendRequest<T>`), invalidação reusando hook em `src/services/tools/toolExecution.ts:1762-1779` (`invalidateCacheForWrite` — **já existe**).
- **Problema:** loops de exploração repetem `documentSymbol` no mesmo arquivo unchanged.
- **Mudança:** memoização in-memory keyed por `(path, content-hash)`; invalidar entrada quando `FileEditTool`/`FileWriteTool` toca o path. **Só `documentSymbol`** — não cachear `findReferences` (resultado depende de N arquivos; invalidação fica reverse-deps, complexidade alta, `09-roadmap-validation.md §2 Eixo 4`).
- **Padrão a reusar:** `src/tools/LSPTool/codeActionCache.ts:30-74` (TTL + eviction) e `src/tools/shared/twoTierCache.ts:102`.
- **Ganho:** baixo-médio (latência em loops Explore) — **Esforço:** baixo (2-3 dias) — **Risco:** baixo.
- **Pré-requisito de medição:** rodar **depois** de T6.6. Se T6.6 reduzir queries redundantes, o ganho de T6.3 cai — avaliar antes de comprometer (`09-roadmap-validation.md §3`).
- **Kill criteria:** se hit-rate <30% em 100 sessões instrumentadas, remover.

### [x] T6.6 Leitura cirúrgica via outline + symbol-targeted reads + call graph — **SHIPPED (2026-05-28)**
- **Branch:** `feat/fileread-surgical-reading-strategy` (commit `26922e5`).
- **Resultado do bench A/B/C** (24 invocações, sonnet-4-6, openclaude, 4 prompts read-heavy):

  | Variant | Δ avg input cost tokens | Δ wall | Δ cost |
  |---|---:|---:|---:|
  | A baseline | - | - | - |
  | **B description-only** (shipped) | **-16.7%** | **-23.1%** | **-15.5%** |
  | C auto-outline ≥700 lines (dropado) | -4.3% | -20.0% | +4.5% |

- **Comportamento mudou em prática:** Read mode totals saíram de A `outline=1 symbol=1 range=10 full=4` para B `outline=4 symbol=5 range=5 full=0` — agente seguiu o playbook.
- **Quebra o folklore de T6.1** ("description não move comportamento"). Diferença: T6.6 deu **playbook numerado + exemplo concreto** (`refactor 'login' in src/auth/index.ts → outline → symbol='login'`), não descrição geral. Aplicar essa receita antes de mexer em código quando o ganho é em *como* o agente usa um tool existente.
- **Dropados (sem evidência):**
  - **C auto-outline** — arquivo ≥700 linhas em Read default vira outline automático. Disparou só 1× em 8 runs (agente prefere Grep/range a plain Read em arquivo grande). +4.5% cost. Não compensa o código novo.
  - **Edit no `LSPTool/prompt.ts`** referenciando `outgoingCalls` como discovery — LSP=0 em todas as variantes nos 4 prompts. Sem evidência empírica de movimento. Mantido fora.
- **Artefatos:** harness em `scripts/bench/fileread-outline-3way.ts`, report em `scripts/bench/results/fileread-outline-3way-2026-05-28T03-03-50-836Z.md`.

<details>
<summary>Plano original (mantido para histórico)</summary>

- **Arquivos:** `src/tools/FileReadTool/prompt.ts` (description), `src/tools/LSPTool/prompt.ts` (cross-ref para `outgoingCalls`).
- **Problema observado:** o ciclo típico de edição lê o arquivo inteiro (~6k tokens) mesmo quando a tarefa toca 40 linhas. Para entender dependências, lê mais arquivos inteiros. Custo de input cresce O(arquivos tocados) quando poderia ser O(símbolos relevantes).
- **Já existe e quase não é usado:**
  - `Read view='outline'` (`FileReadTool.ts:945-971`) — só assinaturas (~200 tokens vs ~6k).
  - `Read symbol='nome'` (`FileReadTool.ts:1263`) — só o corpo do símbolo nomeado.
  - `LSPTool.documentSymbol` — outline com precisão AST.
  - `LSPTool.outgoingCalls(funcX)` — lista de funções chamadas por `funcX`, com `file:line` exato — permite "navegar" pela call graph e ler **só os símbolos que importam**.
- **Mudança:** description do `FileReadTool` explicita o padrão:
  1. Para arquivo desconhecido: comece com `view='outline'` (cheap).
  2. Para mexer em função X: `Read symbol='X'` em vez de full file.
  3. Para entender o que X depende: `LSPTool.outgoingCalls(X)` → para cada chamada relevante, `Read symbol='depY'` no arquivo correspondente.
  4. Full file só quando precisa de imports, constantes top-level, ou estrutura completa.
  - Description do `LSPTool` reforça o link inverso: "use `outgoingCalls` para descobrir quais símbolos ler em seguida, evitando Read de arquivos inteiros".
- **Por que isso pode funcionar:** ganho é **input-side** (tokens de leitura). Em tarefas de modificação localizada em codebase não-familiar, redução estimada de 10-20× no input por ciclo (medir empiricamente).
- **Fallback:** se o arquivo não tem outline parseável (linguagem não coberta por `scanSymbols`/LSP), agente cai em `Read` normal. Sem regressão.
- **Ganho:** **médio-alto em input tokens** (depende muito do tipo de tarefa) — **Esforço:** baixo (horas, só descriptions) — **Risco:** baixo.
- **Kill criteria:** se em 20 sessões instrumentadas a redução de input tokens for <20% para tarefas de edição localizada, reverter — provavelmente sinal de que o agente está fazendo outline + read symbol + acabando lendo full file mesmo assim (dupla leitura).
- **Sequenciamento sugerido:** core do Tier 6 agora que T6.1 foi descartado. Se T6.6 também não mover comportamento via description-edit, próxima alavanca é system prompt do Explore agent.

</details>

### [ ] T6.7 Plan dossier com anchors de linha + símbolo + capturas LSP
- **Arquivos:** `src/services/planDossier.ts` (`Dossier` type linha 70, `DossierEntry` union linha 68, `ReadEntry` linha 31), `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`, `src/tools/ExitPlanModeTool/prompt.ts`.
- **Já existe:** o dossier hoje monitora Read/Grep/Glob durante plan mode e empacota o conteúdo dos arquivos em `filesToEdit` para o implementador (`planDossier.ts:31-77`). O implementador recebe arquivos completos, **não anchors**.
- **Problema observado:** `filesToEdit` é só lista de paths. Em arquivo de 1000 linhas, o implementador precisa re-localizar o ponto de mudança via Grep/Read. Output de LSP rodado no planejamento (callers, refs, hierarquia) não persiste — se o planner descobriu que `login` em `auth.ts:120-145` é o ponto, isso é jogado fora.
- **Mudança:**
  1. Estender `filesToEdit` no schema de `ExitPlanMode` para aceitar `{path, lineRange?, symbol?}` em vez de `string[]` puro (com retrocompatibilidade — `string` continua válido como path puro).
  2. Adicionar `LspEntry` à union `DossierEntry`: resultado de `findReferences`/`incomingCalls`/`documentSymbol` que o planner rodou, anchorado em `(path, line, symbol)`.
  3. `ExitPlanMode` prompt orienta planner: "se você sabe a linha/símbolo onde mexer, declare em `filesToEdit`; se rodou LSP durante o plan, esses resultados ficam no dossier".
  4. Render do dossier prioriza `lineRange` quando presente — passa só o trecho relevante via `Read symbol='X'` ou `Read offset/limit`, não o arquivo todo (sinergia direta com T6.6).
- **Por que faz sentido agora:** combina T6.6 (ler só o símbolo) e o dossier já existente. Sem isso, T6.6 ajuda o planner mas a informação morre na transição plan → implementação.
- **Ganho:** **médio-alto em input tokens do implementador** + reduz tempo de "re-orientação" no início da implementação — **Esforço:** baixo-médio (~3-5 dias; schema change + render change + 1 entry type novo) — **Risco:** baixo (retrocompat preservada).
- **Kill criteria:** se em 20 sessões de plan o planner não usar `lineRange`/`symbol` em mais que 30% dos `filesToEdit`, reverter para schema só-path. Sinal de que a description não convenceu.
- **Sequenciamento:** depois de T6.6 (planner precisa estar usando symbol-read antes de adiantar capturar isso).

### [~] T6.4 Wiki auto-gerada — **DROPADO**
- **Razão:** validação RED (`09-roadmap-validation.md §2 Eixo 3`). Template vazio em `src/services/wiki/init.ts:6-37` é scaffold deliberado, não dor; saída em monorepo TS de 200+ arquivos seria ruidosa; duplica `claude-code-guide` agent + `docs/`.
- **Substituto leve:** se houver demanda real, melhorar o template em `init.ts` com seções pré-populadas a partir de `Read view='outline'` da raiz — sem walker recursivo, sem summarizer LLM.

### [ ] T6.5 Índice persistente cross-sessão — **DEFER**
- **Bloqueio:** só considerar depois de T6.2b e T6.3 mostrarem valor real e adoção. Único item que tocaria `verify:privacy` (team memory `verify-privacy-bundle-only`).
- **Doc:** `docs/discovery/code-review-graph/03-fit-no-claudin.md` + `06-onde-ganho-real.md`.

### Receita doc-only (paralelo, custo ~30min)
- **Arquivo a criar:** `docs/recipes/code-review-graph-mcp.md`
- **Conteúdo:** snippet de `settings.json` para usuários power plugarem o CRG como MCP server externo opcional, com disclaimer "ganhos variam por commit; rode seu próprio benchmark" (`03-fit-no-claudin.md` caminho (a)).

---

## Tier 7 — Otimização para Opus 4.8

Modelo `claude-opus-4-8` lançado 2026-05-28. No Claude API o contexto de **1M é default, sem beta header** — a Anthropic recomenda *remover* o header `context-1m` legado (pode causar 400). Sem breaking changes de API; effort default subiu para `high`. Fontes: [What's new 4.8](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8), [migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide).

### Bug P0 — auto mode trava o Bash com Opus 4.8

#### [x] T7.1 — Sufixo `[1m]` dispara header `context-1m` que Opus 4.8 rejeita
> **Resolvido** em `1b885d1` (promote Opus 4.8): `opus-4-8` foi adicionado a `modelSupports1M` (`context.ts:75`), confirmando que o modelo **suporta** o header `context-1m`. A premissa do bug ("rejeita") deixou de valer — o header é válido e não causa mais 400. A supressão proposta no fix candidato não foi necessária.
- **Arquivos:** `src/utils/model/model.ts:358,363` (anexa `[1m]` p/ Max/Team Premium via `isOpus1mMergeEnabled()`), `src/utils/context.ts:58-63` (`has1mContext` detecta `[1m]`), `src/utils/betas.ts:223-224` (envia `CONTEXT_1M_BETA_HEADER`).
- **Problema:** cadeia `getDefaultMainLoopModelSetting` → `[1m]` → `has1mContext=true` → header `context-1m` enviado. Como 1M é default no 4.8, o endpoint pode responder **400 a toda request**. No auto mode isso faz o classificador de segurança do Bash falhar → fail-closed → **Bash bloqueado** ("temporarily unavailable, so auto mode cannot determine the safety"). Bate exatamente com o sintoma reportado.
- **Fix candidato:** não enviar `CONTEXT_1M_BETA_HEADER` quando o canonical for `opus-4-8` (1M nativo); e/ou não anexar `[1m]` para modelos que já têm 1M default. Validar contra `getAllModelBetas` em provider firstParty.
- **Ganho:** desbloqueia auto mode (crítico) — **Esforço:** baixo — **Risco:** médio (mexe em betas/header; testar com `/provider doctor` no provider real). Rodar `bun run test:provider`.

#### [x] T7.2 — Classificador sem fallback em erro determinístico
> **Implementado:** helper `detectDeterministicApiError` (`yoloClassifier.ts`) classifica 4xx (exceto 408/409/429) via `instanceof APIError` + `.status`; flag `deterministic?` em `YoloClassifierResult`; ambos os catch (single-stage + XML 2-stage, com guard `stage1Usage === undefined`) setam a flag; `permissions.ts` degrada o erro determinístico para aprovação manual (headless → `AbortError`), antes do gate `iron_gate`. Cobre Anthropic e providers OpenAI-compat (shim usa `APIError.generate`). Testes: `yoloClassifier.deterministicError.test.ts`.
- **Pré-condição confirmada (não é dead-code):** os templates `.txt` do classificador *estão* presentes neste build (`src/utils/permissions/yolo-classifier-prompts/auto_mode_system_prompt.txt` 3 KB + `permissions_external.txt` 6.8 KB) e `TRANSCRIPT_CLASSIFIER: true` (`scripts/build.ts:55`). Logo `CLASSIFIER_PROMPTS_BUNDLED === true` (`yoloClassifier.ts:74`) — o classificador realmente chama a API e o caminho fail-closed abaixo é exercitado. (Se os prompts fossem removidos, `classifyYoloAction` curto-circuitaria em `shouldBlock:false` auto-allow, `yoloClassifier.ts:1159-1166`, e este item viraria inerte.)
- **Arquivos:**
  - `src/utils/permissions/yoloClassifier.ts:1399-1444` (catch do tool_use single-stage → `unavailable:true`) **e** `:1089-1131` (catch do XML 2-stage → mesmo `unavailable`). Os **dois** precisam classificar o erro; o abort em `:1400-1409` já retorna `unavailable` e deve continuar como está (abort não é erro de API).
  - `src/utils/permissions/permissions.ts:832-862` (gate `tengu_iron_gate_closed`, default `true` no open build pois GrowthBook é stub → sempre fail-closed; retorna `buildClassifierUnavailableMessage`).
  - `src/types/permissions.ts:346-356` (`YoloClassifierResult`; já tem `unavailable?` e o precedente `transcriptTooLong?`).
- **Problema:** num erro de API o catch devolve `unavailable:true` e o gate fail-closed nega o Bash sem distinguir a *causa*. Para 5xx/429 isso está certo (genuinamente indisponível). Mas um **400 determinístico** (ex.: header `context-1m` ruim do T7.1, request malformado, auth 401/403) é tratado como "temporário" — a mensagem manda "wait and retry" (`rejection.ts:56`), o agente re-tenta, recebe o mesmo 400, e entra em **loop de denial**. Pior: o branch `unavailable` retorna em `permissions.ts:862` **antes** de `recordDenial`/`handleDenialLimitExceeded` (`:865-888`), então nem o denial-limit fallback dispara — não há saída automática.
- **Precedente a copiar:** `transcriptTooLong` já implementa exatamente o degrade desejado para *seu* erro determinístico — `permissions.ts:809-829` pula o `iron_gate` e cai em prompt manual normal (e em headless, `shouldAvoidPermissionPrompts`, lança `AbortError` em vez de loopar, `:810-816`). T7.2 deve generalizar esse padrão para 4xx.
- **Fix candidato:**
  1. Nos dois catch, classificar o erro com helper existente (`categorizeRetryableAPIError`, `errors.ts:1281`, ou `shouldRetry`, `withRetry.ts:786`): transitório = 429/529/5xx/timeout/overloaded (retries internos do `sideQuery` já se esgotaram — manter fail-closed, é real); determinístico = 400/401/403/422.
  2. Adicionar flag `deterministic?: boolean` em `YoloClassifierResult` (espelhando `transcriptTooLong`) setada só no caso 4xx.
  3. Em `permissions.ts`, antes do branch `unavailable`, tratar `deterministic` como `transcriptTooLong`: pular `iron_gate`, fallback p/ prompt manual; em headless, `AbortError` com mensagem clara em vez de loop.
  4. Mensagem dedicada (não reusar `buildClassifierUnavailableMessage`, que diz "temporarily… retry"): algo como "classificador rejeitou a request de forma determinística (HTTP 4xx) — aprovação manual necessária". Aproveitar a normalização do model do T7.3 aqui.
- **Não enfraquecer o gate:** transitórios continuam fail-closed via `iron_gate`; só 4xx degradam para manual. É defesa-em-profundidade — o fix de raiz do header ruim é o T7.1; T7.2 garante que *qualquer* 400 futuro (não só o do header) degrade para aprovação manual em vez de loop infinito.
- **Teste:** adicionar caso em `src/utils/permissions/*.test.ts` simulando `APIError` 400 vs 503 e verificando deterministic→manual, transient→fail-closed. Rodar `bun run test:provider`.
- **Ganho:** robustez do auto mode (elimina loop de denial) — **Esforço:** médio — **Risco:** médio (caminho de segurança; cobrir com teste e não relaxar o gate p/ transitórios).

#### [x] T7.3 — Mensagem de erro mostra model não-normalizado (`[1m]`)
- **Arquivo:** `src/utils/permissions/yoloClassifier.ts:1439` (retorna model cru), `src/utils/messages/rejection.ts:51-61`.
- **Problema:** usuário vê `claude-opus-4-8[1m] is temporarily unavailable` — o `[1m]` é alias de UI, não ID de API real, confunde o diagnóstico.
- **Ganho:** cosmético/diagnóstico — **Esforço:** trivial (`normalizeModelStringForAPI(model)`) — **Risco:** nenhum.

### Aproveitar features novas do 4.8

#### [~] T7.4 — Mid-conversation system messages — **DESCARTADO (2026-05-29)**
- **Arquivo:** `src/services/api/` (caminho Anthropic em `claude.ts` / construção de `messages`).
- **Premissa original (incorreta):** "atualizar instruções no meio da sessão quebra prompt-cache; `role:"system"` preservaria cache". Na verdade o `system` top-level já é estável na sessão (`getSystemContext` memoizado) e info dinâmica já vai como `<system-reminder>` em mensagens `user` — **o ganho nunca foi cache**, e sim *autoridade de instrução* (`system` > `user`), uma mudança comportamental.
- **Por que foi descartado:** protótipo gated (flag `MID_CONVERSATION_SYSTEM`) promovendo o reminder de auto-mode a `role:"system"` **falhou com HTTP 400 em 100% das invocações** no smoke A/B:
  `messages.N: role 'system' must precede an 'assistant' message or end the array`.
  O reminder de auto-mode é estruturalmente **sempre a última mensagem do turno** (injetado depois do prompt do usuário, aguardando a resposta do modelo). Promovido a `system`, encerra o array — e a API **não gera resposta após um `system` terminal**. As posições válidas (`primeira` = papel do system top-level; `antes de um assistant` = só existe em turns ≥2 e mesmo assim o reminder continua trailing) **não cobrem nenhum turno real**. Pior que inerte: 400 garantido.
- **Conclusão:** o ponto de injeção do auto-mode (sempre terminal) é incompatível com `role:"system"` mid-conversation. Reaproveitar exigiria um *consumidor diferente* — uma instrução que naturalmente fique antes de um `assistant` turn — sem caso de uso atual que justifique. Plumbing revertido; nada shipado. Ver [limitações da API](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations).

#### [x] T7.5 — Effort `xhigh` default para loops de coding
- **Problema:** Anthropic recomenda `xhigh` explícito p/ coding/alta autonomia; default `high` no 4.8 é recalibrado (pensa menos que o `high` do 4.7). Sintoma: 4.8 lê arquivo-por-arquivo sequencialmente em vez de batar `Read` em paralelo como o 4.7.
- **Ganho:** qualidade de coding — **Esforço:** baixo — **Risco:** baixo/médio (re-baselinar custo/latência; talvez opt-in via settings).
- **Entregue:** opt-in via `codingLoopXhighDefault` em `settings.json` (default off). Quando ligado, `getDefaultEffortForModel` retorna `xhigh` **só para Opus 4.8**, vencendo os defaults `medium` de Pro/Max/Team e ultrathink. 4.7/4.6 e demais modelos inalterados (compatibilidade). Testes em `src/utils/effort.xhighDefault.test.ts`.

#### [ ] T7.6 — Limpar header `context-1m` legado e retry de sampling params
- **Problema:** migration guide manda remover `context-1m-2025-08-07` (era 4.6) e qualquer retry de `temperature/top_p` em 400. Parcialmente coberto por T7.1.
- **Ganho:** evita 400s — **Esforço:** baixo — **Risco:** baixo.

### Skills/comandos padrão (model-invocable)

#### [ ] T7.7 — Promover `/review`, `/security-review`, `/auto-fix` a bundled skills
- **Arquivos:** `src/commands/review.ts:33`, `src/commands/security-review.ts:6`, `src/commands/auto-fix.ts:3` (hoje `source:'builtin'`); padrão em `src/skills/bundled/code-review.ts:131-157`; registro em `src/skills/bundled/index.ts:18-60`; gate em `src/commands.ts:556-567` (exclui `source:'builtin'` da lista de skills do modelo).
- **Problema:** comandos `builtin` são tipáveis pelo usuário mas **não** aparecem na lista de skills model-invocable (excluídos em `commands.ts:563`). Com 4.8 disparando skills melhor, reimplementá-los como bundled skills (ou reclassificar) os torna invocáveis pelo modelo.
- **Ganho:** roteamento automático de tarefas (review/fix/security) — **Esforço:** médio (1 arquivo bundled por skill + teste colocado) — **Risco:** baixo.

#### [ ] T7.8 — Consolidar `code-review` / `/code-review` canônico
- **Arquivo:** `src/skills/bundled/code-review.ts` (já é bundled skill, `userInvocable:true`).
- **Problema:** já existe como skill; alinhar naming com o futuro `/review` bundled p/ não duplicar (evitar `/review` builtin + `code-review` skill confundindo o modelo).
- **Ganho:** clareza — **Esforço:** baixo — **Risco:** baixo.

**Ordem sugerida:** T7.1 (desbloqueia auto mode, P0) → T7.3 (trivial, ajuda diagnóstico) → T7.2 (robustez) → T7.7 (skills) → T7.5 (feature API; T7.4 descartado) → T7.6/T7.8 (limpeza). Confirmar T7.1 com bench/`/provider doctor` antes de qualquer trabalho nas features.

---

## Spike S1 — Prompts/tools sob Opus 4.8: vale adaptar?

**Tipo:** spike time-boxed (investigação + medição, SEM compromisso de shippar). **Pergunta:** com o primário agora em `claude-opus-4-8`, há ganho *real* em adaptar descrições de tool / system prompt — e onde?

**Premissa corrigida (importante):** "modelo mais forte → pode tirar hand-holding" é a categoria de mudança que **historicamente deu inerte ou pior** nos A/B do time (ver memórias `*-inert`, `grep-symbols-nudge-inert`, `bash-filter-nudge-rejected`). A introspecção do próprio modelo sobre o que o ajuda **não é evidência** — só A/B conta. O spike NÃO deve perseguir "encurtar prompt".

**A única alavanca com track record** é ensinar o modelo a usar um **modo de tool mecanicamente mais barato que ele subusa** — foi o que pagou em `t6.6-fileread-surgical` (−16.7% tokens, −23% wall) ao ensinar `view='outline'`/`symbol=`. O spike replica *esse padrão*, não a remoção de muletas.

### Objetivos do spike (entregáveis, não código de produção)
1. **Baseline de subuso:** medir, em sessões/benches reais, com que frequência os modos baratos já são usados vs os caros. Sem subuso medido, não há ganho a capturar (regra aprendida em `outline-nudge-...-inert`: nudge só move se o tool-alvo for usado no cenário).
2. **Shortlist priorizada** de candidatos (B-type) com file:line.
3. **Decisão:** para cada candidato, GO (vale A/B ≥3 reps) ou NO-GO (arquivar como os outros `*-inert`).

### Mapa de candidatos (já levantado — categoria B "ensina modo barato")
- **[ ] S1.a — GrepTool `output_mode="symbols"` / `head_limit`.** `src/tools/GrepTool/prompt.ts:13` apenas *lista* `symbols`; não ensina **quando** preferir `symbols` (mapear código) a `content`+paginação. É o análogo direto do FileReadTool — **candidato nº1**. Hipótese: description ensina o roteiro `symbols` → outputs menores. Medir baseline de uso de `symbols` antes.
- **[ ] S1.b — GlobTool.** `src/tools/GlobTool/prompt.ts:3-7` é mínimo; não menciona `head_limit`/escopo via `path`. Ganho provável baixo (output de Glob já é barato) — provável NO-GO, confirmar.
- **[ ] S1.c — Parallelismo de tool calls.** System prompt manda "chame em paralelo" sem exemplo concreto de batch. 4.8 é melhor nisso; medir taxa de calls paralelos vs sequenciais — se já alta, NO-GO.
- **[ ] S1.d — Bash output / `head_limit` em leituras grandes.** Já há filtro de output ligado por default (ver CLAUDE.md); checar se sobra subuso de pedir menos output de cara. Provável redundante com o filtro — confirmar.
- **Referência (não tocar):** FileReadTool `prompt.ts:35-41` é o exemplo que funcionou; usar como template de redação, não reabrir.

### Fora de escopo (já investigado/descartado)
- Dedup determinístico e trim de hand-holding (Explore/Plan READ-ONLY, "be concise" repetido): ganho ~baixas centenas de tokens, e Explore roda em **Haiku** (`src/.../exploreAgent.ts`), não toca o 4.8. Não é o foco do spike.
- Git playbook do Bash: já otimizado (injetado como attachment fora do schema; `scripts/measure-tool-schemas.test.ts` garante bytes idênticos).

### Protocolo (não-negociável)
- Bench em `scripts/bench/` no estilo dos existentes; **≥3 replicações** antes de crer em qualquer efeito (regra `grep-symbols-nudge-inert`).
- Randomizar ordem A/B ou medir direto p/ evitar cache-warming skew (`ab-bench-cache-warming-skew`).
- Métrica primária = tokens de **output**/wall; veredito separa medido de teórico (`no-overclaim-performance`).
- **Esforço:** médio (1-2 dias de bench) — **Risco:** nenhum (spike não altera produto). Saída vira itens GO no roadmap ou memórias `*-inert`.

**Primeiro passo concreto:** medir baseline de uso de `symbols`/`outline`/`head_limit` (S1.a) antes de escrever qualquer description — se o subuso for ~0, o spike encerra cedo com NO-GO geral.

---

## Limpeza oportunista

- [ ] **CHICAGO_MCP cleanup duplicado** em `src/query.ts:1060` e `1621` — flag está `false` em `build.ts`; código morto no open build. Unificar ou gate explícito.
- [ ] **`useMemo(() => false, [])`** em `src/screens/REPL.tsx:618` — slot de hook gasto para constante.
- [ ] **gRPC vaporware em docs** — `CLAUDE.md:40-41,90` e `README.md:66` referenciam `src/grpc/`, `src/proto/`, scripts `dev:grpc*` que não existem no código. Limpar ~5 linhas. Registrado em team memory `grpc-vaporware-in-docs.md`.
- [ ] **`FileEditTool` sem teste unitário direto** — único `.test.ts` cobre só LSP diagnostics. Lógica de match / `replace_all` / quote-normalization sem cobertura.

---

## Ordem sugerida de execução

**P0 imediato (Tier 7 — Opus 4.8):** T7.1 (auto mode bloqueando Bash) antes de tudo — é regressão ativa que trava o CLI. Depois T7.3, T7.2, e o restante do Tier 7.

**Prioridade nova (Tier 3 — quebra de arquivos gigantes), por ROI/risco:**

1. 11a — `utils/messages.ts`
2. 11c — `utils/sessionStorage.ts`
3. 11d — `utils/hooks.ts`
4. 11h — `utils/attachments.ts`
5. 11f — `utils/bash/bashParser.ts`
6. 11b — `cli/print.ts`
7. 11i — `services/mcp/client.ts`
8. 11j — `services/api/claude.ts`
9. 11k — `services/api/openaiShim.ts`
10. 11e — `screens/REPL.tsx` (risco alto — depois de cobertura)
11. 11g — `main.tsx` (risco alto — por último)

**Tier 1/2 pendentes (executar em paralelo quando couber):**

- Item 1 — regex módulo-level (15 min, sem risco)
- Item 6 — cache `stableStringify` (maior gargalo medido)
- Item 2 — paralelizar dynamic imports (cold start)
- Item 7 — delta-write transcript (escala mal em turnos longos)
- Item 3 — cache `isEnabled()` (reduz custo do `useMemo` do REPL)

**Tier 6 (LSP-first agent) — ordem por dependência:**

1. T6.6 — leitura cirúrgica via outline+symbol+outgoingCalls (horas; core do Tier após T6.1 dropado)
2. Receita doc-only do CRG MCP (paralelo, 30min)
3. T6.2a — parser de hunks no `/review` (~3 dias)
4. **Gate de medição** — T6.6 mexeu em input tokens? T6.2a foi usado?
5. T6.2b — risk score com LSP (só se 2a validar)
6. T6.7 — plan dossier com anchors+LSP captures (depende de T6.6 ativo)
7. T6.3 — cache `documentSymbol` (só se T6.6 deixar ganho residual)
8. T6.5 — índice persistente (DEFER, reavaliar em 3 meses)

T6.1 (descriptions LSPTool/GrepTool) **dropado** — bench A/B mostrou LSP=0 independente da description.

**Tier 5 (discovery ohmypi) — ordem recomendada por ROI:**

1. T5.1 — LSPTool write-ops (resolve dor de "rename amplo" sem dep nova)
2. T5.2 — Late LSP diagnostics injection (80% infra já existe)
3. T5.4 — BM25 tool gating em OpenAI-compat (30-55% input tokens; vácuo concreto)
4. T5.3 — Checkpoint/Rewind (alto valor pra sessão longa; mais risco que 1-2)
5. T5.5 — 3 quick wins AST sem tree-sitter (cobre ~70% da dor)
6. T5.15-T5.21 — Quick wins (executar em paralelo, ordem por preferência)
7. T5.8 — MCP tool-list cache (gap real, esforço baixo)
8. T5.9 — WebFetch contadores (medir antes de qualquer cache estendido)
9. ~~T5.10~~ — descartado (já implementado em `toolExecution.ts:1762`)
10. T5.6 + T5.7 — Prompts md + formatter (cluster pequeno, após T5.7)
11. P1 restante (T5.11-T5.14) — só com trigger explícito
12. P2 (T5.22-T5.29) — bloqueado por demanda ou esforço alto
