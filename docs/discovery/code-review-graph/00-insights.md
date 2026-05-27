# Discovery: code-review-graph — insights consolidados

**Data:** 2026-05-27
**Repo avaliado:** `/home/viudes/projects/code-review-graph` v2.3.5 (`0c9a5ff`, último commit hoje)
**Claudio:** `main` em `c541013`
**Documentos-fonte:**
- `01-claims-e-promessa.md` — análise do README e docs
- `02-arquitetura-e-mecanismo.md` — código interno e mecanismo real de economia
- `03-fit-no-claudio.md` — encaixe no Claudio + bandeiras vermelhas

---

## TL;DR

**Projeto sério, design sólido, marketing à frente do mecanismo.** O `code-review-graph` (CRG) é um MCP server local-first que constrói um grafo Tree-sitter do repo em SQLite e expõe 29 tools + 5 prompts para review/exploração. **Não trazer código para dentro do Claudio agora.** O caminho defensável é uma receita doc-only que ensina o usuário a plugar o CRG como MCP externo — e só considerar mais se medirmos ganho real no próprio Claudio.

---

## O que é demonstravelmente real

1. **`get_minimal_context_tool`** (~100 tokens de output): stats + risk + top-3 communities + top-3 flows + `next_tool_suggestions`. Roteador elegante, evita `Read`-em-N-arquivos para perguntas de orientação inicial. (`tools/context.py:37`)
2. **BFS de impacto via CTE recursivo no SQLite** (`graph.py:689`): substitui N chamadas de `Grep`/`Read` por uma SQL única, com `max_depth=2` e `max_nodes=500`. Caso clássico onde 1 round-trip MCP < dezenas de tool calls.
3. **`detail_level="minimal"`** troca arrays por contagens em várias tools (`tools/review.py:73`). Knob real, **default ainda é `standard`** — depende do agente saber pedir.
4. **FTS5 nativo + embeddings opt-in** para busca semântica retornando qualified_name + linha, em vez de o agente abrir arquivos para descobrir nome.
5. **Build incremental sério**: hash SHA-256 por arquivo, parsing paralelo via `ProcessPoolExecutor`, watch via `watchdog`, daemon multi-repo, schema migrado (v1→v9). (`incremental.py:919`, `daemon.py`)
6. **Maturidade técnica alta para beta**: CI matriz 3.10–3.13, lint+mypy+bandit+schema-sync, 33 arquivos de teste, releases mensais, CVEs patcheadas (`fastmcp >=3.2.4`).
7. **Calibração honesta com `tiktoken`** (`context_savings.py:151`) — disponível só no CLI, mas existe.

---

## O que é claim sem suporte do próprio repo

1. **"38× a 528× token reduction" do README NÃO bate com os CSVs canônicos do próprio benchmark.** Em `evaluate/results/*_token_efficiency_*.csv` do CRG:

   ```
   fastapi, "Fix typo", 1 file: naive=6.045  graph=195.653  ratio=0.0
   fastapi, "Exclude spam", 1 file: naive=3.844  graph=133.131  ratio=0.0
   express, commit pequeno:      naive=703    graph=84.930   (120× MAIS caro)
   ```

   O algoritmo do benchmark (`eval/benchmarks/token_efficiency.py:68`) chama `get_review_context` **com defaults** (`include_source=True`, `max_lines_per_file=200`, `detail_level="standard"`). Para PRs pequenos (1–3 arquivos), **graph_tokens > naive_tokens** com larga margem.

2. **A metadata `context_savings` exibida pelas tools é estimativa de `stat().st_size / 4`** (`context_savings.py:35`), não tokenização real. O baseline é "ler o arquivo inteiro" — straw-man quando o agente real só leria a parte relevante.

3. **README não compara com NADA.** Nenhuma menção a Serena, ast-grep MCP, ctags, LSP-based tools, Sourcegraph. O único frame é "graph vs whole-corpus dump", que infla os ganhos vs. um workflow Grep/LSP bem feito.

4. **Limitações admitidas mas escondidas em parágrafo final** (`README.md:183`): MRR de search = 0,35; flow detection = 33% recall; precision média de impacto = 0,58 (otimizada para 100% recall).

---

## Por que é um fit ruim para o Claudio agora

