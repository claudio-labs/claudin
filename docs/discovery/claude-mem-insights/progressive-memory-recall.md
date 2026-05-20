# Progressive Memory Recall — 3-layer retrieval

> **Fonte:** `claude-mem` repo, `plugin/skills/mem-search/SKILL.md`, `src/servers/mcp-server.ts:459-519`, `src/services/worker/search/`.
> **Verificado contra o repo em 2026-05-19** — a ordem das camadas estava errada no rascunho anterior; ver "Correções pós-verificação".

## Ideia

Em vez de injetar toda a memória no system prompt no boot, o LLM **busca sob demanda** em três tools de granularidade crescente. O `SKILL.md:8` resume o workflow como `search -> filter -> fetch`. É a técnica responsável pela maior parte do claim de ~10× do `claude-mem`.

| Ordem | Tool | mcp-server.ts | O que devolve | Custo |
|---|---|---|---|---|
| 1. Index | `search` | :459-481 | Tabela markdown `\| ID \| Time \| T \| Title \| Read \| Work \|` — **só títulos, sem subtitle** | ~50-100 tok/linha |
| 2. Context | `timeline` | :482-500 | Janela cronológica em torno de um `anchor`: `depth_before + 1 + depth_after` itens (observations/sessions/prompts interleaved) | variável |
| 3. Detail | `get_observations` | :501-519 | Objetos completos: title, subtitle, narrative, facts, concepts, files — só dos `ids` pedidos | ~500-1000 tok cada |

Workflow forçado pelo `SKILL.md` (`## 3-Layer Workflow (ALWAYS Follow)`, `:18-20`):

> "NEVER fetch full details without filtering first. 10x token savings."

Nunca pular direto para a camada 3. Primeiro `search` devolve o índice com IDs; o agente escolhe os IDs relevantes; só então `get_observations` carrega narrative completa. `timeline` é a camada de *contexto* — usada para ver o que aconteceu antes/depois de uma observação âncora.

**Resultado:** carrega O(K) onde K = memórias relevantes à task atual, em vez de O(N) = todas as memórias do projeto. Em projeto longevo (100+ memórias), é a economia central.

### Trick interessante — preço visível antes da compra

A tabela do `search` carrega uma coluna **`Read`** com o custo estimado de fazer fetch daquela linha (`estimateReadTokens`, `ResultFormatter.ts:222-228` — `(title+subtitle+narrative+facts).length / 4`). O LLM vê o **preço de cada fetch antes de decidir buscá-lo** — um nudge de budget embutido no próprio output. Há também coluna `Work` com `discovery_tokens` (esforço que gerou a observação).

## Hybrid search — como REALMENTE funciona

`SearchOrchestrator.executeWithFallback` (`SearchOrchestrator.ts:61-88`) decide a estratégia:

- **Sem `query` → `SQLiteSearchStrategy`** — filtro SQL puro, sem etapa vetorial.
- **Com `query` → `ChromaSearchStrategy`** — **vector-first**: Chroma devolve até `CHROMA_BATCH_SIZE=100` hits → `filterByRecency` descarta tudo > 90 dias → categoriza por doc-type → hidrata do SQLite aplicando filtros type/concept/file **durante a hidratação**.
- **`HybridSearchStrategy.search()` é um stub** (`HybridSearchStrategy.ts:35-43`) — sempre retorna vazio. O filtro-antes-de-rankear genuíno só existe nos métodos `findByConcept`/`findByType`/`findByFile`, expostos pelos endpoints `/api/search/by-*` — **não** no tool `search` principal.

**Correção importante:** o tool `search` mais usado NÃO é filter-first. É vector-first, e os filtros keyword/type/concept são aplicados *depois* da query vetorial, na hidratação SQLite. Verdadeiro filter-then-rank só nos endpoints `by-*`.

### Papéis de cada store

- **ChromaDB** — só índice vetorial: devolve IDs + distâncias + metadata, nunca o registro canônico. IDs codificam tipo+ID SQLite na string (`obs_123_`, `summary_45_`).
- **SQLite** — (a) filtragem keyword via FTS5 (`observations_fts`) + `LIKE`/`json_each` sobre tags/type/concept/files; (b) storage autoritativo — `getObservationsByIds` é a fonte do registro completo.

### Gotcha — cliff de 90 dias

`ChromaSearchStrategy` descarta hits > 90 dias (`RECENCY_WINDOW_MS`, `types.ts:7-8`). Um `search` semântico **não consegue trazer nada com mais de 90 dias** — só o path SQLite filter-only (sem `query`) ou um `dateStart` explícito alcança memória antiga.

## Como o Claudio faz hoje

`src/memdir/` injeta `MEMORY.md` **inteiro** no system prompt + os arquivos `.md` julgados relevantes. Funciona bem com poucas memórias, mas:

