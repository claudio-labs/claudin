# 05 — Claudin baseline e gaps reais vs. code-review-graph

**Data:** 2026-05-27
**Repo Claudin:** `main @ c541013`
**Escopo:** mapear o que o Claudin já oferece para navegação/review e cruzar com cada capacidade do CRG (`/home/dev/projects/code-review-graph` v2.3.5) para isolar gaps reais.

---

## 1. Inventário das capacidades atuais do Claudin

### 1.1 LSP — operações disponíveis

Claudin expõe um `LSPTool` único com 13 operações via discriminated union (`src/tools/LSPTool/schemas.ts:269-283`, type guard em `:296-311`):

| Operação | R/W | Schema | Linha |
|---|---|---|---|
| `goToDefinition` | R | file+line+char | `schemas.ts:13` |
| `findReferences` | R | file+line+char | `schemas.ts:32` |
| `hover` | R | file+line+char | `schemas.ts:51` |
| `documentSymbol` | R | file+line+char | `schemas.ts:70` |
| `workspaceSymbol` | R | file+line+char | `schemas.ts:89` |
| `goToImplementation` | R | file+line+char | `schemas.ts:108` |
| `prepareCallHierarchy` | R | file+line+char | `schemas.ts:127` |
| `incomingCalls` | R | file+line+char | `schemas.ts:146` |
| `outgoingCalls` | R | file+line+char | `schemas.ts:165` |
| `rename` | W | file+line+char+newName | `schemas.ts:187` |
| `codeActions` | R | file+range[+only] | `schemas.ts:211` |
| `applyCodeAction` | W | file+actionId | `schemas.ts:249` |
| `renameFile` | W | filePath+newPath | `schemas.ts:263` |

`LSP_WRITE_OPERATIONS = {rename, applyCodeAction, renameFile}` em `schemas.ts:318-322`.

**Servidores embarcados** (`src/services/lsp/builtinServers.ts:461-609`, registro `SERVER_DEFINITIONS`):

| Servidor | Bin | Linguagens |
|---|---|---|
| `typescript-language-server` | npm | .ts/.tsx/.js/.jsx/.mjs/.cjs |
| `rust-analyzer` | GH release | .rs |
| `pyright` (`pyright-langserver`) | npm | .py/.pyi |
| `gopls` | go install | .go |
| `biome` | npm | .ts/.tsx/.js/.jsx/.json/.jsonc |
| `yaml-language-server` | npm | .yml/.yaml |
| `taplo` | GH release | .toml |
| `dart` | SDK | .dart |
| `omnisharp` | GH release | .cs/.csx |
| `jdtls` | GH release (java) | .java |
| `kotlin-language-server` | GH release (java) | .kt/.kts |
| `clangd` | GH release | .c/.cc/.cpp/.cxx/.h/.hpp/.hxx |

Detecção via `which` (`builtinServers.ts:26-30`, `:818-849`), auto-install opcional. Gate global em `src/services/lsp/userSettings.ts` (`isLspGloballyEnabled`). Diagnostics passivos via `LSPDiagnosticRegistry.ts` + `passiveFeedback.ts`.

### 1.2 Grep / Glob / Read

**`GrepTool`** (`src/tools/GrepTool/GrepTool.ts`):

- Wrapper ripgrep, 4 modos: `content | files_with_matches | count | symbols` (`GrepTool.ts:61` e `:260`).
- Modo **`symbols`** mapeia cada match para o símbolo enclosing (função/classe). Implementação em `GrepTool.ts:157` (`enclosingSymbol`), detecção de linguagem em `:214`, fluxo final em `:408-419` e `:623-637`.
- Linguagens suportadas pelo modo `symbols` e por `view='outline'`: **TypeScript, JavaScript, Python, Go** apenas (`src/tools/shared/codeOutline/scanSymbols.ts:55-70`, `EXT_TO_LANG`). Implementação regex pura, módulo-level (`scanSymbols.ts:81-98`).
- Suporte a `multiline`, `glob`/`type`, `-A/-B/-C/-n`, `head_limit/offset`.

**`FileReadTool`** (`src/tools/FileReadTool/FileReadTool.ts`):

- `view: 'outline'` retorna esqueleto estrutural com line ranges (`FileReadTool.ts:945-971`, fluxo em `:1263`). Mesmo `detectOutlineLang` (TS/JS/Py/Go).
- `symbol: '<name>'` expande UM símbolo com line-numbers reais (`:259-264`, fluxo em `:1241`).
- Auto-outline quando arquivo passa do cap de bytes/tokens (`:1290-1300`).
- Suporta PDF (`pages:`), imagem e notebook.

**`GlobTool`** (`src/tools/GlobTool/`): pattern matching tradicional, ordenado por mtime.

