# Claudio — Roadmap Técnico

> Última auditoria: 2026-05-03 | ROI honesto, sem itens marginais

Roadmap enxuto após auditoria contra o código real. Itens marginais, obsoletos e overengineering foram removidos. Mantém só o que **vale a pena de verdade** + histórico do que já foi feito.

---

## Ativos (7 itens)

### 5.7 — Cap/poda de `QueryEngine.mutableMessages` em sessões longas
- **Esforço:** M (decisão arquitetural + implementação)
- **Prioridade:** P1
- **Estado:** `mutableMessages: Message[]` (`src/QueryEngine.ts:187`) cresce sem cap por toda a sessão. Append sites: `:432` (user input), `:782` (assistant), `:786` (progress), `:799` (tool_results), `:844` (attachment). Tool_results de FileRead/Bash/Grep facilmente reach 50-200 KB cada e ficam retidos até `/clear`. Bench novo `scripts/profile/query-engine-mem-bench.ts` mostra **~232 KB RSS/turno** com tool_results de 50 KB; em 500 turnos = +113 MB RSS. Heap V8 fica 0 (strings vão pra `external`), invisível no `long-session-bench.ts` antigo. autocompact (5.0) mitiga via heap pressure mas só dispara perto do limit; não há proteção contínua.
- **Ganho:** Reduzir RSS em sessões longas reais (2h+) onde autocompact ainda não disparou. Prevenir OOM em hardware com pouca RAM.
- **Abordagem (a decidir):** (a) cap absoluto em N mensagens com FIFO eviction de tool_results antigos, (b) compressão proativa de tool_results > X KB após Y turnos (substitui por stub, mantém tool_use_id), (c) TTL por tool_use_id. Opção (b) preserva caching prefix-stable do Anthropic (já documentado em team memory `feedback-cache-stable-compression.md`). Bench e regressão em CI usando `query-engine-mem-bench.ts`.
- **Arquivos:** `src/QueryEngine.ts`, possivelmente `src/services/compact/` (reuso de stable-stub design existente).

### 5.8 — `fileReadCache.clear()` não libera RSS V8
- **Esforço:** S (investigação + escolha entre fix ou doc)
- **Prioridade:** P1
- **Estado:** Bench novo `scripts/profile/file-read-cache-saturation-bench.ts` mostra que após saturar 1000 entries × 256 KB (~505 MB RSS), chamar `cache.clear()` não devolve RSS — V8 retém o heap mesmo com Map vazio e GC explícito. LRU funciona durante churn (drift 0.8% em 3 rounds) mas low-mem recovery via `clear()` é ineficaz. Não é leak (steady state estabiliza), mas usuários que usam `/clear` esperando liberar RSS ficam frustrados.
- **Ganho:** Recovery real de memória em situações de pressão (low RAM, OOM iminente). Ou pelo menos documentar a limitação.
- **Abordagem:** (a) substituir Map por estrutura que solte `string` refs (atribuir cada entry a um wrapper, anular wrapper em vez de só `Map.delete`), (b) chamar `gc()` explícito após `clear()` quando `--expose-gc` ativo (já é default no launcher), (c) doc-only: README do bench + comentário no código. Decidir após reproduzir em sessão real.
- **Arquivos:** `src/utils/fileReadCache.ts`, possivelmente `src/commands/clear/`.

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

---

## Concluídos ✅

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

**5 ativos** (1× P0: 4.1; 3× P3: 5.2/5.3b/5.1b; +3.12 sem prio) + **16 concluídos**.
