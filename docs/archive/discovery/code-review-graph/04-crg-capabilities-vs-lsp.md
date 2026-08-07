# CRG — Capacidades únicas vs. LSP padrão

Comparação factual entre as capacidades expostas pelo `code-review-graph`
(CRG) e o que um LSP "decente" (TypeScript, Python, Go, Rust com
analyzer/rust-analyzer/gopls etc.) já entrega por padrão.

Premissa importante: o Claudin já consome LSP via a tool `LSP` (operations
`goToDefinition`, `findReferences`, `hover`, `documentSymbol`,
`workspaceSymbol`, `goToImplementation`, `prepareCallHierarchy`,
`incomingCalls`, `outgoingCalls`, `rename`, `codeActions`,
`applyCodeAction`, `renameFile`). Tudo que CRG ofereceria que LSP já cobre
é redundante; o que interessa é o delta.

Tudo abaixo está mapeado direto ao código em
`/home/dev/projects/code-review-graph/`. Os arquivos centrais são:

- `code_review_graph/main.py` — 1079 linhas, registra 28 tools MCP +
  5 prompts. Cada tool é um wrapper fino que delega para `tools/*.py` ou
  módulos do pacote.
- `code_review_graph/tools/*.py` — implementações finas (~150-700 linhas
  cada) que carregam o store SQLite, chamam o algoritmo no módulo de
  domínio e empacotam o resultado.
- Módulos de domínio: `graph.py`, `communities.py` (874 linhas),
  `flows.py` (698 linhas), `analysis.py` (410 linhas), `changes.py`
  (398 linhas), `embeddings.py` (990 linhas), `wiki.py` (305 linhas),
  `refactor.py` (852 linhas), `search.py` (447 linhas).

---

## 1. O que LSP já faz bem (linha de base que NÃO é diferencial do CRG)

| Capacidade LSP | CRG tem equivalente? | Onde no CRG | Algo a mais? |
|----------------|----------------------|-------------|--------------|
| `goToDefinition` | Sim (parcial) | `query_graph_tool(pattern="children_of"\|"file_summary")` em `main.py:215` | **Não.** LSP resolve em ms num arquivo aberto; CRG precisa do grafo construído e dá só nome+linha. LSP é estritamente melhor para single-symbol nav. |
| `findReferences` | Sim | `query_graph_tool(pattern="callers_of")` em `main.py:215` (delega para `tools/query.py:query_graph`) | **Marginal.** Mesma informação; CRG cobre call edges resolvidos no build, então não pega referências dinâmicas que LSP às vezes pega. |
| `hover` (type info, docstring) | **Não** | n/a | CRG armazena `name`, `kind`, `qualified_name`, `file_path`, `line_start/end`, mas não tipos resolvidos. LSP ganha. |
| `documentSymbol` | Sim | `query_graph_tool(pattern="file_summary")` | **Não.** LSP é instantâneo no arquivo atual. |
| `workspaceSymbol` | Sim (com vantagem leve) | `semantic_search_nodes_tool` (`main.py:278`), `query_graph_tool` | CRG pode fazer fuzzy/semantic; LSP normalmente é prefix/fuzzy simples. Diferencial real só com embeddings (custo opt-in — ver §4). |
| `rename` | Sim | `refactor_tool(mode="rename")` (`main.py:626`) + `apply_refactor_tool` (`main.py:662`) | **Não substitui LSP.** CRG renomeia por substring exata baseada em qualified_name do grafo; LSP rename é AST-safe (capturas, shadowing, imports). LSP é estritamente mais seguro em linguagens com analyzer maduro. CRG ajuda em linguagens *sem* server (ex: Bash, configs, partes de monorepo poliglota). |
| `codeActions` (quickfixes, refactor) | **Não** | n/a | LSP entrega quickfixes do servidor; CRG não tem isso. |
| `goToImplementation` | Sim (parcial) | `query_graph_tool(pattern="inheritors_of")` | **Não.** LSP cobre interface→impl direto; CRG depende do extractor ter capturado `INHERITS`/`IMPLEMENTS`. |
| `prepareCallHierarchy` / `incomingCalls` / `outgoingCalls` | Sim | `query_graph_tool(pattern="callers_of"\|"callees_of")` e `traverse_graph_tool` (`main.py:832`) | **Sim, multi-hop.** LSP call hierarchy é interativa hop-a-hop; CRG faz BFS transitivo com budget de tokens (ver §2). |
| Diagnostics (compile errors, lint) | **Não** | n/a | LSP é a fonte canônica; CRG não tem. |
| `documentHighlight`, `signatureHelp`, `inlayHints` | **Não** | n/a | Nada equivalente. |

