# 02 — Two-tier TTL cache: análise de encaixe e ganhos reais

Follow-up de `docs/archive/discovery/ohmypi/02-two-tier-ttl-cache.md` e `deep/02-two-tier-ttl-cache.md`.
Avaliação concreta no code base atual (`main` @ 1c50523). Sem proposta de
implementação — apenas onde encaixa, quanto se ganha, e onde NÃO encaixa.

## 1. Inventário de caches existentes

Levantamento por `Grep "new LRUCache"`, `cache|TTL` em paths candidatos, e
`ls ~/.claudin/`. Coluna **in-flight coalescing** = existe `Map<key, Promise>`
para deduplicar fetches concorrentes? (resposta = "não" em todos os casos
abaixo, exceto `authCachePromise` que coalesce *leitura* do mesmo arquivo).

### In-process (RAM, sem persistência)

| Site | file:line | Storage | TTL | In-flight coalescing |
|---|---|---|---|---|
| WebFetch URL cache | `src/tools/WebFetchTool/utils.ts:64` | `LRUCache` `maxSize=50MB` | 15 min hard | não |
| WebFetch domain preflight | `src/tools/WebFetchTool/utils.ts:73` | `LRUCache` `max=128` | 5 min hard | não |
| Tool result cache (Read/Glob/Grep/LSP) | `src/agent/tools/toolResultCache.ts:63` | `LRUCache` `max=500` `maxSize=10MB` | por-tool: 15-60 s + mtime check | não |
| Directory completion | `src/terminal/suggestions/directoryCompletion.ts:41,47` | `LRUCache` `max=500` | 5 min hard | não |
| LSP delivered-diagnostics dedup | `src/platform/lsp/LSPDiagnosticRegistry.ts:54` | `LRUCache` `max=500` | sem TTL (LRU only) | n/a |
| Markdown token cache | `src/terminal/markdown/markdownTokenCache.ts:10` | `Map` (LRU manual, cap 500) | sem TTL | n/a |
| File-read cache | `src/shared/fs/fileReadCache.ts` (via `cacheBoundsInvariants.test.ts:163-185`) | FIFO cap 1000 | mtime-gated | não |
| File state cache | `src/shared/fs/fileStateCache.ts:34` | `LRUCache` cap configurável (default ~25 MB) | sem TTL | n/a |
| Tool-progress dedup | `src/agent/queryHelpers.ts` (cap 100, FIFO) | `Map` | sem TTL | n/a |
| Image-store dedup | `src/terminal/image/imageStore.ts` (cap 200, FIFO) | `Set` | sem TTL | n/a |
| Memoize utility (genérico) | `src/shared/data/memoize.ts:242` | `LRUCache` | opcional | não |

### Persistido em disco (`~/.claudin/`)

| Site | file:line | Storage | TTL | In-flight coalescing |
|---|---|---|---|---|
| Model lists | `src/providers/model/modelCache.ts:20,47` | JSON-per-provider em `model-cache/` | 24 h hard, versionado | não |
| Latest version banner | `src/platform/install/latestVersionCache.ts:38,53` | JSON único `latest-version.json` | sem TTL próprio (caller decide via `checkedAt`) | não |
| MCP auth-required cache | `src/mcp/client/authCache.ts:6,29` | JSON único `mcp-needs-auth-cache.json` | 15 min hard | parcial (leitura memoizada via `authCachePromise`) |
| Paste store | `src/terminal/input/pasteStore.ts:8` | files in `paste-cache/` | sem TTL (cleanup por `cutoffDate`) | n/a (content-addressed) |
| File history | `src/shared/fs/fileHistory.ts:54` | `file-history/` por sessão | cap 100 snapshots | n/a |
| Tool result spill | `src/agent/tools/toolResultStorage.ts` | files in `cache/` | sem TTL | n/a |
| V8 bytecode | `~/.claudin/v8cache/` (via `bin/claudin`) | bytecode | invalidado por build | n/a |
| Outros: `backups/`, `sessions/`, `plans/`, `projects/`, `tasks/`, `shell-snapshots/` | — | conteúdo persistente, não TTL-caches | — | — |

### Padrões duplicados (consolidação possível)

- **TTL ad-hoc** em 7+ módulos com timestamps inline: `Date.now() - data.timestamp < TTL_MS` aparece em `modelCache.ts`, `authCache.ts`, `latestVersionCache.ts` (via caller), `directoryCompletion.ts` (delegado ao lru-cache), `toolResultCache.ts`. Cada um reimplementa "valid?".
- **JSON-per-key em `~/.claudin/`** existe duas vezes: `model-cache/<provider>.json` e `latest-version.json`. Schema/version handling é por arquivo. Um `createJsonStore` substituiria ambos com 1 arquivo de utility.
- **Single TTL hard-binário** é universal: nenhum cache existente serve stale + revalida em background. Todos são fresh-or-miss.
- **Tamanho de inventário**: 8 LRUCaches in-process + 5+ caches persistidos. Soft/hard-tier não existe em nenhum.

