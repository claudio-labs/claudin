# code-review-graph — arquitetura interna e mecanismo de economia de tokens

Investigação do repositório em `/home/dev/projects/code-review-graph` (v2.3.5, `pyproject.toml:7`). Foco: como funciona internamente e por que (ou se) economiza tokens. Todas as referências usam `arquivo:linha`.

---

## 0. Diagrama mental (ASCII)

```
                   ┌──────────────────────────────────────────────┐
                   │           Cliente AI (Claudin, Codex, …)     │
                   └──────────────┬───────────────────────────────┘
                                  │ JSON via stdio (MCP)
                                  ▼
                   ┌──────────────────────────────────────────────┐
                   │ FastMCP server (main.py:85)                  │
                   │   29 @mcp.tool() handlers, todos delegam     │
                   │   a funções "_func" em code_review_graph/    │
                   │   tools/*.py                                 │
                   └──────────────┬───────────────────────────────┘
                                  │
              ┌───────────────────┼────────────────────────┐
              ▼                   ▼                        ▼
  ┌────────────────────┐ ┌──────────────────┐ ┌────────────────────┐
  │  Parser            │ │  GraphStore      │ │  Incremental       │
  │  (parser.py)       │ │  (graph.py:143)  │ │  (incremental.py)  │
  │  Tree-sitter +     │ │  SQLite WAL +    │ │  git diff → set    │
  │  regex p/ alguns   │ │  recursive CTE   │ │  de arquivos +     │
  │  langs             │ │  BFS             │ │  dependentes       │
  └─────────┬──────────┘ └────────┬─────────┘ └──────┬─────────────┘
            │                     │                  │
            ▼                     ▼                  ▼
   tree_sitter_language_pack   .code-review-graph/   subprocess(git)
   (>30 grammars)              graph.db (SQLite)

  Pós-processamento (postprocessing.py, communities.py, flows.py,
  search.py): Leiden communities, flow tracing, FTS5, embeddings.
```

---

## 1. Modelo de dados — o que é o "graph"?

**Nós** (tabela `nodes`, `graph.py:33–50`, dataclass `GraphNode` em `graph.py:83`):

| `kind` | Significado |
|---|---|
| `File` | Arquivo-fonte (path absoluto como `qualified_name`) |
| `Class` | Classe, struct, interface, enum, módulo, contract |
| `Function` | Função, método, construtor (e também event/modifier em Solidity, `parser.py:262`) |
| `Type` | Type alias / interface declarativa |
| `Test` | Função que casa heurística de teste (`is_test=1`) |

Identidade canônica via **qualified_name**: `path::Class.method` (`docs/schema.md:138`).

**Arestas** (tabela `edges`, `graph.py:52`, dataclass `GraphEdge` em `graph.py:101`): `CALLS`, `IMPORTS_FROM`, `INHERITS`, `IMPLEMENTS`, `CONTAINS`, `TESTED_BY`, `DEPENDS_ON`, `REFERENCES`, `INJECTS`, `CONSUMES`, `PRODUCES`, `TEMPORAL_STUB`. Cada aresta carrega `confidence` e `confidence_tier` (`graph.py:60–62`) — `EXTRACTED` para o que veio direto do AST, tiers superiores quando um resolver enriquece (Jedi, Spring, ReScript, tsconfig, temporal).

**Construção**: Tree-sitter via `tree-sitter-language-pack` (`pyproject.toml:33–34`). `CodeParser` em `parser.py` (~284KB, o maior arquivo do projeto) faz walk recursivo do AST e pattern-matcha node types definidos em quatro dicionários por linguagem: `_CLASS_TYPES` (`parser.py:184`), `_FUNCTION_TYPES` (`parser.py:240`), `_IMPORT_TYPES` (`parser.py:301`) e `_CALL_TYPES`. Algumas linguagens são **regex-based**, não tree-sitter, porque o language pack não traz grammar:

- ReScript (`.res`, `.resi`): comentário explícito em `parser.py:131–134` "No tree-sitter grammar is bundled … extraction is regex-based (see _parse_rescript)".
- Elixir, Nix, SQL, R, Julia (parcial): handlers dedicados `_extract_*_constructs` (ver `parser.py:281–298`).