**Conclusão §1:** das ~10 capacidades clássicas de LSP, CRG empata em
~5 (workspaceSymbol, callers/callees, file_summary, rename inferior,
implementation parcial) e fica claramente atrás nas outras (hover,
codeActions, diagnostics, signatureHelp, inlayHints). Para tudo que é
"per-arquivo / per-símbolo / instantâneo", LSP é estritamente melhor.

---

## 2. Capacidades do CRG que LSP NÃO oferece

Aqui está o delta real. Toda capacidade abaixo depende de pelo menos um
de três ingredientes que LSP, por design, não tem:

- **Visão global do grafo** (matriz de adjacência inteira em memória ou
  SQLite + igraph/networkx).
- **Awareness de `git diff`** (mapeia mudança de linhas → símbolos
  afetados → cone transitivo).
- **Pós-processamento agregado** (Leiden communities, betweenness,
  centralidade, scoring de risco).

### 2.1 `get_minimal_context_tool` — roteador de ~100 tokens

- Registrado em `code_review_graph/main.py:165`; implementação em
  `code_review_graph/tools/context.py:37` (`get_minimal_context`).
- **Retorna**: stats agregados do grafo (nº de nós/edges/linguagens),
  `risk_score` derivado do diff atual, top communities/flows
  envolvidas e sugestões de próxima tool — tudo em um payload curto.
- **LSP não consegue** porque não tem noção de "qual o estado global
  desse repo agora" nem score derivado do diff; LSP é stateless per
  request.
- **Caso de uso**: agente recém-acordado decide se vale gastar contexto
  com mais um tool call ou se o repo está limpo.

### 2.2 `detect_changes_tool` — diff-aware com risk_score

- `main.py:574`; implementação em `tools/review.py:356`
  (`detect_changes_func`), que usa `changes.py:analyze_changes` e
  `parse_diff_ranges` (mapeia hunks do diff → ranges de linha
  → símbolos do grafo).
- **Retorna**: `changed_functions`, `affected_flows`, `test_gaps`,
  `review_priorities` ordenadas, `risk_score` numérico, opcionalmente
  source snippets das funções alteradas, e `_hints` para o próximo
  passo. `detail_level="minimal"` corta ainda mais para reviews
  rápidos.
- **LSP não consegue**: LSP nem lê git. Não tem `git diff`, não tem
  noção de "esta função mudou e tem cobertura zero de teste".
- **Caso de uso**: gating de PR ("o que mudou agora pode quebrar quê?").

### 2.3 `get_impact_radius_tool` — BFS transitivo com cap

- `main.py:189`; implementação em `tools/query.py:35` (`get_impact_radius`),
  que chama `graph.py:606` (`GraphStore.get_impact_radius`) e
  `graph.py:634` (`get_impact_radius_sql`).
- **Retorna**: lista de nós impactados por mudança em arquivos X, até
  `max_depth` hops, agrupado por kind (Function/Class/Test), e
  classificado por proximidade.
- **LSP não consegue** porque `callHierarchy` é hop-a-hop e per-símbolo;
  fazer impact radius via LSP exige N calls em loop + dedupe + budget
  — exatamente o trabalho que CRG já fez em tempo de build.
- **Caso de uso**: "vou mexer em `auth.py`, quem mais quebra?".

### 2.4 `get_affected_flows_tool` — flows = call chains de entry points

