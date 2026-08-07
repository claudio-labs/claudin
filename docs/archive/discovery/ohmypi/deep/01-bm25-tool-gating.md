# 01 — BM25 tool gating (deep dive)

## Resumo executivo

- omp (`oh-my-pi`) usa BM25 sobre nome/label/summary/schemaKeys das tools, mas o ranking **não roda automaticamente por turno**: ele é exposto como uma tool (`search_tool_bm25`) que a LLM chama explicitamente para "descobrir e ativar" tools `loadMode: "discoverable"`. Uma vez ativadas, persistem no set ativo da sessão.
- Claudin já tem o **mesmo padrão arquitetural** implementado (`ToolSearchTool` + `shouldDefer`/`alwaysLoad`), mas hoje ele só roda em provedores Anthropic 1P (depende do content-block beta `tool_reference`). Em DeepSeek/Groq/OpenRouter/etc. ele é desligado por `isToolSearchEnabledOptimistic()`.
- Wire-size real medido (`bun test scripts/measure-tool-schemas.test.ts` rodado localmente): **~18.3 k tokens** de schema por turno (anthropic), com top‑10 tools consumindo ~10.3 k. Cortar a cauda longa para ~5 tools defer-able salvaria ~4–6 k tokens/turno em provedores OpenAI-compat.
- Oportunidade real, e MVP enxuto: estender o gating já existente para **provedores não‑Anthropic**, sem `tool_reference` — ativar tools mutando o tool-set da próxima request em vez de injetar via content block.
- Métrica de sucesso: redução de **≥25%** nos `schemaBytes` enviados na 1ª request de um turno em OpenAI-compat, sem regressão de tool-calling em um eval básico (Bash/Read/Edit em 95% dos turnos).

## Como omp implementa

### Índice BM25

Arquivo: `/home/dev/projects/oh-my-pi/packages/coding-agent/src/tool-discovery/tool-index.ts`.

- **Corpus por tool** (`buildSearchDocument`, linhas 143‑155): concatena com pesos
  - `name` ×6, `label` ×4, `mcpToolName` ×4, `serverName` ×2, `summary` ×2, `schemaKey` ×1 (constantes em `FIELD_WEIGHTS`, linhas 93‑100).
  - `summary` cai para os primeiros 200 chars de `description` quando ausente (linha 183).
- **Tokenização** (`tokenize`, linhas 115‑134): NFKD + strip de combining marks; split em ACRONYMBoundary (`MCPTool` → `MCP Tool`) e camelCase/digit→letter (`fooBar` → `foo Bar`); tudo que não é letra/dígito vira separador; lowercase.
- **Parâmetros BM25** (linhas 90‑92): `k1 = 1.2`, `b = 0.75`, `delta = 1.0` (BM25+). IDF Lucene-style com smoothing `log(1 + (N - df + 0.5) / (df + 0.5))` (linha 287). Sem stop-words, sem stemming.
- **Score** (linhas 280‑296): soma sobre cada term da query: `qtf × idf × ((tf × (k1+1)) / (tf + norm) + delta)`. Resultado é desempatado por `tool.name` localeCompare.

### Quando o ranking roda

**Nunca automaticamente.** É a LLM que decide chamar `search_tool_bm25` — é uma tool `loadMode: "essential"` (`/home/dev/projects/oh-my-pi/packages/coding-agent/src/tools/search-tool-bm25.ts:211`). O fluxo:

1. Sessão começa com apenas tools `loadMode: "essential"` ativas. Greppadas em `src/`: **bash**, **read**, **edit**, **search_tool_bm25**. Todo o resto (`write`, `find`, `grep`-equivalente `search`, `debug`, `gh`, `browser`, `calculator`, `lsp`, `task`, hindsight*, `todo-write`, etc.) é `loadMode: "discoverable"` (28 ocorrências no grep — ver lista completa no codebase).
2. LLM lê o prompt do `search_tool_bm25` (que inclui `summarizeDiscoverableTools` com contagens por servidor MCP) e emite `search_tool_bm25({ query: "regex grep ripgrep" })`.
3. `agent-session.ts:3121 activateDiscoveredTools()` faz `setActiveToolsByName(...existing, ...newlyAdded)` e invalida o cache do índice (`#invalidateDiscoverableToolSearchIndex`, linha 3146).
4. Próxima request inclui o schema completo das tools recém-ativadas. Persiste para o resto da sessão.

