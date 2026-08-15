# Onde há ganho real para o Claudin (dado que já temos LSP)

**Síntese cruzada de `04-crg-capabilities-vs-lsp.md` + `05-claudin-baseline-gaps.md`.**

Pergunta-guia: o Claudin já tem LSP completo (13 ops, 12 servers embarcados), Grep `output_mode="symbols"`, Read `view='outline'`, Explore agent. Onde, concretamente, o CRG agregaria algo?

---

## Conclusão direta

Dos **18 itens** comparados:
- **5 itens** Claudin já cobre bem (LSP + Grep symbols + outline)
- **4 itens** são cosméticos ou de baixa demanda no perfil Claudin
- **9 itens** são gaps reais — mas **só 3** justificam trabalho:

| Gap | Frequência | Severidade hoje | Cabe nativo TS? |
|---|---|---|---|
| **Diff-aware risk score em `/review`** | Alta | Média (qualidade do review) | Sim, 1-2 sem |
| **Wiki auto-gerada (onboarding)** | Média | Alta (template hoje é vazio) | Sim, 1 sem |
| **Índice persistente cross-sessão** | Alta | Média (re-grep toda sessão) | Sim, 1-2 sem |

Os 6 restantes (community clustering, hub/bridge centrality, surprising connections, suggested questions, cross-repo, transitive impact BFS automático) ou são overkill para repo <50k LOC ou são entregáveis via LSP `incomingCalls` recursivo sem precisar de grafo persistente.

---

## O que NÃO é gap (Claudin já resolve)

| Capacidade | Como o Claudin faz |
|---|---|
| goToDefinition / findReferences / hover / rename | `LSPTool` 13 ops (`src/tools/LSPTool/schemas.ts:269-283`) |
| Workspace symbol search | `LSPTool.workspaceSymbol` + `GrepTool` symbols mode |
| Call hierarchy 1-hop | `LSPTool.incomingCalls` / `outgoingCalls` (`schemas.ts:146,165`) |
| Outline de arquivo | `Read view='outline'` (`FileReadTool.ts:1263`) |
| Listar símbolos por padrão | `Grep output_mode="symbols"` em TS/JS/Py/Go (`GrepTool.ts:408-419`, `scanSymbols.ts`) |
| Refactor seguro | `LSPTool.rename` + `applyCodeAction` + `renameFile` |

**Insight:** dos "29 tools do CRG", ~10 são equivalentes funcionais de LSP. Claudin já tem.

---

## Os 3 gaps que importam

### Gap 1 — `/review` é primitivo: passa diff cru pra LLM

**Hoje** (`src/commands/review.ts:9-31`): `gh pr diff` → LLM. Sem ordenação, sem ranking, sem identificação de hub files. LLM dá review do mesmo tamanho pra patch trivial e pra refactor crítico.

**O que o CRG faz que falta:** `detect_changes` retorna `risk_score` por arquivo (cap participação em flows 0.25 + cross-community 0.15 + test gap 0.30 + security keywords 0.20 + caller count 0.10 — `changes.py:229`).

**Caminho nativo TS (sem CRG):** wrapper que para cada símbolo modificado no diff chama `LSPTool.findReferences`, conta resultados, gera tabela `arquivo → callers → testes cobrindo` e injeta no prompt do `/review`. Entrega 70% do valor com zero dependência nativa, zero bundle inflado, zero SQLite. **Esforço: 1-2 semanas.**

**Quando cresceria o ganho:** PR > 10 arquivos em monorepo. Para PR de 3 arquivos, ler os arquivos continua mais barato (confirma os CSVs do próprio CRG).

### Gap 2 — Wiki é template vazio

**Hoje** (`src/services/wiki/init.ts:6-37`, `src/commands/wiki/wiki.tsx`): `/wiki` gera placeholder; usuário preenche manual. `claude-code-guide` agent fala do produto Claudin, não do repo do usuário.

**O que o CRG faz que falta:** `generate_wiki_tool` (`main.py:693`) percorre communities Leiden e gera markdown por subsistema com membros + relações.