- `main.py:474`; impl em `tools/review.py:291` que chama
  `flows.py:658` (`get_affected_flows`).
- **Flow** = chain de chamadas começando num *entry point* detectado
  (handlers HTTP, comandos CLI, jobs, testes — ver
  `flows.py:27-60`, lista grande de decoradores Spring, FastAPI,
  Click, Celery, Django, Express, React, Android, Kotlin etc.).
- **Retorna**: flows que passam por alguma função alterada, ordenados
  por *criticality* (score persistido na tabela `flows`).
- **LSP não consegue**: detecção de entry-point é uma abstração de
  domínio (framework-aware), não está no LSP. E flow tracing é BFS
  global, não per-arquivo.
- **Caso de uso**: "este patch toca o endpoint `/checkout`?".

### 2.5 `list_communities_tool` / `get_community_tool` — Leiden clustering

- `main.py:496` e `main.py:523`; comunidades calculadas em
  `communities.py` (874 linhas) — usa `igraph` quando disponível
  (Leiden algorithm com seed fixa `_LEIDEN_SEED = 42` em
  `communities.py:21`), com fallback file-based quando não.
- **Retorna**: clusters de nós relacionados, com nome auto-gerado
  (heurística file-prefix + dominant class + keyword em
  `communities.py:68`), tamanho, coesão, linguagem dominante.
- **LSP não consegue**: comunidade é uma propriedade emergente do
  grafo inteiro. Não há equivalente.
- **Caso de uso**: "quais são os grandes blocos lógicos deste repo?".

### 2.6 `get_architecture_overview_tool` — cross-community edges

- `main.py:550`; usa community structure + edges entre comunidades.
- **Retorna**: alto-nível do repo, com `detail_level="minimal"`
  agregando uma linha por par-de-comunidades (~600KB → <5KB segundo
  o docstring em `main.py:564`).
- **LSP não consegue**: precisa do clustering + grafo global.

### 2.7 `get_hub_nodes_tool` / `get_bridge_nodes_tool` — centralidade

- `main.py:737` e `main.py:756`; impl em
  `analysis.py:find_hub_nodes` (degree-based) e
  `analysis.py:find_bridge_nodes` (betweenness centrality via
  `networkx`; amostra com `k=500` quando o grafo tem >5000 nós —
  `analysis.py:77-80`).
- **Retorna**:
  - hubs = nós com maior `in_degree + out_degree` (ranking dos
    arquitetural hotspots).
  - bridges = nós com maior betweenness, ou seja, "se quebrar,
    desconecta regiões".
- **LSP não consegue**: centralidade exige o grafo inteiro
  carregado, não é per-arquivo.
- **Caso de uso**: "que componentes preciso obrigatoriamente cobrir
  com teste?".

### 2.8 `get_knowledge_gaps_tool` — fragilidades estruturais

- `main.py:776`; impl em `analysis.py:find_knowledge_gaps` (via
  `tools/analysis_tools.py:71`).
- **Retorna**: `isolated_nodes` (desconectados), `thin_communities`
  (<3 membros), `untested_hotspots` (alta degree sem
  `TESTED_BY` edge), `single_file_communities`.
- **LSP não consegue**: cruza coverage (test edges) com topologia.

### 2.9 `get_surprising_connections_tool` — anomalias estruturais

- `main.py:794`; impl em `analysis.py:find_surprising_connections`.
- **Retorna**: edges com surprise score alto, somando fatores:
  cross-community (+0.3), cross-language (+0.2),
  peripheral-to-hub (+0.2), cross-test-boundary (+0.15), unusual
  edge kinds (+0.15) — números literais do docstring em
  `main.py:801-803`.
- **LSP não consegue**: requer scoring sobre o grafo + community
  labels + degree.

### 2.10 `find_large_functions_tool` — audit de tamanho

- `main.py:394`; impl em `tools/query.py:520`.
- **Retorna**: funções/classes/arquivos acima de `min_lines`.
- **LSP não consegue diretamente** (não tem `wc -l` por símbolo),
  embora `documentSymbol` + cálculo de `line_end - line_start` daria
  o mesmo resultado per-arquivo. Diferencial: CRG faz isso global
  com um filtro `kind`/`file_path_pattern` num único SQL.