Resolvers extras de pós-extração (rodam ao final do build incremental conforme as extensões mudaram):

- `jedi_resolver.py` — desambiguação de calls em Python.
- `rescript_resolver.py`, `spring_resolver.py`, `tsconfig_resolver.py`, `temporal_resolver.py` — enriquecem arestas com `confidence_tier` mais alto.

---

## 2. Persistência

**Formato**: SQLite (stdlib, WAL ligado em `graph.py:154`) em `.code-review-graph/graph.db` dentro do repo (`docs/architecture.md:44`, `incremental.py:301`). `.code-review-graphignore` controla skip de arquivos (`incremental.py:354`).

**Tabelas principais** (`docs/schema.md:152`): `nodes`, `edges`, `metadata`, `flows`, `flow_memberships`, `communities`, `community_summaries`, `flow_snapshots`, `risk_index`, `nodes_fts` (FTS5), `embeddings` (DB separado). Migrações versionadas em `migrations.py`.

**Reconstrução**: **incremental por padrão**. `incremental_update()` em `incremental.py:919`:

1. `get_changed_files()` via `git diff --name-only $base` (default `HEAD~1`, `incremental.py:493`).
2. Para cada changed file, `find_dependents()` (`incremental.py:757`) descobre arquivos que importam o alvo (single-hop por padrão, `incremental.py:720`).
3. Para cada candidato, compara `sha256(content)` com `nodes[0].file_hash` armazenado (`incremental.py:976–980`); **pula se hash bate**.
4. Re-parse paralelo via `ProcessPoolExecutor`/`ThreadPoolExecutor` (escolha em `incremental.py:28`).
5. `store_file_nodes_edges()` faz delete+insert dos nodes/edges daquele arquivo dentro de uma transação explícita.

**Watch mode**: `watchdog`-based, `incremental.py:1067` + `GraphUpdateHandler:1092`, com debounce 0.3s (`_DEBOUNCE_SECONDS:1064`).

**Daemon** (`daemon.py`, 963 linhas): roda múltiplos watchers para vários repos via TOML config (`DaemonConfig:63`), com `ConfigWatcher`, healthcheck loop, daemonize POSIX (`daemon.py:759`). Persiste PID/state. CLI dedicado: `crg-daemon` (`pyproject.toml:49`).

**Invalidação do índice**: hash SHA-256 do conteúdo do arquivo (`incremental.py:977`). Não há check de versão de schema runtime para invalidar — migrações resolvem.

---

## 3. Interface MCP

Entry point é `code-review-graph serve` (`pyproject.toml:48` → `cli.py:main`). Usa **FastMCP** (`main.py:18,85`). `.mcp.json` declara `uvx code-review-graph serve` como server.

**29 tools** registradas com `@mcp.tool()` em `main.py`. Listagem com signature, input principal e shape do output (todos retornam `dict`):