- `MEMORY.md` cresce linearmente — o próprio system prompt avisa "linhas após 200 serão truncadas"
- Truncamento é cego: corta por ordem de arquivo, não por relevância
- Memórias de baixa relevância à task atual pagam tokens em **toda** a sessão

A filosofia "memória curada, não transcript" o Claudio já tem. O que falta é o **acesso sob demanda**.

## Proposta

**`MemorySearchTool`** — uma tool built-in (não MCP externo) em `src/tools/MemorySearchTool/` espelhando o padrão de 3 camadas:

```
mode: "search"   → lista title de MEMORY.md (privado + team) filtrável por keyword/type/concept
mode: "context"  → vizinhança de uma memória (memórias relacionadas por arquivo/tópico)
mode: "fetch"    → recebe nomes de arquivo, devolve conteúdo completo
```

Espelhar o trick do preço visível: cada linha de `search` traz custo estimado de fetch.

**Mudança no boot do REPL:** em vez de despejar `MEMORY.md` + arquivos relevantes, injetar só:

- O índice `MEMORY.md` compacto (já é one-liner por entrada — barato)
- Uma instrução: "use `MemorySearchTool` para carregar memórias específicas quando relevante"

Memórias deixam de ser custo fixo da sessão e viram custo sob demanda.

### Trade-off honesto

- **Contra:** adiciona round-trips de tool. Memória que hoje "já está lá" passa a custar uma chamada. Para sessões curtas com poucas memórias, pode ser pior.
- **A favor:** escala. Em projeto com 200 memórias, hoje ou trunca (perde sinal) ou paga ~30k tokens fixos por sessão.
- **Meio-termo:** manter injeção direta de memórias `feedback` e `user` (sempre relevantes, poucas) + recall sob demanda só para `project` e `reference` (numerosas, contextuais).

## Vector search — fazer ou não?

O `claude-mem` usa ChromaDB (processo separado). Para o Claudio isso seria peso demais.

**Se** vector search valer a pena: `sqlite-vec` — extensão WASM, ~1 MB, roda dentro do mesmo processo, sem daemon. Mas note que **mesmo no claude-mem o `HybridSearchStrategy` é um stub** — o filtro estrutural via SQLite/FTS5 carrega o trabalho de verdade. **Provavelmente não vale na v1 do Claudio.** Com dezenas (não milhares) de memórias, keyword + filtro estrutural já resolve. Registrar como follow-up, gate por `feature('MEMORY_VECTOR_SEARCH')`.

## Decisões abertas

1. **Híbrido (injeta feedback/user, recall para project/reference) vs recall total?** Recomendação: híbrido — preserva "feedback nunca esquecido" sem pagar O(N).
2. **`MemorySearchTool` aparece sempre ou só quando há > N memórias?** Registro condicional no tool registry evita poluir o tool surface de projetos sem memória.
3. **Como o LLM sabe que deve buscar?** Precisa de guidance no system prompt. Risco: modelo esquece de buscar. Mitigação: manter o índice `MEMORY.md` sempre visível como gatilho.
4. **Replicar o cliff de 90 dias?** O claude-mem esconde memória antiga do search semântico. Para o Claudio, memória `feedback`/`user` antiga ainda é válida — NÃO copiar o cliff cego; se houver vetor, recência deve ser sinal de rank, não filtro duro.

## Correções pós-verificação (2026-05-19)

| Claim original | Status | Correção |
|---|---|---|
| Camada 1 = `timeline` (title+subtitle) | ❌ | Camada 1 = **`search`**, tabela com **só títulos**. `timeline` é a camada 2 |
| Camada 2 = `search` (facts dos top-K) | ❌ | Camada 2 = **`timeline`** — janela cronológica em torno de um anchor, não facts de candidatos |
| Camada 3 = `get_observations` | ✓ | Confirmado |
| Hybrid filtra SQL/FTS **antes** do rank vetorial | ⚠️ | Verdade só nos endpoints `by-concept/by-type/by-file`. O tool `search` principal é **vector-first**; `HybridSearchStrategy.search()` é stub |
| `SKILL.md:94, 124-127` | ✓ | Confirmados |

## Arquivos de referência (claude-mem)

| Tema | Arquivo:linha |
|---|---|
| 3 tools de recall | `src/servers/mcp-server.ts:459, 482, 501` |
| Workflow 3-layer | `plugin/skills/mem-search/SKILL.md:18-20, 94, 124-127` |
| Orquestração de busca | `src/services/worker/search/SearchOrchestrator.ts:61-88` |
| Hybrid (stub) | `src/services/worker/search/strategies/HybridSearchStrategy.ts:35-43` |
| Coluna de custo no output | `src/services/worker/search/ResultFormatter.ts:222-228` |