## 2. Ganhos MEDIDOS (e não-medidos, honestamente)

### Tamanho atual no disco (`du -sh` em `~/.claudin/`, esta máquina)

```
4.0K   model-cache/      ← praticamente vazio (provider nativo Anthropic não cacheia)
4.0K   latest-version.json
324K   cache/            ← 1 arquivo (changelog.md)
104K   paste-cache/      ← 5 arquivos (~13-37KB cada)
45M    file-history/     ← maior cache real
27M    v8cache/
348M   projects/         ← session data, não TTL-cache
```

Conclusão de tamanho: **as TTL-caches em disco são insignificantes hoje (<400 KB combinado, excluindo `file-history` que não é TTL e `v8cache` que é bytecode).** Não há pressão de espaço; há pressão de **latência** (re-fetch síncrono).

### Cobertura de testes que simulam "sessão real"

- WebFetch: `applyPromptFallback.test.ts`, `domainCheck.test.ts` cobrem unidade. **Nenhum bench/integração que simula re-visita de URL.** Não há fixture "50-turn transcript com 30% re-visit" hoje — o bench da deep dive (`scripts/profile/cache-revisit-bench.ts`) é **proposto, não existe**.
- WebSearch: `WebSearchTool.test.ts` (não verificado em detalhe), mas o caminho de fetch é o provider (Firecrawl/DDG) — sem fixture de cache.

### Logging de hit/miss

- `toolResultCache.ts:57-61` mantém `counters = { hits, misses, evictions }` em memória e expõe `getStats()`. **Não há logging persistente nem exposição via slash command.** Hit/miss ratio não é observável pelo usuário.
- Outros caches: nenhum counter exposto. WebFetch e modelCache não logam hit/miss.

**Veredito de medição**: o repo não tem instrumentação para medir o ganho atual. Adotar twoTier exigiria adicionar contadores ANTES de poder afirmar "X% hit ratio". Sem isso, qualquer claim de ganho é teórico.

### Custo concreto de uma re-fetch

Estimativas, não medidas neste ambiente:

- **WebFetch HTTP + Turndown + Haiku summarize**: fetch (50-2000 ms, p95 ~800 ms para docs típicos) + Turndown (~10-50 ms para 100 KB HTML) + chamada `queryHaiku` para resumo (~600-2000 ms, vide `MAX_MARKDOWN_LENGTH=100_000`, `SECONDARY_MODEL_TIMEOUT_MS` no mesmo arquivo). **Re-fetch em soft-window economizaria ~1.5-3 s wall-clock e 1 chamada ao secondary model (~5-15 k input tokens).**
- **WebSearch DuckDuckGo**: até 3 retries com backoff 1 s inicial (`duckduckgo.ts:15-16`); base case ~500-1500 ms. Re-search igual economiza ~1 s e 0 tokens (search não é gasto LLM, mas é gasto wallclock no caminho do agente).
- **modelCache miss (24h)**: bloqueia startup. Para Ollama/NVIDIA/MiniMax/OpenAI = HTTP list-models call (~200-1000 ms). Stale-while-revalidate transformaria 100% das aberturas pós-24h de "espera" em "instantâneo + refresh atrás".

## 3. Onde GANHA de verdade

### 3.1 WebFetch (ALVO PRIORITÁRIO #1)

- Hoje: 15 min hard. Re-fetch da mesma URL no 16º minuto = paga HTTP + Turndown + Haiku do zero.
- Soft/hard `5 min / 60 min`: agentes de research re-visitam docs no mesmo turno ou turnos vizinhos. Hit em soft → instantâneo. Hit em soft/hard → instantâneo + refresh em background. **Economia esperada por re-visita: ~1.5-3 s + ~5-15 k input tokens (chamada Haiku).**
- Storage: in-memory (LRUCache já existe). Não introduz nova superfície em disco. **Risco quase zero, ROI claro.**
- Caveat: requer in-flight Map para evitar 2 fetches paralelos ao mesmo URL durante refresh.

### 3.2 WebSearch (ALVO PRIORITÁRIO #2)