- **Linguagem.** CRG é 25.579 LOC de Python + tree-sitter binário (parser.py sozinho tem 6.850 LOC de tabelas por linguagem). Claudio é bundle TS único. Portar = projeto de meses.
- **Bundle.** Adicionar tree-sitter + 14 grammars + opcionais (sentence-transformers ~5GB, igraph nativo) ao `dist/cli.mjs` é fora de escopo para um agent CLI distribuído como bundle único.
- **Sobreposição com o agent Explore.** Em projetos < 50k LOC (Claudio cabe nessa categoria), `ripgrep` + `Grep`/`Glob` paralelos do Explore agent já são instantâneos. O ganho marginal precisa ser **demonstrado**, não assumido — casa com `no-overclaim-performance`.
- **Privacidade.** `verify:privacy` só inspeciona `dist/cli.mjs`. Um `.code-review-graph/graph.db` por repo seria mais 1 superfície persistida fora do gate atual (memória `verify-privacy-bundle-only`).
- **Manutenibilidade.** CRG está em cadência semanal (2.3.4 → 2.3.5 em 17 dias). Acoplar o Claudio ao schema SQLite dele expõe a quebras frequentes; via MCP, a interface é estável por contrato.
- **Bus factor.** Single maintainer (Tirth).
- **Framing diff-first.** Os 5 prompts + 7 skills + o nome são todos centrados em PR/review/refactor. Para navegação ad-hoc o CRG funciona, mas o produto é "review", não "navegação".

---

## O que vale a pena trazer (sem trazer código)

### Ideias para o Claudio em si

1. **Token-budget visível pós-tool-call.** O `context_savings` do CRG, mesmo sendo estimativa, é didático: usuário/agente vê em cada response "saved 92%". Já temos `TOKEN_BUDGET` flag (`scripts/build.ts`); valeria explorar surfacing per-tool, não só per-session.
2. **`detail_level` como padrão de tools que retornam grafos/diffs.** Se o `/review` evolui para incluir blast-radius, vale aplicar o mesmo knob `minimal|standard|full` em vez de assumir verbosidade default.
3. **Roteador inicial barato.** A ideia do `get_minimal_context` (1 chamada → mapa de "onde mexer" + 3 sugestões de próximas tools) é replicável no Claudio: um Explore-agent mode "orient" que devolve <100 tokens antes de qualquer outra chamada. Hoje o Explore parte direto para Grep/Read.
4. **Skill `review-pr` / `review-delta`.** O Claudio tem `/review` mas a abordagem do CRG (entry-points → flows → impact → guidance) é um shape de prompt útil de inspirar, mesmo sem grafo.

### Sobre como NÃO escrever benchmarks

- O CRG é um bom exemplo do que NÃO fazer: tabela de ganhos no README sem citar os CSVs do próprio repo que contradizem. Para o Claudio, ao publicar ganhos (ex.: bash-output-filter já reporta ~50k tokens/sessão), continuar atrelando número a método reproduzível **e** ao recorte onde o ganho **não** acontece.

---

## Veredito e próximos passos

**Veredito:** interessante como referência arquitetural; **não trazer código**; recomendar como **MCP server externo opcional** via doc.

**Próximos passos sugeridos (sem implementação):**

1. **Receita doc-only** em `docs/recipes/code-review-graph-mcp.md` mostrando snippet de `settings.json` para plugar o CRG como MCP server externo, com disclaimer "ganhos variam por commit; rode o seu próprio benchmark".
2. **Antes de qualquer integração mais profunda**, medir no Claudio:
   - `code-review-graph build` em `/home/viudes/projects/claudio` → tempo, tamanho do DB, contagem de nodes/edges.
   - Pipeline de eval (`token_efficiency.py` + `impact_accuracy`) sobre 5 commits recentes do Claudio. Se `graph_tokens > naive_tokens` na maioria, a tese cai aqui também.
3. **Reaproveitar a ideia do `detail_level="minimal"`** em tools nossas que serializam estruturas (revisitar `/review`, eventual blast-radius), independentemente do CRG.
4. **Reaproveitar a ideia do response-com-`context_savings`** como padrão de UX em tools custosas — mesmo com estimativa simples (chars/4), o feedback per-call é útil.
5. **Não considerar caminho (b) instrução-no-prompt nem caminho (c) port-para-TS** até os passos 1 e 2 mostrarem ganho real e adoção real >20% das navegações.