| # | Tool (linha) | Input central | Output (forma) |
|---|---|---|---|
| 1 | `build_or_update_graph_tool` (`main.py:96`) | `full_rebuild`, `base` | `{files_updated, total_nodes, total_edges, changed_files, dependent_files, errors, *_resolution}` |
| 2 | `run_postprocess_tool` (`main.py:136`) | `flows`, `communities`, `fts` | stats agregadas |
| 3 | `get_minimal_context_tool` (`main.py:165`) | `task`, `changed_files` | `~100 tokens`: stats, risk, top-3 communities, top-3 flows, `next_tool_suggestions` |
| 4 | `get_impact_radius_tool` (`main.py:190`) | `changed_files`, `max_depth=2` | `{changed_nodes, impacted_nodes, impacted_files, edges, truncated}` |
| 5 | `query_graph_tool` (`main.py:216`) | `pattern`, `target` | nodes/edges filtrados — patterns: `callers_of`, `callees_of`, `imports_of`, `importers_of`, `children_of`, `tests_for`, `inheritors_of`, `file_summary` (`main.py:225–232`) |
| 6 | `get_review_context_tool` (`main.py:247`) | `changed_files`, `include_source=True`, `max_lines_per_file=200` | subgraph + `source_snippets` + `review_guidance` |
| 7 | `semantic_search_nodes_tool` (`main.py:279`) | `query`, `kind`, `limit=20` | nodes ranqueados (vector ou FTS5 fallback) |
| 8 | `embed_graph_tool` (`main.py:315`) | `model`, `provider` | stats de embedding |
| 9 | `list_graph_stats_tool` (`main.py:357`) | — | `GraphStats` (`graph.py:128`) |
| 10 | `get_docs_section_tool` (`main.py:372`) | `section_name` | trecho do `LLM-OPTIMIZED-REFERENCE.md` empacotado no wheel (`pyproject.toml:90–91`) |
| 11 | `find_large_functions_tool` (`main.py:395`) | `min_lines=50` | lista ordenada por LOC |
| 12 | `list_flows_tool` (`main.py:421`) | `sort_by=criticality`, `detail_level` | flows |
| 13 | `get_flow_tool` (`main.py:449`) | `flow_id`/`flow_name` | call chain |
| 14 | `get_affected_flows_tool` (`main.py:475`) | `changed_files` | flows tocados |
| 15 | `list_communities_tool` (`main.py:497`) | `sort_by=size` | communities |
| 16 | `get_community_tool` (`main.py:524`) | `community_id`/`name` | metadata + members |
| 17 | `get_architecture_overview_tool` (`main.py:551`) | `detail_level="minimal"` | "minimal" agrega cross-community edges em uma linha por par (claim no doc: 600KB → <5KB, `main.py:564–565`) |
| 18 | `detect_changes_tool` (`main.py:575`) | `base`, `max_depth=2`, `detail_level` | review guidance com `risk_score` (`changes.py:219`) |
| 19 | `refactor_tool` (`main.py:627`) | `mode` em {`rename`, `dead_code`, `suggest`} | edit list + `refactor_id` |
| 20 | `apply_refactor_tool` (`main.py:663`) | `refactor_id`, `dry_run` | aplica replacements |
| 21 | `generate_wiki_tool` (`main.py:693`) | `force` | gera `.code-review-graph/wiki/*.md` |
| 22 | `get_wiki_page_tool` (`main.py:719`) | `community_name` | markdown |
| 23 | `get_hub_nodes_tool` (`main.py:738`) | `top_n=10` | hubs por grau total |
| 24 | `get_bridge_nodes_tool` (`main.py:757`) | `top_n=10` | betweenness (sampling se >5000 nodes) |
| 25 | `get_knowledge_gaps_tool` (`main.py:777`) | — | isolated, thin communities, untested hotspots |
| 26 | `get_surprising_connections_tool` (`main.py:795`) | `top_n=15` | edges anômalos com score composto |
| 27 | `get_suggested_questions_tool` (`main.py:815`) | — | perguntas de review autogeradas |
| 28 | `traverse_graph_tool` (`main.py:833`) | BFS/DFS | nodes alcançados |
| 29 | `list_repos_tool`/`cross_repo_search_tool` (`main.py:863`, `873`) | — | multi-repo registry |

Além disso, **5 MCP prompts** (`main.py:892–942`): `review_changes`, `architecture_map`, `debug_issue`, `onboard_developer`, `pre_merge_check`.

A maioria das tools aceita `detail_level: "standard" | "minimal"` — esse é o knob principal de economia de tokens (ver §4).

---

## 4. Como a economia de tokens **acontece de fato**

Investigando o código, há cinco mecanismos concretos. Em ordem decrescente de impacto plausível:

### 4.1 `detail_level="minimal"` — retorna sumários, não payloads

Demonstrável em `tools/review.py:73–122` (`get_review_context`), `tools/review.py:449–462` (`detect_changes_func`), e em vários outros. Quando `minimal`:

- Substitui listas de nodes por **contagens** (`changed_file_count`, `impacted_file_count`, `test_gap_count`).
- Devolve **5 nomes** de "key_entities" em vez do array completo.
- Para architecture overview, agrega N×M edges cross-community em 1 linha por par (`main.py:564–565`).

Este é o ganho **real e mensurável**. O default na maioria das tools, porém, é `"standard"`.

### 4.2 `get_minimal_context_tool` como roteador

