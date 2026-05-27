# Fit-analysis: `code-review-graph` no Claudio

**Data:** 2026-05-27
**Repo avaliado:** `/home/viudes/projects/code-review-graph` (v2.3.5, commit `0c9a5ff`)
**Claudio:** `main` em `c541013`
**Escopo:** decidir se vale trazer ideia ou integração; sem plano de implementação.

---

## Parte A — Evidências quantitativas no próprio `code-review-graph`

### A.1 Tamanho e forma do repo

| Métrica | Valor |
|---|---|
| Tamanho total | 21 MB (inclui imagens dos diagramas) |
| Arquivos `.py` (repo todo) | 102 |
| LOC Python só em `code_review_graph/` | **25.579** (37 arquivos) |
| Arquivo mais pesado | `parser.py` — **6.850 LOC** (tabelas tree-sitter por linguagem) |
| Outros gigantes | `visualization.py` 2.184, `skills.py` 1.449, `graph.py` 1.367, `cli.py` 1.242, `incremental.py` 1.234, `main.py` 1.079, `embeddings.py` 990, `daemon.py` 962 |
| Pacote secundário | `code-review-graph-vscode/` (extensão VS Code em TypeScript) |
| Testes | 33 arquivos `tests/test_*.py` cobrindo parser, daemon, embeddings, incremental, fts, communities, flows, skills, refactor etc. |
| Commits totais | 464 (projeto vivo, último de hoje) |

Vide `code_review_graph/` (`wc -l` em todos os `.py`) e `pyproject.toml:7` para a versão.

### A.2 Dependências top-level (`pyproject.toml:27-38`)

- `mcp>=1.0.0,<2` — protocolo MCP cliente/servidor
- `fastmcp>=3.2.4` — bind para servir MCP (corrige CVE-2025-62800/62801/66416)
- `tree-sitter>=0.23` + `tree-sitter-language-pack` — parsing AST multi-linguagem
- `networkx>=3.2` — grafo em memória
- `watchdog>=4` — file-watch para modo daemon
- Opcionais: `sentence-transformers` (embeddings locais), `google-generativeai`, `igraph` (communities Leiden), `jedi` (resolver Python), `ollama` (geração de wiki)

Persistência: **SQLite local** com WAL + FTS5 (`docs/architecture.md:74-87`). Schema versionado e gate de CI valida que o schema do servidor Python bate com o da extensão VS Code (`.github/workflows/ci.yml:55-71`).

### A.3 Linguagens-alvo declaradas

`parser.py` é o nó central. O README anuncia suporte para Python, JavaScript, TypeScript, Go, Java, Ruby, PHP, Rust, C#, C/C++, Kotlin, Swift, Scala, ReScript, Spring (resolvers dedicados: `jedi_resolver.py`, `rescript_resolver.py`, `spring_resolver.py`, `tsconfig_resolver.py`, `temporal_resolver.py`). Tudo via tree-sitter-language-pack.

### A.4 Maturidade — CI, hooks, skills

- **CI** (`.github/workflows/ci.yml`): jobs `lint` (ruff), `type-check` (mypy), `security` (bandit), `schema-sync` (gate que compara versão de schema Python ↔ VSCode), `test` em matriz 3.10/3.11/3.12/3.13. Workflow de `publish` separado.
- **Hooks** (`hooks/hooks.json`): integra como hooks do Claude-Code-compatíveis em três pontos:
  - `SessionStart` → `code-review-graph status` (10s timeout)
  - `PostToolUse` em `EnterWorktree` → roda `build` em background
  - `PostToolUse` em `Write|Edit|Bash` → `update --skip-flows` (timeout 30s)
- **Skills** (`skills/`): 7 skills (`build-graph`, `debug-issue`, `explore-codebase`, `refactor-safely`, `review-changes`, `review-delta`, `review-pr`) — cada uma roteia explicitamente para os MCP tools (ex.: `skills/review-pr/SKILL.md:11` instrui chamar `get_review_context_tool` antes de ler arquivos).
- **MCP tools expostos:** 30 tools + 5 prompts (`docs/COMMANDS.md` via `docs/INDEX.md:5`).

### A.5 Benchmarks e evals

