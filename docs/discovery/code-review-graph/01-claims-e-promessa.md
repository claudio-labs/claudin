---
title: code-review-graph — Claims e Promessa (análise do README e docs)
date: 2026-05-27
fonte: /home/viudes/projects/code-review-graph @ commit 0c9a5ff (v2.3.5)
---

# 1. Problema resolvido e tese central

A tese central é declarada logo no topo: **"Stop burning tokens. Start reviewing smarter."** (`README.md:4`).

O problema explícito: agentes de IA (Claude Code, Codex, Cursor, etc.) **re-lêem grandes porções do código** em tarefas de review, queimando contexto.

> "AI coding tools can end up re-reading large parts of your codebase on review tasks. `code-review-graph` fixes that. It builds a structural map of your code with Tree-sitter, tracks changes incrementally, and gives your AI assistant precise context via MCP so it reads only what matters." (`README.md:29`)

A solução proposta: um **grafo de conhecimento local-first** (SQLite) construído via Tree-sitter, atualizado incrementalmente, consultado em tempo de review para entregar o **conjunto mínimo de arquivos** que o agente precisa ler — em vez de varrer o repo (`README.md:80`, `docs/architecture.md:5`).

A descrição oficial do `pyproject.toml:8` reforça: *"Local-first knowledge graph for token-efficient code review through MCP and CLI"*.

# 2. Claims sobre economia de tokens (com números)

Os claims são concretos e tabelados:

- **Headline:** redução de **38x a 528x** de tokens por pergunta vs. corpus completo, mediana ~82x, em 6 repos reais (`README.md:32`, `README.md:143`).
- **Tabela por repo** (`README.md:136-141`):
  - fastapi: 951.071 → 2.169 tokens = **528,4×**
  - code-review-graph: 208.821 → 2.495 = **93,0×**
  - gin: 166.868 → 1.990 = **91,8×**
  - flask: 125.022 → 1.986 = **71,4×**
  - express: 135.955 → 3.465 = **40,6×**
  - httpx: 89.492 → 2.438 = **38,0×**
- **Monorepo:** 27.700+ arquivos excluídos do contexto, só ~15 efetivamente lidos (`README.md:104`).
- **Painel `Token Savings`** no CLI exemplifica: 12.921 → 762 tokens (~94% economizado) (`README.md:287-294`, `CHANGELOG.md:23-30`).
- **Calibração com tiktoken** (`cl100k_base`, GPT-4): a estimativa fica **dentro de ~1% dos tokens reais** em agregado de 222 arquivos amostrados; bias por repo limitado a ±12% (`README.md:303`, `CHANGELOG.md:32-40`).
- **Metadado `context_savings`** anexado a respostas JSON de `get_impact_radius`, `get_review_context`, `detect_changes`, `get_architecture_overview` (`README.md:305`).
- **Caveat honesto:** o benchmark formal `eval/benchmarks/token_efficiency.py` reporta razões **abaixo de 1** para commits pequenos — admitido como esperado, não bug (`README.md:145`).

# 3. UX / Fluxo proposto

É **simultaneamente CLI, MCP server e skills** — o caminho principal é MCP.

- **Install one-liner:** `pip install code-review-graph && code-review-graph install` auto-detecta plataformas (Codex, Claude Code, Cursor, Windsurf, Zed, Continue, OpenCode, Antigravity, Gemini CLI, Qwen, Qoder, Kiro, GitHub Copilot, Copilot CLI) e escreve a config MCP de cada uma (`README.md:39-45`, `README.md:581`).
- **MCP server:** entrypoint via `code-review-graph serve` (`.mcp.json:4-6` usa `uvx code-review-graph serve`), expondo **30 ferramentas MCP + 5 prompts** (`README.md:361-401`, `docs/architecture.md:23`).
- **CLI standalone:** comandos `build`, `update`, `watch`, `status`, `visualize`, `detect-changes --brief`, `wiki`, `serve`, `daemon`, `eval`, `register`, `embed` (`README.md:251-275`).
- **Daemon multi-repo:** `crg-daemon start` mantém o grafo fresco em background (`README.md:322-336`).
- **Skills/slash commands:** `/code-review-graph:build-graph`, `/review-delta`, `/review-pr` (`README.md:240-243`); skills físicos em `skills/{build-graph,debug-issue,explore-codebase,refactor-safely,review-changes,review-delta,review-pr}/SKILL.md`.
- **VS Code extension:** subprojeto `code-review-graph-vscode/` (CLAUDE.md:39-41).
- **Fluxo recomendado ao agente:** chamar `get_minimal_context` primeiro (~100 tokens), usar `detail_level="minimal"`, alvo ≤5 tool calls e ≤800 tokens por tarefa (`CLAUDE.md:7-13`).