- Hoje: zero cache. LLM re-emite "node fetch deprecation" 3x num turn de research = 3 DDG roundtrips.
- Soft/hard `10 min / 24 h`, chave = `(normalize(query), allowed_domains, blocked_domains)`. **Ganho = 100% da latência em re-search igual.**
- Storage: in-memory pequeno (cap 64). Sem disco — resultados de search são third-party content, não devem persistir (ver §5).
- Caveat semântico: o LLM esperaria resultados frescos? Para "latest" queries, hard TTL deve ser curto (1 h?). Documentar trade-off.

### 3.3 modelCache (ALVO SECUNDÁRIO)

- Hoje: 24 h hard, **bloqueia startup** se expirado em provider Ollama/NVIDIA/MiniMax/OpenAI.
- Soft/hard `24 h / 7 d`: startup nunca espera HTTP. Refresh em background atualiza lista para próximo launch.
- Ganho real: ~200-1000 ms de p95 startup eliminados quando cache idoso. Em provider Anthropic nativo, `modelCache` nem é usado (`isOpenAICompatibleProvider()` filtra) — não há ganho lá.
- **Encaixa bem mas o win é só no startup pós-24h. Ganho de UX, não de loop de agente.**

### 3.4 latestVersionCache (CANDIDATO MARGINAL)

- Hoje: caller (`startupUpdateCheck.ts`) decide TTL via `checkedAt`. Banner já lê sync e renderiza instantaneamente.
- twoTier substituiria a gate-by-checkedAt no caller, mas o comportamento de UX já é "instant + background refresh" de facto. **Refactor cosmético, não ganho real.**

## 4. Onde NÃO ganha (e portanto NÃO encaixa)

- **Provider presets** (`providerConfig.ts:592` e arredores): estáticos no build time. Recomputo é nanosegundos. `getAdditionalModelOptionsCacheScope()` é útil como `scope` para outros caches, NÃO como valor cacheado.
- **MCP tool listings / capabilities** (`src/mcp/client/fetchCapabilities.ts`): mudam por conexão, e a conexão já é estável durante a sessão. TTL adicionaria invalidação que o ciclo de conexão MCP já governa.
- **MCP auth-cache** (`authCache.ts`): já é hard 15 min, JSON em disco, com leitura memoizada. Conceito = "ainda precisa de auth?" — não há ganho em servir stale; ou ainda precisa, ou não.
- **Tool result cache (Read/Glob/Grep/LSP)** (`toolResultCache.ts`): já tem TTL curto (15-60 s) + mtime-check no path. Stale-while-revalidate seria perigoso — servir Read stale enquanto arquivo mudou no disco viola contrato. Mantém como está.
- **File-read / file-state / file-history caches**: content-addressed ou mtime-gated. Soft/hard não acrescenta.
- **Markdown token cache, LSP dedup, image-store, tool-progress**: caches de dedup/render, sem semântica de freshness external. Irrelevante.
- **Directory completion** (`directoryCompletion.ts`): 5 min ttl, latência local fs. Refresh em background economizaria ~5-20 ms — não vale complexidade.
- **Paste store, file-history**: content-addressed / snapshot. Não são TTL-caches.

## 5. Riscos reais (não teóricos)

### 5.1 Persistência de conteúdo web em disco

**O ataque concreto**: se WebFetch/WebSearch passassem a persistir resultados em `~/.claudin/cache/web-fetch/*.json`:

- **Leak via crash bundler / log share / `/bug` report**: hoje o repo NÃO tem crash-reporter automático (telemetria stubada), mas o caminho `~/.claudin/cache/` não é listado em nenhum exclude doc. Qualquer dev futuro que adicione "include `~/.claudin/cache/` no diagnostic bundle" vaza conteúdo de terceiros vistos pelo usuário (URLs internas, search queries privadas).
- **Cross-user leak em ambientes multi-tenant**: arquivos sob `~/.claudin/` herdam umask. omp usa `0o600` explícito em `github-cache.ts:82`. Claudin precisa do mesmo se for ao disco.
- **Chave não-namespaced**: omp namespaces por hash de `GH_TOKEN`. WebFetch não tem identity natural por URL — risco menor de cross-account leak, mas conteúdo `https://internal.company.com/...` ainda é sensível. **Per-host como pseudo-scope é defesa mais fraca que per-auth-key.**

**Compatibilidade com `verify:privacy`**: o script (`scripts/verify-no-phone-home.ts`) escaneia `dist/cli.mjs` por banned patterns de phone-home. **Ele NÃO inspeciona conteúdo persistido em runtime sob `~/.claudin/`.** Adicionar cache de web em disco não falha o gate atual — mas é exatamente o tipo de superfície que o gate NÃO cobre, então a salvaguarda recai 100% sobre code review e documentação.