### 1.3 Agentes especializados

Pasta `src/tools/AgentTool/built-in/`:

| Agente | Arquivo | Modelo | Função |
|---|---|---|---|
| `Explore` | `exploreAgent.ts` | haiku | Read-only — Grep/Glob/Read/Bash-ro (`exploreAgent.ts:13-83`). Min queries = 3 (`:59`). |
| `Plan` | `planAgent.ts` | (default) | Read-only — explora + design (`planAgent.ts:14+`). |
| `general-purpose` | `generalPurposeAgent.ts` | (default) | Fallback. |
| `web-researcher` | `webResearcherAgent.ts` | (default) | Fetch + research. |
| `claude-code-guide` | `claudeCodeGuideAgent.ts` | (default) | Onboarding sobre o produto. |

Explore tem `omitClaudeMd: true` + `omitGitStatus: true` para reduzir prompt (`exploreAgent.ts:80-81`).

### 1.4 Comandos de review

**`/review`** (`src/commands/review.ts:9-43`): prompt que roda `gh pr list`/`view`/`diff`, manda LLM analisar com seções "code quality, suggestions, risks, test coverage, security". **Não faz análise estática do diff** — é LLM-on-diff, com Bash + Grep como ferramentas implícitas.

**`/security-review`** (`src/commands/security-review.ts:6-243`): slash command com markdown frontmatter; pré-executa `git status`, `git diff --name-only origin/HEAD...`, `git log`, `git diff` e injeta no prompt. Pede vulns alta-confiança (>80%), exclui DoS/secrets/rate-limits. Allowed-tools: `Bash(git ...:*), Read, Glob, Grep, LS, Task`. **Sem** scoring estruturado, **sem** impact radius, **sem** call graph.

**`/ultrareview`** (`src/commands/review.ts:48-54`): dispara fluxo remoto "bughunter" (Claude Code on the web).

Outros:

- `/diff` (`src/commands/diff/`), `/passes` (`src/commands/passes/`), `/wiki`, `/knowledge`, `/insights`, `/brief`.
- `/wiki init|status|ingest` (`src/commands/wiki/wiki.tsx`, serviço `src/services/wiki/`): cria `.claudin/wiki/` com `index.md`, `log.md`, `pages/`, `sources/`. **Knowledge base manual**, não derivada de grafo — template + ingestão de arquivos (`src/services/wiki/init.ts:6-37`).

### 1.5 Git / diff / risk

- Diff via Bash `git diff` (em `/review` e `/security-review`).
- **Não** calcula "arquivos afetados além do diff direto" (sem transitive impact).
- **Não** tem risk score.
- **Não** tem call-graph persistente; `LSPTool.incomingCalls/outgoingCalls` é a única expansão de chamada e exige uma operação por nó (1-hop por call, sem BFS).
- Sem semantic search / embeddings (grep `embedding` em `src/` só retorna modelos de provider).

---

## 2. Mapa de gaps vs. CRG

| Capacidade do CRG | Claudin tem? | Como (tool + arquivo:linha) | Gap real? |
|---|---|---|---|
| Roteador de contexto ~100 tokens (`get_minimal_context`) | Não | Grep+Glob+LSP exigem várias roundtrips | Sim (baixa severidade — Explore já faz em 2-3 calls) |
| Diff-aware risk score (`detect_changes`) | Não | `/review` e `/security-review` passam diff cru pra LLM | **Sim** |
| Transitive impact radius BFS (`get_impact_radius`) | Parcial | `LSPTool.incomingCalls`+`outgoingCalls` 1-hop por call (`schemas.ts:146,165`) | **Sim** |
| Flow detection (entry-point → call chain) | Parcial | Call hierarchy via LSP, sem entry-point classifier | Sim |
| Community clustering (Leiden) | Não | — | Sim (baixa demanda) |
| Architecture overview (cross-community edges) | Parcial | `/wiki` manual + LLM (`src/services/wiki/init.ts`) | Sim (não automatizado) |
| Hub/Bridge nodes (centrality) | Não | — | Sim (baixa demanda) |
| Knowledge gaps (untested hotspots) | Não | — | **Sim** |
| Surprising connections | Não | — | Cosmético |
| Large functions finder | Parcial | `view='outline'` mostra ranges; Grep `symbols` mostra contagem (`scanSymbols.ts:73`) — sem ranking | Sim (parcial) |
| Semantic search (FTS5 + embeddings) | Não | Grep é literal/regex | **Sim** |
| Cross-repo search | Não | Grep limitado a cwd | Sim (baixa demanda) |
| Suggested questions | Não | — | Cosmético |
| Codebase wiki | Parcial | `/wiki` template manual (`src/commands/wiki/wiki.tsx:1-60`) | **Sim** (geração automática) |
| Dead code detection via grafo | Parcial | LSP `findReferences` 1-por-1 (manual) | **Sim** (não bulk) |
| Persistent graph across sessions | Não | Sem DB de código; `~/.claudin/v8cache/` é só bytecode | **Sim** |
| Pre-merge prompt | Parcial | `/review`, `/security-review` (LLM-on-diff, sem grafo) | Sim, mas funcional |
| Onboarding prompt | Parcial | `claude-code-guide` agent + `/wiki` | Sim, mas funcional |