# 4. Casos de uso primários

Mapeáveis aos 5 prompts MCP (`README.md:399-401`) e às 7 skills:

1. **Code review de diff/PR** — `detect_changes_tool`, `get_review_context_tool`, skill `review-pr`/`review-delta` (`README.md:243`, `skills/review-pr/SKILL.md`).
2. **Análise de blast radius / impacto** — `get_impact_radius_tool`, `get_affected_flows_tool` (`README.md:88`, `CLAUDE.md:191`).
3. **Pre-merge check** — prompt `pre_merge_check` (`README.md:400`).
4. **Onboarding em codebase** — prompt `onboard_developer`, skill `explore-codebase`.
5. **Arquitetura** — `get_architecture_overview_tool`, `list_communities_tool` (`README.md:385`).
6. **Debug** — prompt `debug_issue`, skill `debug-issue`.
7. **Refactor seguro** — `refactor_tool`, `apply_refactor_tool`, dead-code detection (`README.md:222`, skill `refactor-safely`).
8. **Busca semântica/keyword híbrida** — `semantic_search_nodes_tool` + FTS5 (`README.md:227`).
9. **Multi-repo search** — `cross_repo_search_tool` (`README.md:397`).
10. **Visualização** — D3 interativo, exports GraphML/SVG/Obsidian/Cypher (`README.md:258-262`).

# 5. Comparações vs. alternativas