`tools/context.py:37` é a tool anunciada como "ultra-compact (~100 tokens)" e que sugere a próxima tool a chamar (`context.py:115–131`). O objetivo é evitar que o agente faça `Read` em N arquivos quando precisa apenas saber "quanto risco há, onde mexer". O response é literalmente: stats + 1 risk + 3 communities + 3 flows + 3 sugestões. Isso **é** pequeno e é o ponto mais elegante do design.

### 4.3 Pruning por relevância — BFS de impacto com cap

`graph.py:606` `get_impact_radius()` faz BFS bidirecional com **CTE recursivo no SQLite** (`graph.py:689–707`):

- `max_depth=2` por padrão (`constants.py:18`).
- `max_nodes=500` por padrão (`constants.py:17`).
- Retorna `truncated: True` se passou do limite (`graph.py:723–725`).

Isto substitui um padrão tipo "leia todos os callers/callees recursivamente" do agente por **uma query SQL única**. É o caso clássico onde 1 chamada MCP substitui N `Grep`/`Read`.

### 4.4 FTS5 + embeddings opcionais para busca

`semantic_search_nodes_tool` usa `nodes_fts` (FTS5 virtual table, `docs/schema.md:230`) por padrão, e cai em vector search quando `embed_graph` rodou antes. Em vez de o agente abrir muitos arquivos procurando um nome, recebe lista ordenada de qualified_names + line ranges.

### 4.5 Caching dos docs internos

`get_docs_section_tool` (`main.py:372`) lê uma seção específica de `LLM-OPTIMIZED-REFERENCE.md` empacotado no wheel (`pyproject.toml:90–91`). Substitui `WebFetch` ou leitura do README inteiro.

### O que NÃO é mecanismo real

- **Não há resumo via LLM** ("compressão semântica"). `context_savings.py:13` usa `CHARS_PER_TOKEN = 4` — heurística textual.
- **Não há substituição de arquivos por assinaturas** automaticamente. Quem retorna assinatura é o `query_graph` para algumas patterns; o `get_review_context` com default `include_source=True` ainda **lê os arquivos** e pode anexar 200 linhas/arquivo (`main.py:251`).

### A metadata `context_savings` é estimativa

`context_savings.py:54` `estimate_context_savings()` retorna `{"estimated": True, "saved_tokens", "saved_percent"}`. O baseline (`estimate_file_tokens`, `context_savings.py:35`) usa **`stat().st_size / 4`**, ou seja, conta o tamanho em bytes do arquivo dividido por 4 e compara com o JSON serializado de saída. Existe verificação opcional com `tiktoken` em `context_savings.py:151` (`verify_with_tiktoken`), mas isso só roda no CLI quando `tiktoken` está instalado — não é o número exibido pela tool MCP.

---

## 5. Algoritmos centrais

- **BFS bidirecional via CTE recursivo SQLite** (`graph.py:689`) — engine default. Alternativa NetworkX existe (`graph.py:625`, `constants.py:23` via `CRG_BFS_ENGINE=networkx`).
- **Detecção de flows**: tracing iterativo a partir de entry points (HTTP handlers, CLI commands, tests detectados por decorator/nome — `flows.py:118,132,150`). Critério de criticality em `flows.py:308`.
- **Detecção de communities**: Leiden via `python-igraph` quando instalado (`communities.py:236` `_detect_leiden`); fallback file-based (`communities.py:350`). Split de oversized communities em `communities.py:441`.
- **Risk score** (`changes.py:219`): soma ponderada de — participação em flows (cap 0.25), cross-community callers (cap 0.15), gap de cobertura de testes (até 0.30), match de `SECURITY_KEYWORDS` (+0.20, `constants.py:7`), caller count (cap 0.10). Range final: [0, 1].
- **Hub/Bridge centralities** (`tools/analysis_tools.py`): degree-based para hubs; betweenness com sampling para >5000 nodes (`main.py:765`).
- **Diff de grafo**: existe `graph_diff.py` (~3.6KB). Não foi diretamente exposto como tool no inventário acima — auxiliar.
- **Surprising connections** (`main.py:799–803`): score composto de cross-community/cross-language/peripheral-to-hub/cross-test-boundary/unusual-edge-kind.

---

## 6. Custo de indexação

**Quando indexa**:

- `code-review-graph build` (full): `full_build()` em `incremental.py:820`.
- `code-review-graph update`: incremental, default `HEAD~1` (`incremental.py:919`).
- Hooks (`hooks/hooks.json:25–32`): roda `code-review-graph update --skip-flows` após `Write|Edit|Bash` no harness Claude Code, timeout 30s.
- Watch mode (`incremental.py:1067`) ou daemon (`daemon.py`).
- Após `EnterWorktree` (`hooks/hooks.json:14–22`) — rebuild full em background.

**O que pesa**:

- Parsing paralelo com `ProcessPoolExecutor` (`incremental.py:52,1010`). Chunksize 20.
- Pós-processamento: flows + communities + FTS5. `postprocess="minimal"` pula tudo menos signatures+FTS (`main.py:120–121`).
- Embeddings (opt-in): roda `sentence-transformers` localmente ou via API; envelopa em `asyncio.to_thread` porque trava o event loop em Windows (`main.py:332–335` cita issues #46, #136).

**Invalidação**: hash SHA-256 do arquivo (`incremental.py:977`). Schema mudou? `migrations.py` aplica em open.

Sem benchmark direto no código, mas o hook usa `timeout: 30s` (`hooks.json:30`), o que implica que repos grandes podem extrapolar — o `--skip-flows` mitiga.

---

## 7. Linguagens suportadas — confirmado no código

`parser.py:83` `EXTENSION_TO_LANGUAGE` tem 50+ extensões. Linguagens distintas confirmadas:

python, javascript, typescript, tsx, go, rust, java, csharp, ruby, cpp, c, kotlin, swift, php, scala, solidity, vue, dart, r, perl, lua, luau, objc, bash, elixir, notebook (.ipynb), zig, powershell, svelte, julia, **rescript** (regex, sem grammar), gdscript, nix, verilog/systemverilog, sql.

Também resolve interpreters via shebang (`parser.py:152` `SHEBANG_INTERPRETER_TO_LANGUAGE`) para scripts sem extensão.

Mas atenção:

- **ReScript** (`.res`, `.resi`): regex-based, sem tree-sitter (`parser.py:131–134`).
- **Bash**: somente function definitions (`parser.py:278`).
- **R**: sem classes via AST; pattern-matching em calls (`parser.py:199`).
- **Julia, Elixir, Nix, SQL**: handlers dispatchers especiais (`parser.py:281–298`).

Suporte real ≠ "Tree-sitter completo para tudo".

---

## 8. Pontos frágeis

- **Grep por TODO/FIXME/HACK retornou apenas 1 ocorrência** no pacote inteiro (`changes.py`). Repo bem higienizado — ou os TODOs estão como issues no GitHub (vários `# See: #46, #136` etc. ao longo do código).
- **Dependências pesadas**: tree-sitter-language-pack (>30 grammars empacotados), networkx, fastmcp, watchdog. Extras: sentence-transformers (heavy, ~5GB com modelos), python-igraph (build nativo), jedi, ollama, matplotlib.
- **Concorrência stdio MCP**: `main.py:64–66` deixa claro que `_default_repo_root` é global thread-unsafe; só funciona porque stdio MCP é single-threaded. HTTP/SSE quebraria — comentário pede `contextvars`.
- **Caps silenciosos**: `CRG_MAX_CHANGED_FUNCS=500` (`changes.py:319`), `MAX_IMPACT_NODES=500` (`constants.py:17`). Resultado vem com `truncated: True` mas o agente pode não perceber.
- **Detecção de testes é heurística**: nome começa com `test_`, termina com `_spec`, file matches pattern (`docs/schema.md:46–50`). Falsos negativos prováveis em projetos com convenção atípica.
- **Risk score é aditivo, não calibrado**: `changes.py:229–267` soma pesos arbitrários (0.05, 0.20, 0.30) sem base estatística.
- **A própria suíte de eval mostra que o ganho é discutível** — ver §9.
- **`pyproject.toml:75–78`** declara extra `all` que referencia `enrichment`, mas `enrichment` é definido **depois** (`pyproject.toml:76–78`). Funciona, mas é frágil. Também há comentários sobre CVEs corrigidas (`pyproject.toml:29–31`).

---

## 9. Por que (ou por que não) economiza tokens — análise honesta

### O que é demonstrável pelo código

1. **`get_minimal_context_tool` realmente é compacto.** O response cabe em poucas centenas de bytes. Se o agente realmente usar isso como entry point antes de tudo, troca uma sessão de `Read` por uma única chamada com sumário acionável. Mecanismo real.
2. **`detail_level="minimal"` reduz o payload mensuravelmente** ao trocar arrays por contagens (`tools/review.py:73–122`). Mecanismo real, **mas o default é `standard`** — depende do agente saber pedir minimal.
3. **BFS via CTE em uma chamada substitui Grep recursivo.** Mecanismo real e elegante: `get_impact_radius` retorna em uma round-trip o que normalmente custaria N×M chamadas de `Grep`/`Read`.
4. **FTS5/embeddings substituem `Grep` por busca ranqueada com qualified_name + linha.** Real, contanto que os embeddings tenham sido rodados (`embed_graph_tool` — opt-in, sentence-transformers pesado).

### O que é só claim do README

1. **"38x a 528x token reduction" (`README.md:32`).** Não bate com o que está em `evaluate/results/*_token_efficiency_*.csv`. Olhando o CSV gerado pelo próprio benchmark do projeto:

   ```
   repo,commit,description,changed_files,naive_tokens,standard_tokens,graph_tokens,naive_to_graph_ratio
   fastapi,fa3588…,Fix typo …,1,6045,299,195653,0.0
   fastapi,02279…,Exclude spam …,1,3844,735,133131,0.0
   ```

   Ou seja: para PRs reais pequenos, `graph_tokens` (output do `get_review_context` com defaults) é **>100k tokens**, enquanto o naive (ler os arquivos mudados) é **<10k**. Razão = 0.0. O graph é **mais caro**, não mais barato, quando o PR é pequeno. O algoritmo do benchmark está em `code_review_graph/eval/benchmarks/token_efficiency.py:68–88` — ele chama `get_review_context(changed_files=changed, repo_root=str(repo_path))` **com defaults** (`include_source=True`, `max_lines_per_file=200`, `detail_level="standard"`), serializa para JSON e conta chars/4. O resultado é honesto e desfavorável.

2. **A metadata `context_savings` que aparece nas respostas é uma estimativa baseada em `stat().st_size / 4`** (`context_savings.py:35`), comparado ao JSON serializado da resposta. Não é tokenização real. O próprio módulo se assume conservador (`context_savings.py:1–5`). Existe verificação opcional com `tiktoken` (`context_savings.py:151`), mas só no CLI quando `tiktoken` está instalado — não no MCP.

3. **"500× para gigamonorepos" (claim implícito do diagrama 1)**: precisaria de baseline tipo "agente faria full repo scan", que é um straw-man. Para um PR pequeno, ler os N arquivos mudados continua sendo o mais barato.

### Conclusão mecanística

O ganho real do `code-review-graph` é situacional:

- **Ganha** quando o agente quer (a) ranking semântico cross-file, (b) blast radius transitivo de mudança em código com muitos consumers, (c) priorização de risco (test gaps + caller count) sem ler tudo, (d) entry-point sumário (`get_minimal_context`).
- **Empata** quando o PR é pequeno e localizado (1–3 arquivos): ler os arquivos é mais barato que a serialização JSON da subgraph com snippets.
- **Perde** quando o agente chama `get_review_context` com defaults: a soma de impacted_nodes + edges + source_snippets serializada em JSON com aspas escapadas dobra ou triplica o custo de simplesmente abrir os mesmos arquivos.

O design é sólido — incremental build, hash-based caching, BFS via SQLite CTE, FTS5, `detail_level` knob, MCP-native. O **marketing está à frente do mecanismo**: o ganho não é universal, depende fortemente do agente saber pedir `detail_level="minimal"` e começar por `get_minimal_context`, e o próprio benchmark do projeto (que ninguém citou no README) mostra ratio ≈ 0 nos casos default.

A integração mais defensável para Claudin é: usar `get_minimal_context` como primeira chamada de sessões de review, usar `get_impact_radius`/`detect_changes` com `detail_level="minimal"` em PRs > 5 arquivos, e **não** usar `get_review_context` com defaults — preferir `Read` direto nesses casos.
