# Roadmap — Claudio

Itens priorizados por ROI (ganho / esforço). Atualizado em 2026-05-16.

Convenção: cada item tem **Arquivo**, **Problema**, **Ganho**, **Esforço**, **Risco** e checkbox de status.

---

## Tier 1 — Quick wins (esforço baixo, risco baixo)

### [x] 1. Regex em escopo de módulo
- **Arquivos:** `src/services/api/providerConfig.ts:237-240,295,362,395,566`, `src/services/api/withRetry.ts:63`, `src/services/api/cacheMetrics.ts:147-152,526-527`
- **Problema:** Regex compilada dentro de funções em hot path. Viola `.claudio/rules/typescript-patterns.md`.
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

> Adicionado em 2026-05-25. Síntese de 3 ondas de análise (insight → deep-dive → fit → gap) comparando `oh-my-pi` com Claudio. Cada item aponta para o doc de estudo mais profundo (preferindo `gap/` quando ele revisa o original, depois `fit/`, depois raw).
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
- **Problema:** Sem convenção uniforme em `.claudio/rules/*.md` e skills — `**MUST**` vs `NEVER`, ASCII triplo-ponto vs `…`, etc.
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
- **Extensão:** infra extraída pra `src/tools/shared/twoTierCache.ts` e aplicada também no `WebSearchTool` (paths adapter + codex, modo no-stale, TTL 60s). Native streaming fica fora. Plano: `~/.claudio/plans/immutable-giggling-oasis.md`.

#### [x] ~~T5.10 Prefix-invalidation triggers em `toolResultCache`~~ — **descartado (já implementado)**
- Validação 2026-05-27: `toolExecution.ts:1245` já chama `invalidateCacheForWrite` após cada tool; dispatcher em `:1762-1779` cobre `FileEditTool`/`FileWriteTool`/`NotebookEditTool` (→ `invalidateForPath`) e `BashTool`/`PowerShellTool` (→ `invalidateAll`). `LSPTool/workspaceEdit.ts` também invalida em rename/edit. `invalidateForPath` faz prefix-match bidirecional (`toolResultCache.ts:150-164`) → write em vizinho derruba Grep/Glob cacheado. Testes em `toolResultCache.test.ts:108-128`. A premissa do roadmap (linha `:63` só checa mtime do próprio file) estava errada: `:63` é o construtor do LRU; o mtime self-check (`:92-105`) só roda pra `Read`.

#### [ ] T5.11 `report_tool_issue` JSONL local-only
- **Problema:** `isError` propaga em 15 arquivos sem coleta agregada; zero sinal estruturado de bugs de tool.
- **Ganho:** médio — feedback loop interno (especialmente filter / plan mode / openai shim).
- **Storage:** JSONL append-only em `~/.claudio/projects/<dir>/tool-issues/YYYY-MM.jsonl` (fora do scan de memdir, que só ingere `.md`).
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
- **Ganho:** DX — `~/.claudio/projects/<dir>/breadcrumbs/<tty-hash>.txt` com último session id.
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

Claudio já tem LSP forte (13 ops, 12 servers embarcados em `src/services/lsp/builtinServers.ts:461-609`) e `scanSymbols` regex-puro em `src/tools/shared/codeOutline/scanSymbols.ts`, mas o agente:

- **Lado Search** — cai em Grep regex (texto ruidoso, sem resolução simbólica) mesmo quando LSP entregaria a resposta correta em 1 chamada (`prepareCallHierarchy`, `findReferences`).
- **Lado Read** — lê arquivos inteiros (~6k tokens) quando precisa mexer em 40 linhas. Já existe `Read view='outline'` e `Read symbol='nome'` que reduzem 10-20×. Quase não é usado.

Esses dois pontos (**T6.1** e **T6.6**) são o coração do Tier — tweak de tool descriptions, custo de horas, ganho potencialmente desproporcional. Os outros itens (`/review` orquestrado, cache, índice) são consequências derivadas, gated por evidência empírica.

Itens nasceram do estudo de `code-review-graph` (`docs/discovery/code-review-graph/00-insights.md` → `09-roadmap-validation.md`) **com revisões críticas aplicadas**: o que parecia infra nova quase sempre vira "fazer o agente usar o que já existe". Evita o overclaim que o próprio CRG comete (ver `02-arquitetura-e-mecanismo.md §9`).

Ordem: **T6.1 + T6.6 em paralelo (core) → medir → decidir tudo mais**. T6.4 dropado. T6.5 em DEFER.

