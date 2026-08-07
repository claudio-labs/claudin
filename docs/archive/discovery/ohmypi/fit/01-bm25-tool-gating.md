# 01 — BM25 tool gating: análise de encaixe e ganhos reais

Escopo: avaliar se portar o índice BM25 do `oh-my-pi` (`packages/coding-agent/src/tool-discovery/tool-index.ts`) para o Claudin entrega ganho real além do que `ToolSearchTool` já oferece, e em que provedores faz sentido ligar. Sem plano de implementação.

## 1. Encaixe arquitetural real

### 1.1 Pontos de inserção naturais

Toda a topologia "deferred tools + search tool" já existe no Claudin. Um BM25 substituiria/aumentaria o scorer linear atual, sem rearquitetura. Pontos concretos:

- `/home/dev/projects/claudin/src/Tool.ts:405` (`searchHint`), `:466-476` (`shouldDefer`, `alwaysLoad`). Já é o contrato. BM25 consumiria os mesmos campos como corpus (nome + searchHint + primeiros 200 chars de `prompt()`/`description()`), pesados como em `tool-index.ts:93-100` (FIELD_WEIGHTS).
- `/home/dev/projects/claudin/src/tools/ToolSearchTool/ToolSearchTool.ts:186-302` (`searchToolsWithKeywords`). Atual: soma linear `parts.includes(term) ×10/12`, `searchHint match +4`, `desc match +2`, com word-boundary regex pré-compilados. Sub seria substituído por `searchDiscoverableTools` (`tool-index.ts:262-297`), mantendo o mesmo callsite no `:328-471` (`ToolSearchTool.call`). Sem mudança de schema, sem mudança de retorno.
- `/home/dev/projects/claudin/src/tools/ToolSearchTool/prompt.ts:63-109` (`isDeferredTool`). Continua sendo a fonte da partição `alwaysLoad` vs `deferred`. BM25 nunca decide esconder Bash — categorização permanece estática no source, igual ao omp (`loadMode: "essential"` para Bash/Read/Edit).
- `/home/dev/projects/claudin/src/tools.ts:365-387` (`assembleToolPool`). Não muda no MVP "drop-in BM25 scorer". Só mudaria se houvesse um modo "gating real em provedores OpenAI-compat", aí precisaria filtrar deferred ∉ (`alwaysLoad ∪ sessionActivatedTools`) **antes** de devolver a lista — porque hoje o gating real depende de `defer_loading: true` na request à Anthropic 1P, e shim OpenAI **não tem** equivalente (ver `/home/dev/projects/claudin/src/services/api/openaiShim.ts` — zero ocorrências de `defer_loading`/`tool_reference`; `/home/dev/projects/claudin/src/utils/api.ts:274-276` mostra que `defer_loading` é só Anthropic-shape).
- `/home/dev/projects/claudin/src/utils/toolSearch.ts:271-313` (`isToolSearchEnabledOptimistic`). Hoje desliga tool-search para non-firstParty quando `ENABLE_TOOL_SEARCH` não está setado. Sub‑rotina para "BM25-gating ativo em OpenAI-compat" precisaria de um modo novo (`BM25_TOOL_GATING` flag) que ignore esse gate.
- `/home/dev/projects/claudin/src/services/api/claude/streaming.ts:450-465` (montagem dos toolSchemas com `deferLoading: willDefer(tool)`). Esse callsite é exclusivo do Anthropic-1P path. Sem espelho no `openaiShim.ts`.

### 1.2 Atritos identificados

- **Prompt-cache Anthropic 1P** (`/home/dev/projects/claudin/src/tools.ts:374-385`): a ordenação separa built-ins de MCP para preservar o cache breakpoint do `claude_code_system_cache_policy`. Mudar o set de tools entre turnos invalida o cache. **Logo**: modo "rerank por turno" (BM25 escolhendo set diferente cada turno) é incompatível com 1P caching. Modo "ativação acumulativa estilo omp" (set só cresce) preserva o cache até a 1ª ativação — depois recompõe uma vez e estabiliza. omp já assume esse tier-change como normal.
- **AgentTool** (`/home/dev/projects/claudin/src/tools/AgentTool/AgentTool.tsx:527`, `resumeAgent.ts:166`): sub-agentes chamam `assembleToolPool` com permissão própria. Se BM25 ativa tools no nível do worker, o set persistido é por-sub-agente — Code/Explore herdariam o critério, mas cada worker começaria de novo com só `alwaysLoad`. Aceitável (omp tem o mesmo comportamento por sessão), mas adiciona round-trip extra em cada sub-agent. Trade-off real: cada Agent invocation paga 1 turno extra de "discovery" antes de Bash/Read/Edit ficarem implícitos. Para `BUILTIN_EXPLORE_PLAN_AGENTS` (flag ativa no `scripts/build.ts`) isso pode ser caro — Explore lê muita coisa.
- **Permission gates** (`canUseTool`, sandbox, plan mode): ortogonal. BM25 só ranqueia; permissões continuam decidindo se o `call` roda. Sem conflito.
- **Coordinator** (`src/coordinator/`): workers via `runAgent` usam `assembleToolPool`. Mesma análise do AgentTool. Sem conflito direto, mas o overhead se multiplica por worker.
- **MCP tools**: hoje todas as MCP são `isDeferredTool === true` (regra em `prompt.ts:69`). BM25 já indexa server name e tool name (omp `FIELD_WEIGHTS` dá ×4 para mcpToolName e ×2 para serverName). Encaixa naturalmente — `fetchCapabilities.ts:152` já popula `searchHint` em MCP tools.