### 2.11 `semantic_search_nodes_tool` — FTS5 + embeddings

- `main.py:278`; impl em `tools/query.py:376`. Embeddings em
  `embeddings.py` (990 linhas — suporta local/sentence-transformers,
  OpenAI-compat, Google Gemini, Minimax).
- **Retorna**: top-N nós por similaridade. Cai para FTS5 quando não
  há embeddings.
- **LSP não consegue**: workspaceSymbol é prefix/fuzzy textual, não
  semântico ("auth code" → encontra `validate_jwt`).
- **Caso de uso**: agente novo no repo procura "rate limiting" sem
  saber o nome exato.

### 2.12 `cross_repo_search_tool` — multi-repo

- `main.py:872`; impl em `tools/registry_tools.py:49`. Registry em
  `~/.code-review-graph/registry.json`.
- **Retorna**: busca por nome cruzando vários repos registrados,
  resultados mesclados por score.
- **LSP não consegue**: LSP é por workspace; cruzar repos requer
  uma camada acima.

### 2.13 `get_suggested_questions_tool` — prompts derivados do grafo

- `main.py:814`; impl em `analysis.py:generate_suggested_questions`
  via `tools/analysis_tools.py:137`.
- **Retorna**: perguntas auto-geradas, priorizadas (high/medium/low),
  baseadas em bridge nodes sem teste, hubs sem teste, surpresas
  cross-community, comunidades thin, hotspots sem teste.
- **LSP não consegue**: é um produto derivado de várias análises do
  grafo + heurísticas.

### 2.14 `generate_wiki_tool` / `get_wiki_page_tool` — docs auto-geradas

- `main.py:692` e `main.py:718`; impl em `wiki.py` (305 linhas).
- **Retorna**: páginas markdown por comunidade + index, escritas em
  `.code-review-graph/wiki/`. Skip se conteúdo não mudou.
- **LSP não consegue**: produto agregado, fora do escopo do LSP.

### 2.15 `refactor_tool` (modo `dead_code`, `rename`, `suggest`)

- `main.py:626` + `apply_refactor_tool` (`main.py:662`); impl em
  `refactor.py` (852 linhas).
- **Modo `dead_code`**: funções/classes sem `callers`, sem `tests`,
  sem `importers`, e não-entry-points. **LSP não consegue** porque
  falta a noção de entry-point (framework-aware) — referenceCount=0
  no LSP é o mesmo que dead, mas inclui handlers HTTP por engano.
- **Modo `rename`**: preview de rename via substituição exata por
  qualified_name; expira após 10 min. **LSP cobre melhor** quando há
  server (ver §1) — útil só sem server.
- **Modo `suggest`**: refactorings sugeridos a partir das
  comunidades (mover funções "misplaced", remover dead code). **LSP
  não consegue.**

### 2.16 `traverse_graph_tool` — BFS/DFS arbitrário com budget

- `main.py:832`; impl em `tools/query.py:596`.
- **Retorna**: a partir do nó best-match, BFS ou DFS até `depth`
  hops respeitando `token_budget`.
- **LSP não consegue**: callHierarchy não tem budget e é só um
  tipo de edge (CALLS); traverse_graph passeia por
  CALLS+IMPORTS+CONTAINS+INHERITS etc.

### 2.17 Prompts MCP (`review_changes`, `pre_merge_check`, `onboard_developer`, `debug_issue`, `architecture_map`)

- Registrados em `main.py:891`, `main.py:903`, `main.py:912`,
  `main.py:924`, `main.py:933`; templates em
  `code_review_graph/prompts.py`.
- **O que são**: prompt templates MCP (mensagens prontas que
  orquestram várias das tools acima em ordem).
- **LSP não consegue**: prompt orchestration não é parte do LSP.
- **Caso de uso**: um workflow `/review-pr` que já vem com
  scaffolding pronto.

---