### [ ] T6.1 Tool descriptions de LSPTool/GrepTool com tabela de mapeamento
- **Arquivos:** `src/tools/LSPTool/prompt.ts`, `src/tools/GrepTool/prompt.ts`
- **Problema observado:** o agente (e o Explore agent, `src/tools/AgentTool/built-in/exploreAgent.ts:38-54`) cai em Grep para queries simbólicas (callers, refs, definição, hierarquia) mesmo quando o arquivo tem LSP server ativo. Causa: a description do GrepTool é assertiva ("ALWAYS use Grep"), a description do LSPTool não disputa o terreno, e Grep tem latência percebida menor (~100ms vs ~100-500ms da primeira chamada LSP).
- **Mudança:**
  - Em **GrepTool**, nota que regex casa **texto** (inclui comentários, strings, docs, homônimos) — para callers/refs de símbolo real, prefira LSPTool quando o arquivo tem server ativo.
  - Em **LSPTool**, tabela explícita de mapeamento que substitui a heurística "regex resolve":

    | Pergunta do agente | Hoje (Grep) | Melhor (LSP) |
    |---|---|---|
    | "Onde X é chamada?" | match textual ruidoso | `findReferences` |
    | "Quem chama X recursivamente?" | impossível sem N rodadas | `prepareCallHierarchy` + `incomingCalls` (árvore real) |
    | "Quais funções existem em foo.ts?" | `Grep symbols` (regex) | `documentSymbol` (AST do compilador) |
    | "Onde está a definição de X?" | Grep + ler arquivos | `goToDefinition` |
    | "Onde o type X é usado?" | Grep "X" → ruído de variáveis homônimas | `findReferences` resolve tipo vs valor |

  - **Fallback explícito:** linha na description do LSPTool no formato "se o tool retornar `No LSP server available for file type` (`LSPTool.ts:394-399`), o arquivo não tem server — caia em Grep/Read normalmente". Linguagens cobertas listadas em `src/services/lsp/builtinServers.ts:461-609`; fora dessa lista (Ruby, PHP, Swift, Bash, Markdown, etc.) Grep continua sendo o caminho certo.
  - **NÃO** mexer em system prompt dos agentes (`exploreAgent.ts`/`planAgent.ts`/`generalPurposeAgent.ts`) — risco de bloat sem efeito mensurável (`09-roadmap-validation.md §2 Eixo 1`).
- **Por que isso pode funcionar:** o agente escolhe tool por descriptions; a heurística "Grep responde rápido" só vale enquanto ele não enxerga que `findReferences` resolve em 1 chamada o que Grep resolve em 3-5 + filtragem manual. A tabela é o ponto de inflexão.
- **Ganho:** baixo-médio — **Esforço:** trivial (horas) — **Risco:** baixo.
- **Kill criteria:** se A/B de 1 semana mostrar <5% de aumento em chamadas `LSPTool` por sessão, reverter.
- **Contexto:** o insight da "árvore mental via LSP" está discutido em detalhe no histórico de discovery — o agente hoje **não constrói árvore**, faz N greps independentes. O caminho de baixo custo para a árvore real é `prepareCallHierarchy` + `incomingCalls` (recursivo, lazy), e isso só será usado se a description disser. Sem nova infra.

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
- **Pré-requisito de medição:** rodar **depois** de T6.1. Se T6.1 reduzir queries redundantes, o ganho de T6.3 cai — avaliar antes de comprometer (`09-roadmap-validation.md §3`).
- **Kill criteria:** se hit-rate <30% em 100 sessões instrumentadas, remover.

### [ ] T6.6 Leitura cirúrgica via outline + symbol-targeted reads + call graph
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
- **Por que isso pode funcionar:** ganho é **input-side** (tokens de leitura), distinto do T6.1 que é search-side. Em tarefas de modificação localizada em codebase não-familiar, redução estimada de 10-20× no input por ciclo (medir empiricamente).
- **Fallback:** se o arquivo não tem outline parseável (linguagem não coberta por `scanSymbols`/LSP), agente cai em `Read` normal. Sem regressão.
- **Ganho:** **médio-alto em input tokens** (depende muito do tipo de tarefa) — **Esforço:** baixo (horas, só descriptions) — **Risco:** baixo.
- **Kill criteria:** se em 20 sessões instrumentadas a redução de input tokens for <20% para tarefas de edição localizada, reverter — provavelmente sinal de que o agente está fazendo outline + read symbol + acabando lendo full file mesmo assim (dupla leitura).
- **Sequenciamento sugerido:** rodar **junto com T6.1**. São complementares: T6.1 ensina como achar o símbolo certo; T6.6 ensina a ler só ele.

