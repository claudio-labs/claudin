# 01 — BM25/tool-discovery: ideias laterais

Escopo: achados em `oh-my-pi` ainda não cobertos pela trilha `01-bm25-tool-gating` (insight/deep/fit). Foco em mecanismos auxiliares ao redor do BM25, não no scorer em si.

## 1. Ideias laterais

### 1.1 `summary` curado separado de `description`
- `oh-my-pi/packages/coding-agent/src/tools/search.ts:219`, `find.ts:118`, `gh.ts:2344`, `ssh.ts:123`, `write.ts:194`, `hindsight-*.ts:20-26`, `ast-grep.ts:124`, `ast-edit.ts:166`, `render-mermaid.ts:38`, `ask.ts:382`, `todo-write.ts:497`: cada tool declara `readonly summary = "..."` (1 frase, ≤80 chars).
- Corpus BM25 usa `summary` direto (peso 2) e só cai para `description.slice(0,200)` se ausente (`tool-discovery/tool-index.ts:176-183`). Resultado: ranking não é poluído por boilerplate de prompt, e o autor da tool controla o sinal de busca.

### 1.2 Tokenizer NFKD + ACRONYM/camelCase boundaries
- `tool-discovery/tool-index.ts:115-134`: `normalize("NFKD")` + strip `\p{M}` (combining marks), split em `(Lu+)(LuLl)` e `(Ll|N)(Lu)`, separador = `[^\p{L}\p{N}]+`.
- Implicações práticas pouco óbvias: "café" → "cafe", "MCPTool" → "mcp tool", "v2Beta" → "v2 beta", emojis viram separadores. Funciona p/ queries em português sem acento ("buscar arquivo" → match em tools com summaries em inglês? não — mas usuários BR digitando "github" vs "gìthúb" colidem corretamente).

### 1.3 `discoveryMode: "off" | "mcp-only" | "all"` com back-compat alias
- `session/agent-session.ts:3048-3054`: setting `tools.discoveryMode` (novo) wins; legacy `mcp.discoveryMode: boolean` é tratado como alias de `"mcp-only"`. Permite ligar gating só para MCP (geralmente o problema maior) sem mexer no pool de built-ins.

### 1.4 Persistência da seleção de tools no log da sessão
- `session/session-manager.ts:162` (`MCPToolSelectionEntry`), `:2822-2832` (`appendMCPToolSelection`): cada ativação vira uma entry append-only no session log. Resume detecta isso (`hasPersistedMCPToolSelection`, `:250,615`) e reidrata o set ativo.
- `session/agent-session.ts:1072-1076`: `persistInitialMCPToolSelection ?? branchLength === 0` — só persiste set inicial em sessões fresh, não em branches/resume.

### 1.5 Seeds por MCP server
- `session/agent-session.ts:307-310`, `2900-2908`: `defaultSelectedMCPServerNames: string[]` — sempre que **qualquer** tool de um server conectado vira discoverable, todas são auto-seleted. Mecanismo de "bundle" implícito por servidor (sem precisar listar tools individualmente).

### 1.6 Cache de busca com invalidação por evento concreto
- `session/agent-session.ts:869-872,2891-2893,3097-3108`: cache `#discoverableToolSearchIndex: DiscoverableToolSearchIndex | null` — construído lazy na 1ª busca, invalidado em **4 callsites específicos**: ativação (`:3146`), refresh de MCP tools (`:2885`), mudança de set ativo (`:3290`), registry mutation (`:3568`). Não tem TTL, não tem cache de queries — só cache do índice. Simplicidade vence.

### 1.7 `getDiscoverableTools` exclui tools já ativas
- `session/agent-session.ts:3064-3078`: filtragem por `!activeNames.has(t.name)` **antes** de indexar. BM25 nunca devolve uma tool já no pool — implícito anti-noise. Claudin hoje pode rankar e devolver duplicatas.