## 3. Capacidades cruzadas (LSP + diff + grafo)

Onde o diferencial **não é uma peça isolada**, mas a combinação. Estes
são os casos em que substituir CRG por "só LSP" perde valor:

### 3.1 Impact radius transitivo de um diff

- Precisa de: (a) resolução de chamadas tipo LSP, (b) `git diff`
  parseado para ranges de linha, (c) BFS no grafo com budget.
- LSP sozinho dá (a). CRG sozinho num repo sem entry-point detection
  dá (b)+(c) mas com qualidade pior que LSP em call resolution.
- A combinação certa seria usar LSP `callHierarchy` para fazer o BFS
  on-demand — funciona, mas é caro em latência (N requests) e não
  cobre flows/entry points.

### 3.2 Risk-scored review

- Precisa de: (a) `git diff`, (b) impact radius, (c) cobertura de
  teste (edge `TESTED_BY` no grafo), (d) flows/criticality.
- Nenhum LSP entrega (c) ou (d). Esse é um caso em que CRG agrega
  valor real **se o repo for grande o suficiente para que o agente
  não consiga manter (d) na cabeça**.

### 3.3 Rename multi-arquivo em linguagens sem LSP maduro

- Em Bash, YAML/Helm, Terraform, configs, partes de monorepos
  poliglotas, LSP não vai cobrir. CRG `rename` por qualified_name +
  apply_refactor com diff dry-run pode salvar o dia.
- Em TS/Python/Rust/Go, LSP é estritamente melhor.

### 3.4 Workspace symbol semântico

- LSP `workspaceSymbol` é textual; `semantic_search_nodes` com
  embeddings é semântico. Útil quando o agente busca por
  "rate limit" e o código chama `bucket_take`.

---

## 4. Sinal de custo (indexação inicial)

| Capacidade (§2) | Custo |
|---|---|
| `get_minimal_context` | 🟢 (consulta agregada SQL barata sobre o grafo já existente) |
| `detect_changes` | 🟢 (precisa de `git diff` e BFS — mas é por invocação, não build) |
| `get_impact_radius` | 🟢 (BFS sobre SQLite/networkx; rodado on-demand) |
| `get_affected_flows` | 🟡 (flows são pré-computados em postprocess; precisa rodar `run_postprocess_tool` após build — `main.py:135`) |
| `list_communities` / `get_community` / `get_architecture_overview` | 🟡 (Leiden roda no postprocess; `communities.py` 874 linhas, igraph opcional) |
| `get_hub_nodes` | 🟢 (degree count direto das edges) |
| `get_bridge_nodes` | 🟡 (betweenness via networkx; amostra com `k=500` quando >5000 nós — `analysis.py:77`) |
| `get_knowledge_gaps` | 🟡 (depende de communities) |
| `get_surprising_connections` | 🟡 (precisa de communities + degree para scoring) |
| `get_suggested_questions` | 🟡 (composto de várias análises acima) |
| `find_large_functions` | 🟢 (um SELECT no grafo) |
| `semantic_search_nodes` (FTS5) | 🟢 (FTS5 vem grátis no build) |
| `semantic_search_nodes` (embeddings) | 🔴 (`embed_graph_tool`, 990 linhas em `embeddings.py`, sentence-transformers local ou API paga; tempo proporcional ao nº de nós) |
| `cross_repo_search` | 🟢 (consulta cada repo registrado; mesmo custo de busca per-repo) |
| `traverse_graph` | 🟢 (BFS on-demand) |
| `generate_wiki` | 🔴 (gera markdown por comunidade — quando configurado para usar LLM, custo de tokens é proporcional ao tamanho do repo; sem LLM, é só template) |
| `refactor_tool` (dead_code, suggest) | 🟢 (consulta sobre edges já existentes) |
| `refactor_tool` (rename) + `apply_refactor` | 🟢 (preview por substring) |
| Prompts MCP (`review_changes` etc.) | 🟢 (templates de mensagem) |