### [ ] T6.7 Plan dossier com anchors de linha + símbolo + capturas LSP
- **Arquivos:** `src/services/planDossier.ts` (`Dossier` type linha 70, `DossierEntry` union linha 68, `ReadEntry` linha 31), `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`, `src/tools/ExitPlanModeTool/prompt.ts`.
- **Já existe:** o dossier hoje monitora Read/Grep/Glob durante plan mode e empacota o conteúdo dos arquivos em `filesToEdit` para o implementador (`planDossier.ts:31-77`). O implementador recebe arquivos completos, **não anchors**.
- **Problema observado:** `filesToEdit` é só lista de paths. Em arquivo de 1000 linhas, o implementador precisa re-localizar o ponto de mudança via Grep/Read. Output de LSP rodado no planejamento (callers, refs, hierarquia) não persiste — se o planner descobriu que `login` em `auth.ts:120-145` é o ponto, isso é jogado fora.
- **Mudança:**
  1. Estender `filesToEdit` no schema de `ExitPlanMode` para aceitar `{path, lineRange?, symbol?}` em vez de `string[]` puro (com retrocompatibilidade — `string` continua válido como path puro).
  2. Adicionar `LspEntry` à union `DossierEntry`: resultado de `findReferences`/`incomingCalls`/`documentSymbol` que o planner rodou, anchorado em `(path, line, symbol)`.
  3. `ExitPlanMode` prompt orienta planner: "se você sabe a linha/símbolo onde mexer, declare em `filesToEdit`; se rodou LSP durante o plan, esses resultados ficam no dossier".
  4. Render do dossier prioriza `lineRange` quando presente — passa só o trecho relevante via `Read symbol='X'` ou `Read offset/limit`, não o arquivo todo (sinergia direta com T6.6).
- **Por que faz sentido agora:** combina T6.1 (LSP para achar o ponto), T6.6 (ler só o símbolo) e o dossier já existente. Sem isso, T6.1 e T6.6 ajudam o planner mas a informação morre na transição plan → implementação.
- **Ganho:** **médio-alto em input tokens do implementador** + reduz tempo de "re-orientação" no início da implementação — **Esforço:** baixo-médio (~3-5 dias; schema change + render change + 1 entry type novo) — **Risco:** baixo (retrocompat preservada).
- **Kill criteria:** se em 20 sessões de plan o planner não usar `lineRange`/`symbol` em mais que 30% dos `filesToEdit`, reverter para schema só-path. Sinal de que a description não convenceu.
- **Sequenciamento:** depois de T6.1 e T6.6 (planner precisa estar usando LSP/symbol-read antes de adiantar capturar isso).

### [~] T6.4 Wiki auto-gerada — **DROPADO**
- **Razão:** validação RED (`09-roadmap-validation.md §2 Eixo 3`). Template vazio em `src/services/wiki/init.ts:6-37` é scaffold deliberado, não dor; saída em monorepo TS de 200+ arquivos seria ruidosa; duplica `claude-code-guide` agent + `docs/`.
- **Substituto leve:** se houver demanda real, melhorar o template em `init.ts` com seções pré-populadas a partir de `Read view='outline'` da raiz — sem walker recursivo, sem summarizer LLM.

### [ ] T6.5 Índice persistente cross-sessão — **DEFER**
- **Bloqueio:** só considerar depois de T6.2b e T6.3 mostrarem valor real e adoção. Único item que tocaria `verify:privacy` (team memory `verify-privacy-bundle-only`).
- **Doc:** `docs/discovery/code-review-graph/03-fit-no-claudio.md` + `06-onde-ganho-real.md`.

### Receita doc-only (paralelo, custo ~30min)
- **Arquivo a criar:** `docs/recipes/code-review-graph-mcp.md`
- **Conteúdo:** snippet de `settings.json` para usuários power plugarem o CRG como MCP server externo opcional, com disclaimer "ganhos variam por commit; rode seu próprio benchmark" (`03-fit-no-claudio.md` caminho (a)).

---

## Limpeza oportunista

- [ ] **CHICAGO_MCP cleanup duplicado** em `src/query.ts:1060` e `1621` — flag está `false` em `build.ts`; código morto no open build. Unificar ou gate explícito.
- [ ] **`useMemo(() => false, [])`** em `src/screens/REPL.tsx:618` — slot de hook gasto para constante.
- [ ] **gRPC vaporware em docs** — `CLAUDE.md:40-41,90` e `README.md:66` referenciam `src/grpc/`, `src/proto/`, scripts `dev:grpc*` que não existem no código. Limpar ~5 linhas. Registrado em team memory `grpc-vaporware-in-docs.md`.
- [ ] **`FileEditTool` sem teste unitário direto** — único `.test.ts` cobre só LSP diagnostics. Lógica de match / `replace_all` / quote-normalization sem cobertura.

---

## Ordem sugerida de execução

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

1. T6.1 — tool descriptions LSPTool/GrepTool (horas, medir baseline antes)
2. T6.6 — leitura cirúrgica via outline+symbol+outgoingCalls (horas, **rodar junto com T6.1**)
3. Receita doc-only do CRG MCP (paralelo, 30min)
4. T6.2a — parser de hunks no `/review` (~3 dias)
5. **Gate de medição** — T6.1+T6.6 mexeram em tool ratios e input tokens? T6.2a foi usado?
6. T6.2b — risk score com LSP (só se 2a validar)
7. T6.7 — plan dossier com anchors+LSP captures (depende de T6.1+T6.6 ativos)
8. T6.3 — cache `documentSymbol` (só se T6.1+T6.6 deixarem ganho residual)
9. T6.5 — índice persistente (DEFER, reavaliar em 3 meses)

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