Pipeline de eval em `code_review_graph/eval/` (`runner.py`, `scorer.py`, `reporter.py`, `token_benchmark.py`) e em `code_review_graph/eval/benchmarks/`:

- `token_efficiency.py` — compara 3 caminhos para o mesmo commit:
  - **naive**: tokens do conteúdo completo dos arquivos mudados
  - **standard**: tokens do `git diff`
  - **graph**: tokens do `get_review_context` da ferramenta
  - Token-counter usado é **aproximação `len(text)//4`** (`eval/benchmarks/token_efficiency.py:13-15`) — não tiktoken na pipeline canônica.
- `impact_accuracy.py`, `multi_hop_retrieval.py`, `search_quality.py`, `flow_completeness.py`, `build_performance.py`.
- Configs em YAML por repo-alvo (`eval/configs/`): code-review-graph, express, fastapi, flask, gin, httpx.
- Resultados versionados em `evaluate/results/*_2026-05-25.csv`.

**Achado importante — autoavaliação do próprio repo (`evaluate/results/code-review-graph_token_efficiency_2026-05-25.csv`)**:

| commit | changed files | naive | standard (diff) | **graph** | naive/graph | std/graph |
|---|---|---|---|---|---|---|
| `528801f` | 3 | 10.858 | 4.147 | **215.154** | 0,1 | 0,0 |
| `84bde35` | 2 | 8.113 | 394 | **203.906** | 0,0 | 0,0 |

No próprio repo do projeto, o `graph_tokens` está **~20×–500× MAIOR** que o naive/diff. Ou seja: rodando a pipeline canônica de eval sobre o próprio repo, **o "graph context" é mais caro que ler tudo**. Para `express/fix qs CVE` o ratio é melhor (1.015 graph vs 682 naive, 0,7×), mas para `express/test res.type` o graph_tokens é 84.930 vs naive 703 — **120× mais caro** que ler o arquivo inteiro.

O README estampa "38×–528× token reduction across 6 real repositories" no diagrama 1, mas os CSVs canônicos mostram que o ganho **depende muito do tipo de mudança** — em diffs pequenos com poucos dependentes o naive ganha por larga margem. Não há claim quantitativa que sobreviva sem ser segmentada por classe de change.

Impact accuracy do próprio repo (`evaluate/results/code-review-graph_impact_accuracy_2026-05-25.csv`): F1 de 0,667 e 0,80 em 2 commits — amostra pequena.
Multi-hop retrieval: anchor sempre encontrado, neighbor_recall 1.0 em 2 amostras — também amostra pequena.

### A.6 O que mediria se rodasse

Não rodei o `build` aqui (~25k LOC Python + tree-sitter language-pack instalado pesa). A própria architecture (`docs/architecture.md:49-69`) descreve que o full-build varre `git ls-files`, parseia todos com tree-sitter, persiste em SQLite. Não há número público para "indexar o Claudio (1.870 arquivos `.test.ts`+`.ts`) dá X MB de DB / Y nós / Z minutos" — teria que ser medido.

---

## Parte B — Fit no Claudio

### B.4 Onde a abordagem ajudaria mais (mapeado ao código real)

| Superfície do Claudio | Onde | Hipótese de ganho | Quão sólida é? |
|---|---|---|---|
| **Agente Explore** | `src/tools/AgentTool/built-in/exploreAgent.ts:13-57` (83 LOC) — hoje só usa Grep/Glob/Read/Bash | Em vez de N rodadas de grep+read, primeira query bate num índice de símbolos: "quem chama X?" sai em 1 hop | Plausível em monorepos grandes. Não mensurada em Claudio. |
| **`/review`** | `src/commands/review.ts` (57 LOC) | Listar blast-radius de um diff antes de gerar review reduz "ah, esqueci de olhar o caller Y" | Plausível. O fluxo de `skills/review-pr/SKILL.md` é exatamente isso. |
| **`/security-review`** | `src/commands/security-review.ts` (243 LOC) | Mesmo argumento: para auditar fluxo de tainted data, seguir edges `callers_of`/`callees_of` é mais barato que grep recursivo | Plausível mas não medido. |
| **FileEditTool** | `src/tools/FileEditTool/FileEditTool.ts` (649 LOC) | Antes de renomear símbolo, listar callers para preview/guard | Valor real, mas o uso típico de FileEditTool é edição local; renames cross-file no Claudio hoje usam Grep e o usuário valida — o ganho é em UX, não em correctness. |
| **Compaction** | `src/services/contextCompaction*` (não citei, evito over-claim) | Substituir "snapshot dos arquivos lidos" por "lista de qualified-names tocados" no resumo da compaction | Ideia atraente, mas o overhead de manter o grafo sincronizado durante uma sessão pode comer o ganho. **Não medido.** |
| **MCP client nativo** | `src/services/mcp/client.ts` (66 LOC) — já fala MCP fora-da-caixa | Ponto óbvio: o projeto JÁ se serve como MCP server. Não precisa de código no Claudio para o usuário plugar. | **Sólido.** Zero esforço de engenharia. |