**Resumo de custo**: 🟢 a maioria (já vem grátis no parse). 🟡 quatro
capacidades dependem do postprocess (communities + flows) — único
"trabalho extra" recorrente. 🔴 apenas embeddings e wiki LLM são
realmente caros.

---

## 5. Veredito por categoria

Codebase pequeno = ~50k LOC (Claudin: ~200k LOC TS, mas é uma única
"comunidade" do ponto de vista de arquitetura — REPL+tools+providers).
Monorepo grande = milhões de LOC, dezenas de serviços/equipes.

| Capacidade | LSP cobre? | CRG agrega? | Ganho real em codebase pequeno (Claudin, <200k LOC, 1 comunidade) | Ganho em monorepo grande |
|---|---|---|---|---|
| goToDefinition / hover / signatureHelp / diagnostics / inlayHints | Sim | Não | Zero (LSP estritamente melhor) | Zero |
| findReferences / callHierarchy hop-a-hop | Sim | Sim, mas pior | Zero a negativo | Zero a negativo (mais lento) |
| workspaceSymbol textual | Sim | Sim (equivalente) | Zero | Zero |
| workspaceSymbol semântico (embeddings) | Não | Sim | Médio (agente pode achar coisa por intenção) | Alto |
| Rename AST-safe (TS/Python/Go) | Sim | Sim mas pior | Negativo (CRG inseguro) | Negativo |
| Rename em linguagens sem LSP (Bash, configs) | Não | Sim | Baixo (Claudin quase não tem isso) | Médio |
| `get_minimal_context` (router 100tk) | Não | Sim | Médio (economiza tokens já no 1º turn) | Médio |
| `detect_changes` (risk score) | Não | Sim | Baixo/Médio (Claudin tem testes e o agente já lê o diff) | Alto |
| `get_impact_radius` transitivo | Parcial (via callHierarchy em loop) | Sim, mais eficiente | Baixo (1 comunidade, 200k LOC dá pra grep) | Alto |
| `get_affected_flows` (entry-point aware) | Não | Sim | Baixo (Claudin tem ~2 entry points reais: `cli.tsx` e `grpc/server.ts`) | Alto |
| Communities / architecture overview / hubs / bridges / surprising / knowledge gaps | Não | Sim | Baixo (1 comunidade, hubs já conhecidos: QueryEngine.ts, openaiShim.ts) | Alto |
| `find_large_functions` | Não diretamente | Sim | Baixo (`Grep -c` resolve) | Médio |
| `generate_wiki` / `get_wiki_page` | Não | Sim | Baixo (docs/ humano já existe e é melhor) | Médio (onboarding) |
| `refactor dead_code` (entry-point aware) | Não | Sim | Médio (LSP referenceCount marca handlers como vivos; CRG diferencia) | Alto |
| `cross_repo_search` | Não | Sim | Zero (single repo) | Alto |
| `get_suggested_questions` / prompts MCP | Não | Sim | Baixo (agente já tem REPL e o usuário sabe perguntar) | Médio |

### Veredito final

- **Para um repo do tamanho/forma do Claudin**: CRG é
  **mostly redundante**. O único delta com valor claro é
  `semantic_search_nodes` (com embeddings) + `detect_changes`
  (risk-scored review). Tudo mais é coberto por LSP + Grep + leitura
  direta pelo agente. O custo de manter o grafo (build + postprocess
  + invalidação após cada commit) é maior que o ganho.

- **Para um monorepo grande**: CRG ganha em **6 frentes**:
  impact radius transitivo, affected flows, communities/architecture,
  bridges/hubs, dead code framework-aware, cross-repo search. Esses
  são todos casos em que o agente sozinho com LSP + Grep gastaria
  ordens de magnitude mais tokens para extrair a mesma informação.

- **Conclusão arquitetural**: as capacidades 🟢/🟡 que dependem só
  de parse + postprocess local valem muito do ponto de vista de
  "barato em produzir, caro em reproduzir manualmente". As 🔴
  (embeddings, wiki LLM) são opt-in e cujo valor depende fortemente
  do tamanho do repo e do volume de queries semânticas.