## 2. Ganhos reais medidos hoje

### 2.1 Wire-size baseline (`bun test scripts/measure-tool-schemas.test.ts`)

Rodando agora (Claudin main, sem provedor ativo):

- **30 built-in tools** medidos (todos engines).
- Totais por engine: anthropic 18 384 tokens / 64 438 bytes; openai 18 082 / 63 378; codex 18 055 / 63 283.
- Top 10 anthropic (tokens): Agent 1357, Bash 1203, EnterPlanMode 1127, TodoWrite 1039, Grep 1023, TaskUpdate 1003, ExitPlanMode 958, AskUserQuestion 952, CronCreate 938, Read 922. Soma top-10: **10 402 tokens** (56,6 % do total).
- Cauda longa (tokens ≤ 600, 16 tools): ListMcp 179, ReadMcp 165, TaskStop 153, CronDelete 122, CronList 79, e mais 11 entre 276 e 533. Soma da cauda: ~5 100 tokens (~28 %).

### 2.2 Status quo do `ToolSearchTool`

`shouldDefer: true` está em **27 tools** (grep em `src/tools/`). Lista (com tokens medidos):

| deferred | tokens |
|---|---|
| EnterPlanMode | 1127 |
| TodoWrite | 1039 |
| TaskUpdate | 1003 |
| ExitPlanMode | 958 |
| AskUserQuestion | 952 |
| CronCreate | 938 |
| TaskCreate | 805 |
| SendMessage | 733 |
| ExitWorktree | 716 |
| WebSearch | 534 |
| WebFetch | 533 |
| EnterWorktree | 509 |
| NotebookEdit | 431 |
| TaskOutput | 341 |
| TaskList | 340 |
| TaskGet | 291 |
| ListMcp | 179 |
| ReadMcp | 165 |
| TaskStop | 153 |
| CronDelete | 122 |
| CronList | 79 |
| (+ LSPTool, ConfigTool, TeamCreate, TeamDelete, RemoteTrigger — feature-gated, 0 tokens na build atual) |  |

Soma dos deferred tokens visíveis: **~11 948 tokens** (~65 % do total de 18 384). Em Anthropic 1P **com tool-search ativo**, esses ~12k tokens **já saem do prompt inicial** (vão via `defer_loading: true`). Em OpenAI-compat (DeepSeek/Groq/Codex etc.) hoje **todos esses ~12k são enviados em todo turno** porque `isToolSearchEnabledOptimistic` retorna `false` e o shim não conhece `defer_loading`.

Conclusão: o "alvo do BM25" no Claudin **não é melhorar o scorer** (o linear já funciona bem; eval no PR descritivo "exp_xenhnnmn0smrx4" mostrou que searchHint A/B não moveu nada). O alvo é **estender o gating para provedores não-Anthropic**, e BM25 vira só o motor de ranking — qualquer scorer razoável serve, o ganho vem do **gate, não do ranqueador**.

### 2.3 Redução plausível por provedor