Dos **18** itens: **9** são gaps reais notáveis — transitive impact, risk score, semantic search, untested hotspots, wiki auto-gerada, dead-code bulk, large-functions ranking, persistent graph, flow detection ponta-a-ponta.

---

## 3. Gaps que importam para o trabalho do Claudin

Avaliação por frequência (quão comum), severidade (quanto custa hoje em tool calls), e tamanho-alvo do repo onde o gap aparece.

### 3.1 Transitive impact radius (BFS N hops)
- **Frequência:** alta — toda pergunta "se eu mudar X, o que quebra?"; toda revisão de PR; todo refactor.
- **Severidade hoje:** média — 5-20 LSP calls (`incomingCalls` por nível) ou 3-8 Grep symbols. Latência soma segundos.
- **Tamanho-alvo:** **> 50k LOC**. Abaixo, Grep é instantâneo e radius é pequeno.

### 3.2 Diff-aware risk score
- **Frequência:** média — toda execução de `/review`.
- **Severidade hoje:** baixa em tool calls, **média em qualidade** — LLM dá review do mesmo tamanho pra patch trivial e refactor crítico.
- **Tamanho-alvo:** qualquer (ajuda já em <10k LOC com PRs grandes).

### 3.3 Semantic search (embeddings)
- **Frequência:** média — pergunta por conceito quando o termo exato não está no código.
- **Severidade hoje:** alta em > 50k LOC — Grep com sinônimos vira 4-6 queries; em <50k, OR resolve.
- **Tamanho-alvo:** > 100k LOC vale; <50k é overkill (Claudin próprio cabe aqui).

### 3.4 Untested hotspots / knowledge gaps
- **Frequência:** baixa — auditoria de qualidade, não fluxo diário.
- **Severidade hoje:** alta — requer Grep + cobertura + análise manual; ninguém faz na prática.
- **Tamanho-alvo:** > 50k LOC.

### 3.5 Persistent graph entre sessões
- **Frequência:** alta — toda sessão nova começa cega.
- **Severidade hoje:** média — Claudin re-grepa, e LSP re-indexa (servidores cacheam internamente, mas Claudin não persiste resultados).
- **Tamanho-alvo:** qualquer; benefício percebido sobe com o tamanho.

### 3.6 Wiki auto-gerada
- **Frequência:** baixa (`/wiki ingest` é manual).
- **Severidade hoje:** média — gerar `architecture.md` manualmente é trabalhoso.
- **Tamanho-alvo:** > 100k LOC ou monorepo.

### 3.7 Dead code em bulk
- **Frequência:** baixa — housekeeping ocasional.
- **Severidade hoje:** alta — `findReferences` 1-por-1 inviável em milhares de símbolos.
- **Tamanho-alvo:** > 50k LOC.

**Síntese:** os gaps que aparecem em **<50k LOC** (categoria do próprio Claudin: ~25k LOC `.ts`/`.tsx` excluindo testes) e são frequentes são: **risk score** e **persistência leve**. O resto só retorna em codebases maiores.

---

## 4. Onde o ganho REAL poderia estar

### 4.1 `/review` em PR de 30 arquivos num monorepo
- **Hoje:** `gh pr diff` despeja na LLM (`src/commands/review.ts:9-31`). LLM lê linearmente; sem saber qual arquivo é hub (50 importadores) vs folha (1 importador).
- **Falta:** ordenação de severidade por impacto transitivo + identificação de hub files.
- **Nativo TS sem CRG:** **médio (1-2 semanas)**. BFS de imports via `tsc` API ou `ts-morph` para TS/JS; cache em `.claudin/` por commit hash. Não cobre Python/Go/Rust.
- **Só grafo persistente daria:** multi-linguagem real + cache cross-session.

### 4.2 Refactor com blast radius
- **Hoje:** `LSPTool.rename` já faz; impact via diagnostics passivos.
- **Falta:** "antes de renomear, mostre blast radius em 3 níveis".
- **Nativo TS:** **baixo (dias)** — wrapper chamando `incomingCalls` recursivo até depth=3, com merge/dedup. Não precisa de CRG.
- **Só grafo daria:** ranking de qual call-site é mais sensível (centralidade) + cobertura de teste por caller.