**Não há nenhuma comparação explícita** com Serena, ast-grep, ctags, LSP nem ripgrep no `README.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `CHANGELOG.md`, `docs/architecture.md` ou `docs/FEATURES.md` (Grep confirmou: zero matches dos termos `Serena|ast-grep|ctags|LSP|ripgrep|alternative|versus`).

O único frame comparativo é interno e contra o "baseline naïve":

- **Whole-corpus dump vs graph query** — é o eixo único de comparação (`README.md:134-141`).
- **Grep/Glob/Read** mencionado apenas como **fallback inferior** dentro das instruções do próprio projeto: *"ALWAYS use the code-review-graph MCP tools BEFORE using Grep/Glob/Read"* (`CLAUDE.md:169-173`, `AGENTS.md:89-93`, `GEMINI.md:4-8`). Isso é prescrição de uso, não benchmark comparativo.
- **Não posiciona vs. Sourcegraph, Glean, ast-grep, Serena MCP, ctags, LSP-based MCP servers** — ausência notável.

# 6. Limitações e trade-offs admitidos

Bloco dedicado em `README.md:183-192`:

- **Small single-file changes:** contexto do grafo pode **exceder** leitura naïve em edits triviais (visível no express na tabela F1).
- **Search quality:** MRR = **0,35**; ranking precisa melhorar; express retorna 0 hits por padrão de naming de módulos.
- **Flow detection:** apenas **33% de recall**, confiável só em Python (fastapi, httpx); JS e Go precisam de trabalho.
- **Precision vs recall:** análise de impacto deliberadamente conservadora — **100% recall, F1 médio 0,71, precision média 0,58** (`README.md:165`).
- **Embeddings:** atualmente embedam só **signatures (~10 tokens/nó)** — modelos grandes (Gemini 2, Qwen3-8B) não brilham nesse input curto; body/docstring é follow-up (`README.md:482-488`).
- **`token_efficiency.py` benchmark** dá razões <1 em commits pequenos — explicado, não escondido (`README.md:145`).
- **Windows quirks** documentados (FastMCP, JSON config, deadlock semantic search) (`README.md:542-553`, `CHANGELOG.md:156`).

# 7. Versão, status e maturidade

- **Versão atual:** `2.3.5` (`pyproject.toml:7`, `CHANGELOG.md:5`), lançada **2026-05-25**.
- **Status oficial:** `Development Status :: 4 - Beta` (`pyproject.toml:17`).
- **Maturidade aparente:** **alta para beta**. Sinais:
  - CHANGELOG denso e disciplinado, com seções Added/Changed/Fixed/Tests/Docs e referências a issues (#469, #486, #503, #508).
  - **22 arquivos de teste**, 486 testes mencionados (v2.0), CI matrix 3.10–3.13, cobertura mínima 65% (`CLAUDE.md:111-116`).
  - Commits recentes (últimos 15) mostram cadência ativa: releases 2.3.4 e 2.3.5 em 17 dias, hardening de segurança (CVE-2025-62800/62801/66416 corrigidos via bump de fastmcp — `pyproject.toml:29-32`).
  - Migrações de schema versionadas v1–v9 (`CLAUDE.md:36`).
  - Site próprio (`code-review-graph.com`), Discord, badges PyPI/CI.
  - Eval pipeline determinístico (Leiden com seed fixa, SHAs pinados) — sinal de rigor (`CHANGELOG.md:63-87`).
- **Author:** Tirth (`pyproject.toml:13`), single-maintainer.

# 8. Linguagens suportadas e dependências chave

**Linguagens (`README.md:201`, `docs/FEATURES.md:25`):** Python, JavaScript/TypeScript/TSX, Go, Rust, Java, C/C++, C#, Ruby, Kotlin, Swift, PHP, Scala, Solidity, Dart, R, Perl, Lua/Luau, Objective-C, shell, Elixir, Zig, PowerShell, Julia, ReScript, GDScript, Nix, Verilog/SystemVerilog, SQL, Vue/Svelte SFCs, Astro (via TS), Jupyter/Databricks `.ipynb`, Perl XS `.xs`. ~30+ no total.

**Dependências hard (`pyproject.toml:27-38`):**
- `mcp >=1.0.0,<2`
- `fastmcp >=3.2.4` (pinado por CVEs)
- `tree-sitter >=0.23.0,<1` + `tree-sitter-language-pack >=0.3.0,<1`
- `networkx >=3.2,<4`
- `watchdog >=4.0.0,<6`
- `tomli` (py <3.11)
- **Storage:** SQLite (stdlib, WAL mode) — sem DB externo.

**Opcionais (`pyproject.toml:51-78`):** sentence-transformers (embeddings locais), google-generativeai (Gemini), igraph (Leiden), jedi (Python call resolution), matplotlib (eval), ollama (wiki LLM summaries).

**Runtime:** Python 3.10+ (`pyproject.toml:11`).

# Veredito do README

- **Promessa central é defensável e bem documentada.** A redução 38×–528× é específica, com tabela por-repo, metodologia explícita (`docs/REPRODUCING.md`) e SHAs pinados — não é vaporware de slide.
- **Calibração com tiktoken (±1%) é um diferencial honesto** raro em projetos do gênero; mostra maturidade técnica e desarma a crítica óbvia ("seu 'token' é estimado, não real").
- **Os autores admitem ativamente onde o produto perde** (commits pequenos, MRR 0,35, flow detection 33% recall, precision média 0,58). Isso aumenta credibilidade — não esconde o trade-off conservador (recall>precision).
- **Ausência de comparação contra concorrentes diretos (Serena, ast-grep MCP, LSP-based tools) é a maior fraqueza retórica do README.** O leitor só consegue comparar com o baseline "agente burro lendo tudo", o que infla os ganhos percebidos vs. um workflow Grep/LSP bem feito.
- **Maturidade real coerente com "Beta avançado":** CI multi-versão, 30 ferramentas MCP, daemon, 13 plataformas suportadas, releases mensais, segurança patcheada. Risco principal é bus-factor (single maintainer) e dependência forte do ecossistema fastmcp/tree-sitter.