- **Anthropic 1P (com tool-search já on)**: redução já realizada (~12k/turno). BM25 ganha **~0 % adicional** sobre o scorer linear existente. Eventual upside: melhor recall em queries multi-termo (BM25+ com `delta=1.0` é mais robusto que sum-of-tf), mas o efeito em wire-size é nulo — as tools selecionadas viram tool_reference, não schemas.
- **OpenAI-compat (DeepSeek/Groq/OpenRouter/LM Studio/Codex)**: hoje envia 100 % do schema. Com gating BM25 estilo omp (acumulativo): no 1º turno só `alwaysLoad` (~6 436 tokens estimados = 18 384 − 11 948) + ToolSearchTool (~700 tok). **Redução estimada no 1º turno: ~33 %** (6 436 / 18 384 ≈ 35 % do baseline visível). Em sessões que nunca chamam tools deferred (caso comum: "rode `bun test`", "leia X e edite Y"), a economia persiste turno após turno. Sessões que ativam Worktree+Cron+WebSearch convergem para ~baseline depois de 2-3 round-trips.
- **Provedores com input caro** (Groq Llama-4 pay-as-you-go, OpenRouter free tier): o ganho de ~12k tokens × N turnos é significativo. Numa sessão sintética de 20 turnos onde 10 % chamam deferred: ~20 × 12k × 0.9 = **216k tokens economizados**. Em DeepSeek ($0.27/Mtok input) isso é ~$0.058/sessão. Trivial individualmente, mas ~$58/dia para 1000 sessões.

### 2.4 BM25 vs scorer atual (qualidade do ranking)

`ToolSearchTool.ts:259-301` faz soma linear com pesos discretos (10/12/5/6/4/3/2). BM25 acrescenta:

- Term-frequency saturation (`k1=1.2`, evita explodir score com repetição).
- IDF (tokens raros pesam mais — útil para distinguir "schedule" de "task").
- Length normalization (`b=0.75`, evita tools com descrição longa dominarem).

Em corpus de 30 tools com vocabulário pequeno e descrições curtas/curadas, o ganho de qualidade é **marginal**. omp usa BM25 num corpus maior (~50 tools + MCP) onde IDF importa mais. Para o set do Claudin hoje, scorer linear empata em testes manuais nas queries canônicas ("schedule cron", "open file", "run command", "edit notebook"). Conclusão: **BM25 como melhor scorer não vale o porte sozinho**.

## 3. Onde ganha de verdade

### 3.1 Cenário A — DeepSeek/Groq com 30 built-ins + 5 MCP tools

- Antes: 18.3k tokens schema/turno × 20 turnos = 366k tokens só de schema.
- Depois (gating acumulativo + BM25 ranker): turno 1 ~6.4k, turnos 2-20 ~7-10k (set cresce conforme tools são ativadas). Total estimado: ~150-170k tokens, **redução ~50-55 %** numa sessão típica de coding (file IO + bash dominante).
- Ganho real: **SIM**, mas vem do gate, não do BM25.

### 3.2 Cenário B — Anthropic 1P com `tool_reference` já ativo

- Wire-size já está reduzido (defer_loading via API). BM25 substitui scorer linear na hora de selecionar quais deferred mostrar; impacto em tokens enviados ao modelo = **zero**.
- Ganho possível: melhor recall em queries ambíguas ("cancel job" → BM25 sobe CronDelete + TaskStop juntos via IDF; scorer atual pega só por keyword overlap). Difícil quantificar sem eval — possivelmente reduz `tengu_tool_search_outcome` com `hasMatches=false`, mas é hipotético.
- Ganho real: **NÃO em tokens, talvez em UX**. Não justifica o porte por si só.

### 3.3 Cenário C — sub-agente (Code/Explore)

- AgentTool/resumeAgent montam pool com `assembleToolPool` próprio. Worker herda a configuração `BM25_TOOL_GATING` global mas começa com `alwaysLoad` apenas.
- Explore (busca/leitura intensiva): `alwaysLoad` precisa incluir Read, Grep, Glob, Bash, ToolSearchTool. Provavelmente já incluídos por não terem `shouldDefer: true`. Sem custo extra.
- Code (edição): Edit, Write, Read também ficam em `alwaysLoad`. NotebookEdit fica deferred (`shouldDefer: true`) — round-trip se necessário, raro.
- Ganho real: **SIM, herdado automaticamente**. Pequeno risco de regressão se sub-agentes em provedores OpenAI-compat passarem a precisar de 1 round-trip extra para tools que antes vinham implícitas.

## 4. Onde NÃO ganha ou perde