Resultado: o índice BM25 é **construído sob demanda** (cache em `#discoverableToolSearchIndex`, linha 3097) e **consultado só quando a LLM pede**. Não há reranking por turno.

### Always-on vs gated

- **Essential** (sempre carregadas, no schema desde turn 1): `bash`, `read`, `edit`, `search_tool_bm25`.
- **Discoverable** (só após `search_tool_bm25` ou ativação explícita): `write`, `find`, `search`, `debug`, `gh`, `browser`, `calculator`, `eval`, `ssh`, `irc`, `inspect-image`, `render-mermaid`, `checkpoint`, `ast-grep`, `ast-edit`, `ask`, `job`, `recipe/*`, `hindsight-{retain,reflect,recall}`, `todo-write`, `lsp/*`, `task`, `web/search`, MCP tools, extensões.
- Critério para evitar poda de tools óbvias: a categorização é **estática no source** (declaração `readonly loadMode = "essential"`), não dinâmica/BM25. Tools "óbvias" são marcadas como essential pelo dev — BM25 nunca decide esconder Bash.

### Interação com prompt cache

omp **não tem mecânica de prompt-cache da Anthropic** no caminho de discovery — ele roda sobre o tool-set ativo da sessão, e ativações mutam esse set entre requests. Nenhum hook para preservar prefix; a mudança do tool-set é assumida como um "tier change" normal.

## Encaixe arquitetural em Claudin

### O que já existe

Claudin implementou um equivalente quase 1:1 da ideia — não é "BM25" mas é a mesma topologia "deferred tools + search tool":

- **Categoria por tool** (`/home/dev/projects/claudin/src/Tool.ts:466‑476`): `shouldDefer?: boolean` e `alwaysLoad?: boolean`. `searchHint?: string` em `:405` é o equivalente do `summary` ponderado do omp.
- **Critério de deferir** (`/home/dev/projects/claudin/src/tools/ToolSearchTool/prompt.ts:63‑109`, `isDeferredTool`): MCP tools são sempre deferred, mais qualquer `shouldDefer: true`; tools com `alwaysLoad: true` ou `name === TOOL_SEARCH_TOOL_NAME` nunca são deferred. Várias hard-exceptions para Brief/SendUserFile/Agent.
- **Ranking** (`/home/dev/projects/claudin/src/tools/ToolSearchTool/ToolSearchTool.ts:186‑302`, `searchToolsWithKeywords`): **NÃO é BM25** — é scoring linear ad-hoc com pesos manuais (10/12 para match exato em parte do nome, 5/6 para substring, 4 para searchHint, 2 para descrição, 3 para fallback full‑name) e suporte a `+term` required, `select:` direto e prefix MCP. Tokenização: lowercase + split por whitespace, sem normalização Unicode.
- **Gating de ativação por threshold** (`/home/dev/projects/claudin/src/utils/toolSearch.ts:711‑755`, `checkAutoThreshold`): em modo `tst-auto`, conta tokens de schemas deferred e só ativa o modo se passar de `DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10` (linha 50) do context window. Threshold ajustável via `ENABLE_TOOL_SEARCH=auto:N`.
- **Wire mechanism**: usa o content block `tool_reference` da Anthropic (`/home/dev/projects/claudin/src/tools/ToolSearchTool/ToolSearchTool.ts:444‑469`). É aqui que tudo emperra em provedores não‑Anthropic.
- **Optimistic disable em terceiros** (`/home/dev/projects/claudin/src/utils/toolSearch.ts:271‑313`): se `getAPIProvider() === 'firstParty' && !isFirstPartyAnthropicBaseUrl()` e `ENABLE_TOOL_SEARCH` não está setado, devolve `false`. Comentário inline (`:288‑294`) confirma que isso desliga defer_loading para a maioria dos usuários OpenAI-compat.

### Onde injetar a versão BM25 (provider-agnostic)

A pergunta do brief — "QueryEngine.ts ou buildSystemPromptAndContext?" — leva à resposta correta: **nenhum dos dois**. `buildSystemPromptAndContext` não existe no codebase (`grep` confirma). O ponto de injeção certo é:

1. **`src/tools.ts:assembleToolPool`** (linhas 365‑387): hoje devolve `[builtIns sorted, ...mcpSorted]` deduplicado. Esse é o `Tools` que termina virando schema na request.
   - Para BM25 provider-agnostic, **filtre antes do retorno**: dado o último user message + um session-state de "discovered tools", devolva apenas `alwaysLoad + ToolSearchTool + activeSet ∪ topK(BM25(query, deferredPool))`.
   - Vantagem: já é o único ponto consumido por `QueryEngine.ts:137` e `:1274` (achados via grep). Não toca o agent loop.
2. **Cache do índice + ativação persistente**: novo módulo `src/utils/bm25ToolIndex.ts` mantém:
   - `IndexCache` reconstruído quando o set de deferred tools muda (paridade com `maybeInvalidateCache` em `ToolSearchTool.ts:91‑99`).
   - `Set<string> sessionActivatedTools` mutado por (a) `ToolSearchTool.call` quando o provider **não** suporta `tool_reference` e (b) ativação implícita opcional pelo último user turn.
3. **Ranking**: porta o `buildDiscoverableToolSearchIndex` + `searchDiscoverableTools` de omp (`tool-index.ts:246‑297`) e substitui o `searchToolsWithKeywords` atual — ou mantenha ambos atrás do flag e A/B-teste (o linear scoring atual tem `searchHint`‑awareness que omp não tem; o BM25 tem normalização de comprimento que o linear não tem).
4. **Quando re-ranquear**:
   - Spec mínima (paridade omp): só quando a LLM chama `ToolSearchTool`. Não toca turno normal.
   - Spec ampliada (delta vs omp): rerank no início de cada **user turn** (não tool turn), usando o user message como query e adicionando top‑K ao tool-set para aquela request. Risco descrito abaixo.

### Custo atual em tokens (medido)

`bun test scripts/measure-tool-schemas.test.ts` com sonda local sobre `getAllBaseTools()` (30 tools no build atual):

| Engine    | Total schema | Tokens (rough) | Top‑10 tools |
|-----------|-------------:|---------------:|-------------:|
| anthropic |   64,438 B   |   **18,384**   |  ~10,300 tok |
| openai    |   63,378 B   |   **18,082**   |  ~10,135 tok |
| codex     |   63,283 B   |   **18,055**   |  ~10,170 tok |

Top‑5 ofensores (anthropic): Agent (1,357), Bash (1,203), EnterPlanMode (1,127), TodoWrite (1,039), Grep (1,023). Cauda longa (15 menores) somam ~3,800 tokens — esses são os melhores candidatos a gating.

**Candidatas a gated (raramente usadas, schema ≥250 tok cada):**

- `CronCreate` (938), `CronDelete` (122), `CronList` (79) — schedule tools, raras no turno típico.
- `EnterWorktree` (509), `ExitWorktree` (716) — só para fluxo de worktree.
- `WebSearch` (534), `WebFetch` (533) — só quando user pede pesquisa.
- `Skill` (479) — só quando o user invoca `/<skill>`.
- `NotebookEdit` (431) — só para `.ipynb`.
- `AskUserQuestion` (952) — raríssima em modo autônomo.
- `SendMessage` (733), `SendUserMessage` (397) — feature‑flag KAIROS.
- `ListMcpResourcesTool` (179), `ReadMcpResourceTool` (165), `TaskStop` (153) — workflow específico.

**Always-on (essential, nunca gated):** Bash, Read, Edit, Glob, Grep, TaskCreate/TaskList/TaskGet/TaskOutput/TaskUpdate (task lifecycle é cross-turn), ToolSearchTool em si, `ExitPlanMode` quando em plan mode, `TodoWrite` quando o thread já tem todos. Total floor estimado: ~7,500 tokens. Headroom de ~10,800 tokens (~59% do schema budget) é gating-target.

## Riscos concretos