### 1.8 `selected` ⊂ `active` invariant
- `session/agent-session.ts:3110-3119`: `getSelectedDiscoveredToolNames()` reinterseta `#selectedDiscoveredToolNames` com active toolset toda chamada. Se a tool foi desativada externamente, BM25 pode redescobri-la. Self-healing.

### 1.9 Ativação multi-tool em uma única call
- `search-tool-bm25.ts:230-289`: `query` única + `limit` (default 8) ativa **todas** as top-K tools de uma vez. Modelo não precisa de N round-trips para "abra worktree, rode bash, agende cron".

### 1.10 `loadMode: "essential"` é decisão estática local, não global
- Decoração na própria classe da tool (`tools/bash.ts:228`, `read.ts:679`, `edit/index.ts:278` etc.). Nada de lista central. Marcar uma tool como essential = mexer no arquivo dela. Reduz "ação à distância".

### 1.11 Fallback gracioso quando session não suporta discovery
- `search-tool-bm25.ts:138-160,220-228`: tool se auto-anula via `createIf` quando capabilities ausentes. Caller (registry) chama e ignora `null` — não dá pra LLM ver uma tool que vai jogar erro de "feature off".

### 1.12 Schema keys ordenados (cache-friendly)
- `tool-discovery/tool-index.ts:112`: `Object.keys(properties).sort()`. Garante que mudança trivial na ordem de keys do schema não muda o corpus indexado nem o hash (se hashed).

### 1.13 Descrição da search tool é dinâmica
- `search-tool-bm25.ts:212-214,169-176`: o `description` da tool é renderizado a cada chamada de `prompt.render(...)` injetando contagem corrente de servers MCP discoverable. Modelo vê "Discoverable MCP servers in this session: github (12 tools), slack (4 tools)" — sinaliza ao modelo *o que ele pode achar* sem custar schema das tools individuais.

## 2. Vale pra Claudin?

| # | Ideia | Vale? | Razão |
|---|---|---|---|
| 1.1 | `summary` field separado | **SIM** | Claudin tem `searchHint` mas ainda usa `prompt().slice(0,200)` no fallback BM25 proposto — adicionar `summary` curado e dropar dependência de prompt melhora ranking. Diff baixo. |
| 1.2 | Tokenizer NFKD/ACRONYM | **SIM** | Claudin TUI/REPL é pt-BR (`communication-language.md`). Usuário pode digitar "github" mas tools/MCP têm nomes camelCase/snake. Worth porting verbatim. |
| 1.3 | `discoveryMode: mcp-only \| all` | **CONDICIONAL** | Útil quando MCP cresce. Hoje pouco MCP no Claudin (per `fit/01`). Adicionar só se MCP entrar no roadmap. |
| 1.4 | Persistência no session log | **SIM** | Claudin tem session resume; hoje set ativo de tools não persiste cross-resume. Em provedores OpenAI-compat com gating ativo (PR2 do MVP), usuário que faz resume perde as ativações e paga round-trips de novo. Win UX. |
| 1.5 | Seeds por server | **CONDICIONAL** | Idem 1.3 — depende de MCP. |
| 1.6 | Cache do índice (não de queries) | **SIM** | Confirma decisão arquitetural do MVP. Documenta que cache de *queries* (que o user pediu para explorar) é **deliberadamente** não feito em omp — corpus 30 tools, búsca <1ms, cache de query overkill. |
| 1.7 | Excluir ativas do corpus | **SIM** | Trivial; evita confusão no ranking. Aplica em `searchToolsWithKeywords` (`ToolSearchTool.ts:186-302`). |
| 1.8 | `selected ⊂ active` invariant | **SIM** | Self-healing barato. Vira teste de invariant em PR2. |
| 1.9 | Multi-tool em 1 call | **JÁ EXISTE** | `ToolSearchTool` já aceita seleção múltipla (`prompt.ts:55-109`). Nota: omp usa `query+limit` (auto), Claudin usa `select:` explícito. Considerar híbrido: query devolve top-K e ativa todos (omp-style) — reduz acoplamento entre prompt do ToolSearchTool e capacidade do modelo de seguir DSL `select:`. |
| 1.10 | `loadMode` local | **SIM** | Claudin usa `shouldDefer`/`alwaysLoad` no `buildTool` — mesmo padrão. Confirma; sem ação. |
| 1.11 | `createIf` capability gate | **SIM** | Padrão útil quando BM25 gating é flag-gated. Hoje Claudin aborta no `call`; gate no buildTool é mais limpo. |
| 1.12 | Schema keys sorted | **SIM** | Custo zero; estabiliza hash do corpus para futuro cache cross-session. |
| 1.13 | Description dinâmica da search tool | **SIM** | Hoje `ToolSearchTool` tem prompt estático. Injetar contagem live ("12 deferred: 3 worktree, 4 cron, 5 mcp") ajuda modelos pequenos a saber *que* buscar. |