- **BM25 esconde tool necessária**: mitigado pela categorização estática. Bash/Read/Edit/Grep/Glob ficam em `alwaysLoad`. Mas: tools recém-adicionadas a `shouldDefer` sem `searchHint` curado podem ficar invisíveis (omp tem o mesmo problema). Risco médio se algum dev novo marcar `shouldDefer: true` sem hint.
- **Round-trip extra (latência)**: cada ativação custa 1 turno (LLM chama `tool_search` → recebe lista → chama tool real). Em Anthropic 1P, omp e Claude Code já consideram esse custo aceitável. Em DeepSeek/Groq via OpenRouter, a latência por turno é maior (300-800ms p50) — pior UX se o usuário pede algo que precisa de 3 deferred tools (Worktree + Bash + Cron) num único pedido. Mitigação: prompt do `ToolSearchTool` (`prompt.ts`) deveria estimular `select:A,B,C` multi-tool numa única chamada — já existe (`ToolSearchTool.ts:363-406`).
- **Invalidação de prompt cache (Anthropic 1P)**: se o modo BM25 for "rerank por turno" (escolher set diferente cada user-turn), invalida o cache de tools schema toda vez. **Catastrófico** num provedor onde cache hit rate é fonte primária de economia. Solução: rerank por turno fica **off por padrão**, gated em `toolGating.mode === "auto-rerank"`. Modo default é "ativação acumulativa" (igual omp).
- **Fluxos multi-step**: usuário diz "abra worktree, rode `git status`, depois agende um cron diário". 3 deferred tools (EnterWorktree, Bash, CronCreate). Sem `select:A,B,C` o modelo paga 3 round-trips. Com `select:` (single search call) pagaria 1. Risco: modelos pequenos (DeepSeek-V3 base, Groq Llama-3.1-8B) podem não usar `select:` consistentemente — eval observado no omp não cobre OpenAI-compat.
- **MCP tools dinâmicas**: hoje todas viram deferred. Se um MCP server expõe 50 tools (ex: GitHub MCP), BM25 ajuda muito mais que scorer linear (IDF separa "issue" de "pr" de "review"). Aqui sim BM25 vale o porte por si — mas só quando o ecossistema MCP esquentar no Claudin (hoje pouco usado).

## 5. Veredito ponderado

### Decisão por provedor

| Provedor | Status quo (tool-search) | Vale ligar BM25? | Por quê |
|---|---|---|---|
| Anthropic 1P (api.anthropic.com) | on (defer_loading) | **NÃO default**; opt-in para A/B | Wire-size já otimizada; BM25 só substitui scorer. Quebra cache se rerank-mode. |
| Anthropic 1P via proxy não-compatível | off (gate em `isToolSearchEnabledOptimistic`) | **CONDICIONAL** | Se proxy não suporta `tool_reference`, BM25 com gating "ativação acumulativa" estilo omp é o único caminho. |
| Bedrock/Vertex/Foundry | on (defer_loading suportado) | **NÃO default** | Mesmo que 1P. |
| OpenAI-compat (DeepSeek, Groq, OpenRouter, LM Studio, Together) | **off completamente** | **SIM** (flag default-on após validação) | Único provedor onde BM25-gating entrega redução real (~30-55 % schema/turno). |
| Codex OAuth (`codex` shim) | off | **SIM, mesma análise** | Schema enviado integral hoje. |
| Ollama / local | off | **SIM, com cautela** | Modelos pequenos podem falhar em `select:` multi-tool — eval específico necessário. |

### Marcadores de decisão

- Se **provedor ativo é OpenAI-compat e wire-size importa** (latência ou custo): vale o porte. ROI quebra em ~50 sessões/dia.
- Se **usuário só usa Anthropic 1P**: não vale; mantenha o scorer linear; investa o esforço em outro insight da pasta `ohmypi/`.
- Se **alvo é melhor ranking, não menos tokens**: aguarde corpus crescer (MCP, skills). BM25 num corpus de 30 tools não bate scorer linear de forma defensável.

### Esforço vs ganho

- Esforço: ~3 PRs descritos no deep-dive (`docs/archive/discovery/ohmypi/deep/01-bm25-tool-gating.md` §"Escopo MVP"). Linhas: ~400 (módulo + teste + wire-up) + ~150 em `assembleToolPool` para gate sem `defer_loading`. Risco médio (mexe em hot path do `QueryEngine`, mas atrás de flag).
- Ganho: ~30-55 % redução de schema tokens em provedores OpenAI-compat. ~$60/dia para 1000 sessões em DeepSeek. Latência neutra se gating é acumulativo.

### Frase final

**Vale a pena: CONDICIONAL — porque** o ganho real (~30-55 % de wire-size em provedores OpenAI-compat) vem do **gate de tools**, não do scorer BM25. Em Anthropic 1P o gating já existe via `defer_loading` e BM25 puro não move tokens; o porte se justifica apenas se o roadmap inclui ligar tool-gating em DeepSeek/Groq/Codex/Ollama, e nesse caso BM25 é só o motor de ranking conveniente (qualquer scorer razoável serviria — o porte do omp custa pouco porque o módulo é autocontido em ~250 linhas). Se o Claudin quer ser bom em provedores não-Anthropic, ligue; caso contrário, priorize outro insight.