**Recomendação concreta para fit**: **WebFetch/WebSearch → in-memory only.** Disco fica reservado para `modelCache` / metadados não-sensíveis. Re-avaliar após audit de quais URLs o agente realmente re-visita.

### 5.2 Sweep concorrente entre múltiplas sessões

omp usa SQLite single-writer com WAL — múltiplos processos podem ler em paralelo, escritas serializam. Claudin com JSON-per-key:

- **Race write/write**: dois processos rodando `setMcpAuthCacheEntry` simultaneamente sobrescrevem (cada um lê snapshot, escreve seu). `authCache.ts` resolve com `writeChain` interno mas só *dentro do mesmo processo*. Entre processos é race.
- **Race sweep/read**: processo A apaga arquivo expirado durante processo B lendo → ENOENT silencioso, falha para "miss". Aceitável.
- **Solução**: `createJsonStore` precisaria de `fs.rename` atomic-swap (write tmp → rename) e tolerar ENOENT em leitura. SQLite resolveria sem custo. Mas: adicionar `bun:sqlite` runtime dep é decisão pesada para o build (verify:privacy, no-telemetry-plugin assume listagem fechada de módulos).

### 5.3 Race no refresh (in-process)

Dois reads stale concorrentes agendam 2 `queueMicrotask(refresh)` → 2 HTTP calls. omp aceita; Claudin em loop apertado (LLM emite mesma URL 5x num turn) amplifica upstream 5×. **In-flight `Map<key, Promise>` é obrigatório**, não opcional.

## 6. Veredito

**Generalizar util OU caso-a-caso?**

Argumentos pró-util genérica:
- 3 alvos viáveis (WebFetch, WebSearch, modelCache) compartilhariam soft/hard + in-flight coalescing.
- Já existem ~7 locais com TTL ad-hoc reimplementado — utility reduz duplicação.
- `createMemoryStore` é trivial (wrap LRUCache); `createJsonStore` quase trivial.

Argumentos contra:
- 2 dos 3 alvos (WebFetch, WebSearch) querem **só memória** por motivo de segurança. modelCache quer disco. Compartilham só o algoritmo, não o store — abstração paga peso.
- Sem bench/instrumentação, otimizar 3 sites de uma vez é risco-on-risco.

**Decisão recomendada**: util genérico **pequeno e in-memory-first**. Disco só atrás de `TwoTierStore` opcional, NÃO obrigatório. Adoção faseada: começa por **WebFetch (alvo #1)** porque (a) reutiliza o LRUCache que já existe, (b) ganho mensurável e isolado, (c) zero superfície nova de disco, (d) serve de proof-of-concept para a utility antes de tocar WebSearch (que muda contrato semântico de freshness).

### Alvos prioritários, ganho esperado

1. **WebFetch** (`src/tools/WebFetchTool/utils.ts:64`): soft 5 min / hard 60 min, in-memory, com in-flight Map. **Ganho/revisita: ~1.5-3 s wall-clock + ~5-15 k input tokens (Haiku skip).** Frequência: alta em sessões de research (LLM re-visita docs).
2. **WebSearch** (novo cache em `WebSearchTool.ts`): soft 10 min / hard 1-24 h conforme decisão de UX, in-memory, cap 64. **Ganho/re-search: ~500-1500 ms wall-clock, 0 tokens.** Frequência: média.

`modelCache` fica para fase 2 (disco, semântica diferente). `latestVersionCache` fica como refactor opcional.

### Métrica de validação antes/depois

Antes de implementar: adicionar counters `{ hits, misses, stale, miss, disabled }` no WebFetch atual (uma sessão, uma semana de uso real). Se hit-ratio existente < 5%, o caso não justifica nem twoTier. Se ≥ 20%, twoTier ganha sobre o miss residual. **Não otimizar sem essa medição.**

---

**Vale a pena: CONDICIONAL** — porque o ganho técnico é claro e isolado em WebFetch + WebSearch (instantaneidade em re-visita + economia de tokens no secondary model), mas o repo não tem hoje instrumentação de hit/miss nem bench de re-visita; adotar sem medir é otimização cega. Implementar twoTier in-memory para WebFetch primeiro, com contadores expostos via `/provider doctor` ou comando similar, e só estender a WebSearch/modelCache depois de observar hit-ratio real em sessão de uso. Persistência em disco para conteúdo web fica explicitamente fora do escopo da v1 por razão de privacidade (`~/.claudin/cache/` não está coberto por `verify:privacy` nem documentado como excluído de eventuais bundles diagnósticos).