**Caminho nativo TS:** Read `view='outline'` + import graph simples + LLM summarizer percorrendo por diretório/módulo. Funciona em TS/JS/Py/Go. Não precisa de Leiden — agrupamento por diretório resolve para 80% dos repos. **Esforço: 1 semana.**

**Só grafo daria:** communities que não emergem do file tree (ex: módulos relacionados por imports cruzados mas em diretórios diferentes).

### Gap 3 — Índice persistente cross-sessão

**Hoje:** Claudin não tem DB de código. Cada sessão re-grepa. `~/.claudin/v8cache/` é só bytecode. `.claudin/wiki/` é manual.

**O que o CRG faz que falta:** SQLite por repo (`.code-review-graph/graph.db`), atualizado incremental via hash SHA-256, hookado em `PostToolUse(Edit|Write|Bash)` (`hooks/hooks.json:25-32`), recarregado em `SessionStart`.

**Caminho nativo TS:** reusar `src/tools/shared/codeOutline/scanSymbols.ts` (já é tree-sitter-free, regex puro, cobre TS/JS/Py/Go) — persistir output em SQLite leve em `.claudin/` + import edges. Hooks em `PostToolUse` para invalidar por arquivo. **Esforço: 1-2 semanas.**

**Atenção a memória existente:** `verify-privacy-bundle-only` — escritas em `~/.claudin/` ficam fora do gate de privacidade atual. Tratar como problema separado se mexer aqui.

**Só grafo persistente daria** (e Claudin NÃO daria com wrapper simples): se o índice virar grafo de chamadas com queries de community/centralidade. Mas isso é overkill para perfil dominante.

---

## Os itens que NÃO valem a pena

| Item | Por que pular |
|---|---|
| Community clustering (Leiden) | Diretório/módulo entrega 80% sem `python-igraph` nativo |
| Hub/Bridge centrality | Caso de uso raro fora de arquitetura review |
| Surprising connections | Cosmético; user nunca pede |
| Suggested questions | Cosmético |
| Cross-repo search | Claudin é per-cwd por design |
| Transitive impact BFS automático | Wrapper sobre `LSPTool.incomingCalls` recursivo até depth=3 resolve, sem precisar do grafo persistente |
| Embeddings (semantic search) | Bundle de sentence-transformers ~5GB; opt-in caro; embeddings opt-in via provider (Gemini) é melhor caminho se um dia for relevante |
| Wiki LLM summarization | Já temos Skills e Plan agent; reusar |

---

## Recomendação final

**Não trazer CRG. Não portar.** As 3 dores reais resolvem-se com 3-5 semanas de trabalho TS nativo reusando o que já existe (LSP + scanSymbols), sem inflar bundle, sem expor superfície fora do `verify:privacy`, sem acoplar a schema externo em cadência semanal.

**Prioridade sugerida** (se for fazer):

1. **Gap 1 (risk score em `/review`)** — maior ROI por semana investida. Reusa LSP que já temos. Não introduz storage novo.
2. **Gap 2 (wiki auto)** — segundo lugar. Reusa Read outline. Sem storage novo se gerar on-demand.
3. **Gap 3 (índice persistente)** — terceiro. Único que introduz storage; só fazer se 1 e 2 mostrarem valor real e usuários pedirem.

**Manter a porta aberta:** doc-only `docs/recipes/code-review-graph-mcp.md` para usuários power que queiram plugar CRG via MCP externo (caminho (a) do `03-fit-no-claudin.md`). Custo: ~30min de doc, zero código.

---

## O que essa rodada mudou vs. discovery anterior

`00-insights.md` já dizia "não trazer código". Esta rodada adiciona:

1. **Mapeamento explícito dos 18 itens × Claudin atual** — antes era "Claudin tem Explore"; agora é "Claudin tem 13 ops LSP + scanSymbols regex + outline + agentes built-in com arquivo:linha exato".
2. **Reclassificação dos 18 em 5/4/9** — a maioria dos diferenciais do CRG já está coberta ou é cosmética.
3. **3 gaps acionáveis, todos viáveis em TS nativo em <2 semanas cada.** A integração MCP externa continua sendo o caminho default; trabalho nativo só nos 3 gaps.