### 4.3 Bug hunt em codebase desconhecido
- **Hoje:** Explore + LLM (`src/commands/bughunter/`).
- **Falta:** "comece pelos arquivos mais centrais que tocam parsing/validação". Sem centralidade, navegação aleatória.
- **Nativo TS:** alto — exige construir grafo. MCP externo (CRG) é mais barato.
- **Só grafo daria:** mesma resposta.

### 4.4 Onboarding: "explica essa codebase"
- **Hoje:** `/wiki` é template vazio (`src/services/wiki/init.ts:6-37`). `claude-code-guide` fala do produto Claudin, não do repo do usuário.
- **Falta:** geração automática de "principais módulos + relações" partindo do grafo.
- **Nativo TS:** **médio (1 semana)** — Read `view='outline'` + import graph simples + LLM summarizer. Funciona em TS/JS/Py/Go.
- **Só grafo daria:** communities (Leiden) destacando subsistemas que não emergem só do file tree.

### 4.5 Sessão longa de dev — perguntas repetidas
- **Hoje:** cada sessão re-grepa. Sem memória de "o que já indexamos". `.claudin/wiki/` é o único storage durável (manual).
- **Falta:** índice persistente leve (mapa symbol→file:line + import graph) recarregado em SessionStart.
- **Nativo TS:** **médio (1-2 semanas)**. Padrão dos hooks do CRG (`SessionStart` → status, `PostToolUse` em `Edit|Write|Bash` → update — ver `docs/archive/discovery/code-review-graph/03-fit-no-claudin.md:46-48`). Reusar `scanSymbols` que já existe (`src/tools/shared/codeOutline/`).
- **Só grafo daria:** se o índice virar grafo de chamadas + queries de community/centralidade, aí sim só CRG-like resolve.

---

## 5. Veredito honesto

**O CRG resolve dor real em uma fatia específica do uso do Claudin, mas para o caso dominante (CLI dev em repos <50k LOC, sessões curtas, edição de TS/Python) é overkill.**

Evidências:

1. **Claudin já tem LSP completo com 13 ops** (`src/tools/LSPTool/schemas.ts:269-283`) incluindo `findReferences`, `incomingCalls`, `outgoingCalls`. Pra 80% das perguntas "quem chama X?", a resposta nativa é cirúrgica. O gap real é UX/orquestração (BFS automático, ranking), não capacidade bruta.

2. **Grep symbols + Read outline cobrem o resto** (`src/tools/GrepTool/GrepTool.ts:408-419`, `src/tools/FileReadTool/FileReadTool.ts:1263`) em TS/JS/Python/Go — as 4 linguagens da maioria dos usuários-alvo. CRG cobre mais (14+) mas isso é vantagem só pra C#/Java/Kotlin/Rust/Scala — público minoritário no perfil Claudin CLI.

3. **`/review` é primitivo** (`src/commands/review.ts:9-31`) — só passa diff pra LLM. Aqui o CRG (ou clone nativo simples) daria ganho real e mensurável, mas o ganho está em **agregar score/ranking**, não em ter grafo. Wrapper que (a) chama LSP `findReferences` em cada símbolo modificado, (b) conta resultados, (c) injeta tabela "arquivos afetados por símbolo" no prompt — entrega 70% do valor sem nada de SQLite/tree-sitter.

4. **Persistência é o único item que pede arquitetura nova.** O resto pode ser construído incrementalmente em cima do existente (`scanSymbols` é tree-sitter-free, regex puro, cobre 4 linguagens-alvo). Persistir o output do `scanSymbols` + import edges em SQLite leve no `.claudin/` daria ~60% do benefício do CRG sem o custo de bundle. Lembrar memória `verify-privacy-bundle-only`: escritas em `~/.claudin/` ficam fora do gate atual — é custo adicional a considerar.

5. **A discovery anterior (`03-fit-no-claudin.md:147-153`) já concluiu "interessante, não trazer agora"** porque os benchmarks do CRG não se sustentam contra Grep+LSP em repos pequenos. Este baseline confirma: a sobreposição é maior do que parecia (especialmente LSP, que `01`/`02` não enfatizaram), e o delta líquido fica nos itens 4.1 (review score), 4.4 (wiki auto) e 4.5 (índice persistente entre sessões).

**Recomendação derivada dos gaps:** se algo for trazido, é **um wrapper de impact/risk para `/review`** (cenário 4.1) usando o LSP que já existe — não a infra completa do CRG. Esforço estimado: 1-2 semanas, zero dependências nativas, não infla bundle. Tudo o resto fica em integração MCP opcional para usuários power, alinhado com a conclusão anterior.