### B.5 Caminhos de integração — leve → pesado

**(a) Documentar como MCP server externo opcional (zero código no Claudio)**
- **Esforço:** ~1h de doc (README ou `docs/recipes/`) com snippet de `~/.claudio/settings.json` apontando para `code-review-graph serve`.
- **Valor:** usuário decide se quer rodar; sem custo de manutenção pro Claudio.
- **Risco:** nenhum — é literalmente a finalidade do MCP. Privacidade: tudo local-first (SQLite no repo do usuário).
- **O que aprenderíamos primeiro:** indexar o próprio Claudio leva quanto tempo? DB fica de que tamanho? Em 3-4 sessões reais de dev, quantas vezes o usuário invocou um tool do CRG vs Grep nativo?

**(b) Recomendar via skill / docs como complemento ao Explore**
- **Esforço:** doc + talvez uma nota no prompt do `exploreAgent` ("if a code-graph MCP server is connected, prefer its `callers_of`/`callees_of` before grep").
- **Valor:** pequeno empurrão pra adoção, sem código.
- **Risco:** prompt-engineering frágil; se o MCP server não estiver conectado, o agente pode ficar confuso. Hoje o Explore tem instrução super-direta sobre quais tools usar (`exploreAgent.ts:43-50`) — adicionar branching condicional polui o prompt.
- **Aprenderíamos primeiro:** a doc-only (caminho a) basta para os early adopters?

**(c) Portar a ideia central (índice de símbolos persistente) para uma tool nativa em TS**
- **Esforço:** **alto**. O parser do CRG são 6.850 LOC só de tabelas de node-type por linguagem, mais resolvers por linguagem (jedi, tsconfig, rescript, spring). Replicar isso em TS é projeto de meses. Tree-sitter tem bindings TS, mas o capital de conhecimento empírico (qual node-type capturar em cada grammar) está no Python.
- **Valor:** controle total + integração elegante. Bom para um produto vertical.
- **Risco:** **alto e múltiplo**:
  - Tamanho do bundle (`tree-sitter` + 14 grammars) infla `dist/cli.mjs` substancialmente — checar contra `bun run build` e `bun run smoke` (hoje o bundle todo cabe em poucos MB).
  - Manutenção de schema de DB vira responsabilidade do Claudio.
  - Privacidade: cache de DB em `~/.claudio/projects/<repo>/graph.db` cai fora do gate atual do `verify:privacy` (que só inspeciona `dist/cli.mjs` — ver memória `verify-privacy-bundle-only`). Não é phone-home, mas é mais 1 superfície de runtime para auditar.
  - Vai duplicar trabalho que o autor original já mantém upstream e em pace alto (464 commits, último de hoje).
- **Aprenderíamos primeiro:** roda o caminho (a) por 4-6 semanas; conta uso; se a tool virar pilar real do workflow → considera; se virou novidade-de-1-semana → não.

**(d) Não trazer nada — usuário pluga via MCP se quiser**
- **Esforço:** zero.
- **Valor:** zero direto, mas mantém o Claudio enxuto e respeita a separação de responsabilidades (Claudio é agente; CRG é infra de indexação).
- **Risco:** zero.

### B.6 Bandeiras vermelhas