1. **Esconder Bash/Read/Edit num turno em que seriam óbvias.** Mitigado se a categorização for declarativa (`shouldDefer`/`alwaysLoad`/novo `loadMode`) e BM25 só rankear o pool deferred. **Não usar BM25 sobre o pool inteiro.** Concretamente: se o user diz "abra o README", o BM25 sobre o pool todo pode rankear `FileReadTool` abaixo de `Skill` por causa de match em "open" no description do Skill — só evita-se isso se Read estiver no always-on set.
2. **Multi-step plans que precisam de tool ainda não ativada.** User pede "rode os testes e abra um PR" — turno 1 ativa Bash; turno 2 precisa de `gh` (que não foi rankeado no turno 1). Solução: a LLM emite `ToolSearchTool` num tool-call extra antes de poder abrir o PR. Custo: +1 round-trip + tokens da call. Em modelos pequenos (DeepSeek-V3, Qwen 2.5-Coder, Llama-4) a probabilidade de a LLM **esquecer** que essa tool existe é não-trivial — o prompt do ToolSearchTool tem que ser persuasivo. Já é em Claudin (`ToolSearchTool/prompt.ts:27‑52`).
3. **Conflito com prompt cache da Anthropic.** O `claude_code_system_cache_policy` coloca um cache breakpoint após o último built-in tool no schema (`tools.ts:374‑381`). Se o tool-set muda a cada turno (rerank por user message), **invalida todo o downstream cache** — perda de cache hit pode custar mais que o gating economiza (anthropic-1P paga input tokens cacheados a 10% do preço). Para Anthropic 1P, manter `tool_reference` (que preserva o prefix). Para third-party (sem cache equivalente), o BM25 ganha. Portanto o flag deve ramificar por provider.
4. **`searchHint` faltando.** Tools Claudin que não declaram `searchHint` (`grep` em `src/tools/` confirma que a maioria não declara) viram pouco descobríveis pelo BM25 do omp, que só pesa name+label+summary+schemaKeys. Mitigação: porte o `description.slice(0, 200)` fallback do omp (`tool-index.ts:183`).
5. **MCP tool churn.** MCP servers conectam async; o índice precisa ser invalidado quando o pool muda. Já existe `maybeInvalidateCache` em `ToolSearchTool.ts:91`; o cache BM25 novo precisa do mesmo hook + sentinel para `pending_mcp_servers` (já tratado no Claudin em `ToolSearchTool.ts:336‑339`).
6. **Tokenização Unicode.** Tokenizer atual do Claudin (`parseToolName` em `ToolSearchTool.ts:132‑161`) não normaliza NFKD/accents. omp normaliza. Codebases com paths/comentários em pt-BR (caso deste repo) podem ranquear pior. Baixo risco, fácil de portar.

## Proposta de feature flag + escopo MVP

### Flag

`BM25_TOOL_GATING` em `scripts/build.ts:featureFlags`. **Default `false`**. Quando true, ativa apenas para `getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()` — em Anthropic 1P o caminho existente (`tool_reference`) continua sendo o canônico para preservar prompt cache.

Sub‑configuração via `~/.claudin/settings.json`:

- `toolGating.mode`: `"off" | "search-only" | "auto-rerank"` (default `"search-only"`, paridade omp).
- `toolGating.alwaysLoad`: lista de nomes que nunca são deferred (override de classificação).
- `toolGating.topK`: int, default 8 (omp usa 8 em `DEFAULT_LIMIT`, `search-tool-bm25.ts:28`).

### Escopo MVP (em ordem, ~3 PRs)

**PR 1 — Índice BM25 portado, sem ativar.**
- Novo módulo `src/utils/bm25ToolIndex.ts` com `tokenize`, `buildDiscoverableToolSearchIndex`, `searchDiscoverableTools`, copiado do omp com adaptações para o shape `Tool` do Claudin (use `tool.searchHint` se presente, senão `tool.prompt(...).slice(0,200)`).
- Teste colocado: `src/utils/bm25ToolIndex.test.ts` com fixtures determinísticos (corpus pequeno, queries conhecidas, assertions sobre ordering).
- Sem mudança em produção. Verifica que o ranking devolve o que esperamos para 10‑15 queries representativas (`"open file"` → FileReadTool topo; `"run command"` → Bash; `"schedule cron"` → CronCreate).

**PR 2 — Wire-up `search-only` em `ToolSearchTool` para provedores não-Anthropic.**
- Quando `BM25_TOOL_GATING` flag está on **e** o provider não suporta `tool_reference`, `ToolSearchTool.call` retorna o tool-result como **texto** (não `tool_reference` blocks) descrevendo as tools ativadas, **e mutates** o tool-set da sessão (novo `sessionActivatedTools: Set<string>` em algum lugar acessível ao `assembleToolPool`).
- Modificar `assembleToolPool` (`src/tools.ts:365‑387`) para excluir deferred tools que **não** estão em `alwaysLoad ∪ sessionActivatedTools`. Continua devolvendo a forma ordenada/dedupada.
- `isToolSearchEnabledOptimistic` (`src/utils/toolSearch.ts:271‑313`) passa a devolver `true` para non‑Anthropic quando a flag está on, sem exigir `ENABLE_TOOL_SEARCH=true` (o flag é o explicit opt‑in).
- Teste: extender `src/utils/toolSearch.test.ts` (ver se existe; senão criar) com cenário non-firstParty + flag on.