Não vale: nada explicitamente. **Não encontrado em omp** (responde perguntas do brief): cache de query results, telemetria de uso pós-busca (qual tool é chamada depois), aliases/synonyms, hooks de extensibilidade no discovery, tool versioning/deprecation no índice, heurística "modelo está perdido" (existe via `report_tool_issue` mas é canal manual do modelo — já coberto em `04-report-tool-issue.md`). Omp **não tem** nenhum desses; é deliberado.

## 3. Encaixe potencial

| Ideia | Onde no Claudin |
|---|---|
| 1.1 `summary` | `src/tools/Tool.ts:405` — adicionar `summary?: string` ao lado de `searchHint`. Corpus BM25 (módulo novo `src/utils/bm25ToolIndex.ts` per deep §"Escopo MVP") usa `summary` peso 2, fallback `searchHint`, fallback `prompt().slice(0,200)`. |
| 1.2 Tokenizer NFKD | `src/utils/bm25ToolIndex.ts` — port direto de `tool-index.ts:115-134`. Compartilhar com `ToolSearchTool.ts:132-185` se o scorer linear continuar como fallback. |
| 1.3 `discoveryMode` | `src/platform/config/config.ts` (`getGlobalConfig`) + zod schema. Setting `toolGating.mode: "off"\|"mcp-only"\|"all"`. Lido em `assembleToolPool` (`src/tools/tools.ts:365-387`). |
| 1.4 Persistência | `src/utils/messagesStorage.ts` (resume path) + novo entry type `tool_selection`. `assembleToolPool` consulta last selection on resume. |
| 1.5 Seeds por server | `src/mcp/fetchCapabilities.ts:152` (onde MCP tools são montadas) + setting `toolGating.seedMcpServers: string[]`. |
| 1.6 Cache do índice (não de queries) | Confirma deep §MVP PR1 — `bm25ToolIndex.ts` com `let cached: Index \| null`; invalidação em hot path do MCP refresh (`fetchCapabilities.ts`) e em mutações de active pool (raro). |
| 1.7 Excluir ativas | `src/tools/ToolSearchTool/ToolSearchTool.ts:186-302` — filtrar `tools.filter(t => !activeSet.has(t.name))` antes do scoring. |
| 1.8 Invariant | Teste em `src/tools/ToolSearchTool/ToolSearchTool.test.ts`: garantir que após desativação externa, próxima `search` redescobre. |
| 1.9 Híbrido query+activate | `src/tools/ToolSearchTool/prompt.ts:55-109` — opção `autoActivateTopK: number` no schema; modo backward-compat ainda aceita `select:`. |
| 1.11 `createIf` | `src/tools/Tool.ts` — adicionar `static createIf?(ctx): Tool \| null` no contrato. `assembleToolPool` chama e filtra null. |
| 1.12 Schema keys sorted | `src/utils/bm25ToolIndex.ts::getSchemaPropertyKeys` — copiar `tool-index.ts:108-113` literalmente. |
| 1.13 Description dinâmica | `src/tools/ToolSearchTool/prompt.ts` — render contagem live de deferred por categoria (worktree/cron/web/mcp) na descrição. Acessar `assembleToolPool({ countOnly: true })` ou similar. |