1. **Linguagem.** Claudio é TS-puro; CRG é Python puro com binários nativos do tree-sitter. Portar é projeto independente; usar como dep externa via MCP é o caminho de menor atrito.
2. **Dependências.** Adicionar tree-sitter + 14 grammars + (opcional) sentence-transformers/igraph/jedi como dep do Claudio é fora-de-escopo para um agent CLI distribuído como bundle único.
3. **Escopo restrito.** O nome é "code-**review**-graph". Os skills, prompts e MCP tools são todos centrados em PR/diff/refactor. Para navegação ad-hoc ("quem chama essa função?") funciona, mas o framing é diff-first.
4. **Maturidade vs hype.** O projeto é sério (CI completo, schema-sync gate, testes, multi-versão de Python), mas **os benchmarks do README sobre-vendem** o ganho médio: a tabela do README diz 38×–528×, mas as CSVs canônicas do próprio repo mostram graph_tokens > naive_tokens em vários commits. Isso casa com a memória `no-overclaim-performance`: se trouxer para o Claudio, **não usar os números do marketing como justificativa**; rodar a própria medida.
5. **Sobreposição com o que o Claudio já faz bem.** Grep+Glob com ripgrep em projeto bem-organizado resolve a vasta maioria das perguntas de navegação. O agent Explore já paraleliza. O ganho marginal precisa ser demonstrado, não assumido — especialmente em repos < 50k LOC onde grep é instantâneo.
6. **Manutenibilidade.** O CRG está mudando rápido (release 2.3.5 e novo commit hoje). Acoplar o Claudio ao schema de SQLite dele expõe a quebras semanais; via MCP, a interface é mais estável.
7. **Privacidade/runtime.** `~/.claudio/v8cache/` e settings já são as únicas escritas auditadas; um DB SQLite por repo seria mais 1 superfície persistida. Caminho (a) empurra essa responsabilidade pro CRG, que é o lugar certo.

### B.7 Próximos passos (max 5, acionáveis, sem prometer implementação)

1. **Medir custo de indexação no próprio Claudio.** Rodar `code-review-graph build` em `/home/viudes/projects/claudio` e anotar: tempo, tamanho do `.code-review-graph/graph.db`, contagem de nodes/edges. Sem isso, qualquer claim de "ajuda no Explore" é especulação.
2. **Rodar a pipeline de eval do CRG sobre 5 commits reais do Claudio** (ex.: 5 últimos PRs mergeados que mudam >1 arquivo) usando os benchmarks `token_efficiency` + `impact_accuracy`. Se o `graph_tokens` for > `naive_tokens` na maioria — como aconteceu no auto-eval do próprio repo do CRG — a tese cai.
3. **Adicionar uma receita doc-only** (`docs/recipes/code-review-graph-mcp.md`) com snippet de `settings.json` e disclaimer ("ganhos variam por commit; rode o seu próprio benchmark"). Caminho (a). Zero código.
4. **Usar 3-4 sessões reais de dev** com o MCP server conectado e logar: quantos tool-calls foram pro CRG, quantos pro Grep nativo, qual prompt-shape o agente usou. Memória de team `discovery-workflow` pede ganhos medidos; aqui é a etapa "medida".
5. **Só considerar caminhos (b) ou (c) se** os passos 2 e 4 mostrarem ganho consistente E o uso for >20% das navegações. Caso contrário, fica em (a) ou (d).

---

## Veredito

**Interessante, mas não trazer nada para dentro do Claudio agora.** A integração via MCP externo (caminho **a**) é o único movimento defensável hoje: respeita a separação Claudio-como-agente / CRG-como-infra, tem custo de engenharia zero, e não compromete o bundle nem o gate de privacidade.

Os benchmarks do README do CRG não se sustentam quando se olha os CSVs canônicos do próprio repo — em vários commits, `graph_tokens` é uma ordem de grandeza MAIOR que ler tudo. Portanto, antes de qualquer trabalho de portar para TS (caminho c), o passo correto é **medir no próprio Claudio** e decidir com número, não com diagrama promocional.

Em projetos pequenos ou médios (Claudio cabe nessa categoria para o agent Explore atual), ripgrep + Grep nativo são imbatíveis em latência. A tese do grafo só fica forte em codebases grandes/multi-linguagem com revisão frequente de PR — perfil que não é o uso dominante do Claudio em modo CLI.