**PR 3 — Opcional: `auto-rerank` por user-turn.**
- Hook em `QueryEngine.ts` (ponto onde tools são montadas para a request): se modo é `auto-rerank` E é um user turn (não tool turn), pega o user message, roda BM25 sobre `deferredPool`, junta top‑K com `alwaysLoad ∪ sessionActivatedTools` para essa request.
- Não modifica state persistente — diferença vs PR2 é que o set é recalculado por turno em vez de só crescer.
- Risco maior — pula prompt cache. Gated em `toolGating.mode === "auto-rerank"`, default off.

### Fora do MVP

- Embeddings/dense retrieval (omp não usa, e o eval‑cost dos tokens economizados não compensa o custo de manter modelo local).
- Reranking por co-occurrence histórica (omp não usa).
- Per-server gating de MCP (omp tem; útil mais à frente, não bloqueia o MVP).

## Métrica de sucesso

1. **Token reduction (primária)**: em sessão sintética de 20 turnos misturando file IO, bash, search e 1 chamada explícita a uma tool gated (worktree/cron/web), `dist/cli.mjs` em modo OpenAI-compat deve enviar **≥25% menos schemaBytes** somados across requests vs baseline (hoje ~18 k tokens × N turnos). Medir via patch local em `convertTools`/`toolToAPISchema` que loga `schemaBytes` no debug log.
2. **No-regress em tool-calling correctness**: rodar `bun run test:provider` + um eval manual de 10 prompts canônicos ("liste arquivos", "leia X e edite Y", "abra worktree", "rode git status", "cron diário") em DeepSeek-V3 e Groq Llama-4. Aceitação: ≤1 caso onde a LLM falha em achar a tool certa em 2 turnos.
3. **Latência neutra**: `bun run smoke` + warm-start unchanged (índice BM25 é construído lazy quando primeiro `ToolSearchTool` é necessário; corpus de 30 tools é trivial — <5ms). Adicionar bench mínimo em `src/utils/bm25ToolIndex.test.ts` com `expect(buildTime).toBeLessThan(20)`.
4. **Cache preservation (Anthropic 1P)**: como o flag não muda nada para Anthropic 1P, o `tengu_prompt_cache_hit_rate` em telemetry deve estar dentro de ±1% do baseline. Guard: adicionar test em `src/__tests__/` que afirma `BM25_TOOL_GATING` é no‑op quando `isFirstPartyAnthropicBaseUrl()` é true.

## Referências de arquivos

### omp
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/tool-discovery/tool-index.ts:90-100` (constants), `:115-134` (tokenize), `:143-155` (corpus), `:246-297` (index + search).
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/tools/search-tool-bm25.ts:208-297` (tool wrapper, ativação).
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/session/agent-session.ts:3048-3151` (discovery mode resolution, getDiscoverableTools, activateDiscoveredTools).
- `loadMode` declarações: `:essential` em `tools/bash.ts:228`, `tools/read.ts:679`, `edit/index.ts:278`, `tools/search-tool-bm25.ts:211`. Resto é `discoverable`.

### claudin
- `/home/dev/projects/claudin/src/Tool.ts:405` (`searchHint`), `:466-476` (`shouldDefer`, `alwaysLoad`).
- `/home/dev/projects/claudin/src/tools.ts:365-387` (`assembleToolPool` — ponto de injeção primário).
- `/home/dev/projects/claudin/src/tools/ToolSearchTool/ToolSearchTool.ts:132-302` (tokenizer + scoring linear atual), `:304-471` (tool wrapper, `tool_reference` output).
- `/home/dev/projects/claudin/src/tools/ToolSearchTool/prompt.ts:55-109` (`isDeferredTool`).
- `/home/dev/projects/claudin/src/utils/toolSearch.ts:240-253` (`modelSupportsToolReference`), `:271-313` (optimistic disable para third-party), `:387-449` (`isToolSearchEnabled`), `:711-755` (`checkAutoThreshold`).
- `/home/dev/projects/claudin/scripts/measure-tool-schemas.ts` + `.test.ts` (baseline mensurável).
