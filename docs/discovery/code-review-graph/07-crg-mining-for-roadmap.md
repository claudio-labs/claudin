# CRG mining — ideias acionáveis por eixo do roadmap "LSP-first agent"

**Data:** 2026-05-27
**Repo minerado:** `/home/viudes/projects/code-review-graph` v2.3.5
**Continua de:** `00-insights.md`, `02-arquitetura-e-mecanismo.md`, `06-onde-ganho-real.md`
**Propósito:** para cada um dos 5 eixos do roadmap, listar 3-6 extrações concretas com `file:line` do CRG, classificadas como **steal / adapt / avoid**.

Foco em padrão, heurística e pitfall — não em re-resumir o que o CRG faz.

---

## Eixo 1 — Disciplina de uso (prompt tuning Explore/Plan/main + tool descriptions)

- **Preâmbulo "token efficiency" reutilizável literal**. O CRG mantém um único bloco de regras (`_TOKEN_EFFICIENCY_PREAMBLE`) e injeta no início de todos os 5 prompts MCP. As 6 regras numeradas são curtas, imperativas e ranqueadas (sempre `get_minimal_context` primeiro, `detail_level="minimal"` por default, no máximo 3 tool calls por turno, query targetada > scan amplo). Ver `code_review_graph/prompts.py:17-31`. **Recomendação: steal o shape (bloco numerado de 5-6 regras, reutilizado entre Explore/Plan/main).** O Claudin hoje pulveriza guidance em vários system prompts; um único preâmbulo de "tool budget" injetável no Explore e Plan agents reduz drift e fica diffável.

- **Workflows escalonados por risco no system prompt**. `review_changes_prompt` (`prompts.py:45-71`) descreve um fluxo branch-by-risk: low → `detect_changes(minimal)` e termina; medium/high → escala para `standard` e abre `query_graph(callers_of)` por função risky. O agente recebe o algoritmo de decisão pré-mascado, não improvisa. **Recomendação: adapt para o `/review` orquestrado (Eixo 2).** Em vez de "leia a tabela", o prompt do `/review` deveria conter uma árvore IF risk_score < 0.4: produzir só GO + smell; ELSE: expandir LSP.findReferences nos top-N.

- **`pre_merge_check_prompt` com thresholds numéricos explícitos** (`prompts.py:135-159`): "If risk > 0.4 …", "If test_gap_count > 0 …", "If risk > 0.7 …". Decisão por threshold publicado no prompt, não no código. **Recomendação: steal a convenção de citar thresholds dentro do prompt.** Permite que usuários ajustem sem rebuild — o `/review` no Claudin pode parametrizar via `~/.claudin/settings.json` e injetar.

- **Wording "ALWAYS use X BEFORE Y"** em `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` do CRG (`CLAUDE.md:167-183`, `AGENTS.md:87-103`): caixa-alta + imperativo + lista do que substituir ("instead of Grep", "instead of manually tracing imports"). O CRG faz o usuário injetar isso no project-memory dele. **Recomendação: adapt com cuidado.** O tom funciona para um MCP externo opcional. Para o Claudin o equivalente é mais sutil: ensinar o Explore a preferir `LSPTool` antes de `GrepTool` quando a query é "achar callers/refs", **sem** texto caixa-alta no system prompt (poluição). Usar a `description` do `LSPTool` mesmo, deixando o `GrepTool.description` calar.

- **`SessionState` + `infer_intent` para roteamento implícito** (`hints.py:180-232`). CRG mantém um deque de últimos 10 tool names e classifica intent (reviewing/debugging/refactoring/exploring) por overlap com `_INTENT_TOOLS`. Resposta de cada tool inclui `_hints.next_steps` baseado no intent inferido. **Recomendação: avoid agora.** No Claudin o agente já tem o turn history completo no contexto; um classificador heurístico server-side duplica trabalho. Mas a ideia "tool response embute 1-3 sugestões de next_tool" é boa para tools custosas como `LSPTool` — vale considerar fora deste roadmap.

- **Anti-padrão: `bd remember` em vez de TodoWrite** (CRG `CLAUDE.md:138-139`). CRG instrui agentes a usar uma CLI externa (`bd remember`) para memória persistente, banindo TodoWrite/MEMORY.md. Mostra um vetor de fragmentação. **Recomendação: avoid copiar.** Reforça que o nosso prompt do Plan agent não deve sugerir storage paralelo ao `~/.claudin/projects/*/memory/` já existente.

---

## Eixo 2 — `/review` orquestrado com risk score

- **Pesos exatos do `compute_risk_score`** (`code_review_graph/changes.py:219-269`):
  - Flow participation: cap 0.25 (0.05 por flow, ou `sum(criticalities)` capado).
  - Cross-community callers: cap 0.15 (0.05 por caller cruzando comunidade).
  - Test coverage: começa em 0.30 e decai linear até 0.05 com `min(test_count/5, 1.0) * 0.25`.
  - Security keywords (`changes.py:262`): +0.20 fixo se nome bate qualquer kw.
  - Caller count: cap 0.10 (`callers / 20`).
  - Total clamp [0, 1], `round(4)`.

  **Recomendação: adapt com mudança.** Claudin não tem flows nem communities, então cap 0.40 (0.25+0.15) some — o que sobra é `test_gap (0.30 + decay) + security (0.20) + callers (0.10)` = teto natural 0.60. Para chegar a 1.0 sem grafo, **adicionar dois eixos LSP-nativos**:
  - **Diff size hunks** (lines changed / lines in file): cap 0.20. Hunk grande = mais risco.
  - **Cross-package callers** (LSP refs cujo `src/<a>/...` ≠ arquivo modificado em `src/<b>/...`): cap 0.15. Aproxima cross-community sem comunidades.

  Assim o vetor fica: tests 0.30 + security 0.20 + callers 0.10 + hunk_size 0.20 + cross_package 0.20 = 1.00.

- **Lista `SECURITY_KEYWORDS` literal a copiar** (`code_review_graph/constants.py:7-12`):
  ```
  auth, login, password, token, session, crypt, secret, credential,
  permission, sql, query, execute, connect, socket, request, http,
  sanitize, validate, encrypt, decrypt, hash, sign, verify, admin, privilege
  ```
  **Recomendação: steal como ponto de partida**, mas remover `query`, `request`, `http`, `connect`, `execute` (falso positivo gigante em qualquer framework web/ORM — qualquer função `executeQuery` ou `httpRequest` vira "security-sensitive" sem ser). Adicionar `cookie, csrf, cors, jwt, bearer, oauth, saml, escape, xss` para cobrir vetores web modernos. Match no `name.lower()` E no `qualifiedName.lower()` (CRG faz ambos em `changes.py:260-262`).

- **Parser de diff hunks via `git diff --unified=0`** (`changes.py:33-68`) com regex `r"^@@ .+? \+(\d+)(?:,(\d+))? @@"` (`changes.py:147`). Trata `count==0` como deleção pura, range = `(start, start)`. **Recomendação: steal o parser inteiro.** É 30 linhas, sem deps, lida com edge cases (hunk header sem count = 1 linha, deleção pura). Para Claudin TS, port direto.

- **Validação anti-injection do git ref**: `_SAFE_GIT_REF = re.compile(r"^[A-Za-z0-9_.~^/@{}\-]+$")` (`changes.py:24`) rejeita refs antes do `subprocess.run`. **Recomendação: steal.** O `/review` no Claudin aceita argumento `base` — sem essa whitelist, `base="; rm -rf /"` vira RCE.

- **Cap `CRG_MAX_CHANGED_FUNCS=500` para PR explosivo** (`changes.py:319-322`). PR de 2000 funções não detona O(N*M) — corta para 500 e adiciona warning no summary. **Recomendação: steal o pattern.** No Claudin, cap número de símbolos sobre os quais chama `LSPTool.findReferences` (cada chamada é ida-volta ao LSP, custosa). Sugiro `CLAUDIN_REVIEW_MAX_SYMBOLS=200` com fallback "use minimal mode for full coverage".

- **Timeout configurável por env**: `CRG_GIT_TIMEOUT=30s` (`changes.py:22`), `CRG_TOOL_TIMEOUT=0` opt-in no wrapper (`main.py:608-622`) com mensagem de erro acionável apontando os caps relevantes. **Recomendação: steal o padrão de "timeout retorna `status:error` com instrução de mitigação"**, não throw. Casa com fallback pattern de Claudin (`typescript-patterns.md`).

- **Modo `--minimal` — contrato exato**. `tools/review.py:73-122` define o que `detail_level="minimal"` retorna:
  ```
  { status, summary, risk: "high|medium|low", changed_file_count,
    impacted_file_count, key_entities: [top-5 names], test_gaps: int,
    next_tool_suggestions: [3 tools], context_savings: {...} }
  ```
  Arrays viram counts; node objects viram só `name`; classificação `>20 = high, >5 = medium, else low` (`tools/review.py:75-80`). **Recomendação: steal o shape exato** para o `/review --minimal` do Claudin. Substituir `next_tool_suggestions` por `next_actions: ["expand <symbol>", "open <file>:<line>"]` — sugestões acionáveis em vez de nomes de tool MCP.

- **Pitfall do test-gap dedup** (CHANGELOG 2.3.4-ish, `changes.py:365-383`): se o grafo tem qualified_name duplicado, summary lista "X, X, Y" — virou bug UX. CRG mitiga com `seen_names` set no print, mas mantém lista crua interna. **Recomendação: steal o defensive dedup só no human-facing summary**, e no Claudin garantir upstream que `LSPTool.documentSymbol` não retorne dupes do mesmo arquivo (pode acontecer em re-export).

- **Pitfall do timeout assíncrono**: CRG sofreu **deadlock em Windows MCP stdio** (CHANGELOG v2.2.4/v2.2.5, `main.py:589-591`) porque handlers sync bloqueavam o event loop, e a cura foi `async def` + `asyncio.to_thread` nas 5 tools pesadas. **Recomendação: avoid o bug.** No Claudin TS, `LSPTool.findReferences` em loop sequencial sobre 50 símbolos pode travar a TUI Ink — fazer com `Promise.all` cap em 8-10 paralelas (mesma ordem do `_MAX_PARSE_WORKERS=min(cpu, 8)` em `incremental.py:25`).

---

## Eixo 3 — Wiki auto-gerada

- **Como o CRG decide page boundaries: 1 página por community Leiden**, não por diretório (`wiki.py:171-274`). Cada community vira `<slug>.md`. **Recomendação: avoid copiar.** Já decidimos em `06-onde-ganho-real.md` que diretório resolve 80% sem `python-igraph` nativo. Mas note: o CRG **fallback de "communities por arquivo"** existe (`communities.py`) — se quiséssemos um dia subir para clustering, esse fallback é instrutivo de como degradar com graceful.

- **Estrutura de página a copiar** (`wiki.py:29-168`):
  ```
  # <Name>
  ## Overview         (size, cohesion, dominant language, description)
  ## Members          (top 50, tabela | Name | Kind | File | Lines |)
  ## Execution Flows  (top 10 + criticality)
  ## Dependencies     (### Outgoing — top 15; ### Incoming — top 15)
  ```
  **Recomendação: adapt.** Para Claudin sem flows nem communities, traduzir para:
  ```
  # <Module> (src/services/api)
  ## Overview         (#files, #symbols, dominant kind, summary do LLM)
  ## Public surface   (top 30 exports do Read view='outline')
  ## Imports out      (top 15 módulos que esse importa)
  ## Imports in       (top 15 módulos que importam esse)
  ## Tests            (arquivos *.test.ts colocados — count + lista)
  ```
  Mesma forma, dados vindos de `scanSymbols.ts` + regex de import.

- **Idempotência via content-hash**: `wiki.py:223-235` — antes de escrever, lê o arquivo existente e compara byte-a-byte; só conta como "updated" se mudou; senão `pages_unchanged++`. Sem hash explícito, mas equivalente. **Recomendação: steal.** Sem isso o `/wiki regen` mexe em timestamps de 200 arquivos e suja `git status`. Para Claudin, mesma estratégia: `if existing === content: skip`.

- **Pitfall fatal — slug collision com silenciamento** (CHANGELOG #223, `wiki.py:200-216`): "Data Processing", "data processing" e "Data&nbsp;&nbsp;Processing" todos viraram `data-processing.md`; counter reportou 107 páginas "updated" enquanto disco tinha 32 (~70% data loss silenciosa no smoke test). Cura: `used_slugs: set` per-run, append `-2`, `-3`. **Recomendação: steal a cura inteira.** Para Claudin agrupando por diretório isso é menos provável (paths são únicos), mas se ever usarmos `path.basename` como slug (ex: `src/services/api/` e `src/utils/api/` → `api.md`), bug volta. Adotar disambiguator desde o dia 1.

- **`_slugify` (`wiki.py:23-26`)**: dobra non-alphanumeric → `-`, truncate 80 chars. **Recomendação: steal direto.** 4 linhas, zero suspense, igual ao que faríamos.

- **Index page é uma tabela markdown sortable** (`wiki.py:250-253`): `| Community | Size | Link |`, sort por nome. **Recomendação: steal** mas adicionar coluna `| Last touched |` (data do último commit que tocou o módulo, via `git log -1 --format=%cs src/<module>/`). Onboarding ganha sinal de "essa área está viva ou morta".

- **Bonus — wiki é só consumível por humano, não pelo agent**. CRG não tem tool para o LLM consultar a wiki gerada (`get_wiki_page` existe em `wiki.py:277` mas é CLI/MCP-resource, não tool de chat). **Recomendação para Eixo 3:** garantir que a wiki nossa fique no `~/.claudin/projects/<repo>/wiki/` E seja referenciada como recurso opcional do Skill/CLAUDE.md, não dumpada inteira no contexto. O LLM lê on-demand via `Read`.

---

## Eixo 4 — Cache LSP in-memory por sessão

- **Cache de NetworkX graph + `threading.Lock`** (`graph.py:166-167, 179-182, 1278-1288`):
  ```python
  self._nxg_cache: nx.DiGraph | None = None
  self._cache_lock = threading.Lock()

  def _invalidate_cache(self):
      with self._cache_lock:
          self._nxg_cache = None
  ```
  Chamado em **toda** mutação (`upsert_node`, `upsert_edge`, `remove_file_data` — `graph.py:261, 281, 299`). Build do grafo só na 1ª query. **Recomendação: steal o pattern exato** para memoize de `LSPTool.documentSymbol(path)` e `LSPTool.findReferences(path, line, col)`:
  - `Map<key, value>` por sessão (no `ToolUseContext` ou módulo singleton).
  - Invalidate por arquivo na intercepção de `FileEditTool`/`FileWriteTool` post-execute (paralelo ao watchdog do CRG).
  - Sem `Lock` porque event loop TS é single-threaded, mas atenção a race entre tool-call paralelo do `Task` agent — usar `if (cache.has(k)) return cache.get(k); const p = compute(); cache.set(k, p); return p` para deduplicar in-flight.

- **Hash strategy = SHA-256 do file bytes** (`incremental.py:860, 977, 1177`). Lê bytes uma vez, hashea, parseia do mesmo buffer (TOCTOU-safe — CHANGELOG menciona isso explicitamente). **Recomendação: adapt.** SHA-256 é overkill para invalidação de cache in-memory (não precisa ser cripto). Usar `bun.hash()` (xxHash3) ou `crypto.createHash('sha1')` — 5-10× mais rápido. Mantém o pattern TOCTOU-safe: `const buf = await readFile(path); const key = hash(buf); cache.get(key) ?? parse(buf)`.

- **TOCTOU pattern explícito**: "File bytes are now read once, then hashed and parsed from the same buffer, closing the time-of-check-to-time-of-use gap" (CHANGELOG, regressão fixada). **Recomendação: steal as a hard rule.** Se Claudin cache fizer `if (mtime > cached.mtime) reparse()` em vez de hash-do-buffer, edits muito próximas podem cache-poisonar. Hash-de-buffer é caminho único.

- **Debounce 0.3s para file events** (`incremental.py:1064, 1140-1147`): watchdog handler agrupa events numa `_pending: set`, reseta `threading.Timer(0.3)` a cada hit, processa no flush. Evita reparsing 5× num save rápido do VS Code. **Recomendação: steal o valor (300ms) e o shape** — para o nosso cache, se invalidamos por hook PostToolUse(Edit), 300ms de debounce evita thrash se o agente faz 3 edits seguidas no mesmo arquivo.

- **Module cache bound** (CHANGELOG line 592): `_MODULE_CACHE_MAX = 15_000` com eviction automática para evitar OOM em sessões longas. **Recomendação: steal.** Sem cap, sessão de 4h com agente passando por 10k arquivos vaza memória. Sugerir `CLAUDIN_LSP_CACHE_MAX=5000` com LRU eviction (Map mantém insertion order — `if (cache.size > MAX) cache.delete(cache.keys().next().value)`).

- **Pitfall race condition entre watch mode e MCP request** (CHANGELOG line 627): "Thread-safe NetworkX cache: Added `threading.Lock` around graph cache reads/writes to prevent race conditions between watch mode and MCP request handling". **Recomendação: avoid no Claudin porque single-threaded**, mas atenção: se algum dia houver coordinator + worker agents tocando mesmo cache (gRPC server, etc.), o equivalente em JS é fila por chave (Map<key, Promise>).

- **Pitfall — Windows deadlock NÃO se aplica a nós**, mas a lição (CHANGELOG 2.2.4/2.2.5, +5 tools convertidas para `async def + asyncio.to_thread`) reforça: **toda operação de cache miss deve ser async/non-blocking**. Se `LSPTool.findReferences` num cache miss bloqueia o event loop por 800ms enquanto o LSP responde, a TUI Ink stuttera. Já é async por contrato — confirmar que o memoize wrapper retorna `Promise`, não awaita dentro de um lock síncrono.

---

## Eixo 5 — Índice persistente cross-sessão (adiado)

Documentar pelo menos uma vez aqui o que pegaríamos do CRG quando este eixo sair do freezer, para a próxima rodada não re-pesquisar:

- **Localização do DB**: `.code-review-graph/graph.db` per-repo, com `.gitignore` auto-escrito (`incremental.py:234-298`). Atalho `CRG_DATA_DIR` env var para Docker/CI. **Quando fizermos: steal** mas usar `~/.claudin/projects/<repo>/index.sqlite` para casar com a convenção memdir já existente, evitando lixo no working tree (e fora do gate `verify:privacy` — registrar como problema separado conforme memória `verify-privacy-bundle-only`).

- **SQLite WAL + `check_same_thread=False`** (CLAUDE.md:71-72 do CRG). **Steal.** Para JS, `better-sqlite3` ou `bun:sqlite` já abrem em WAL por default; explicitar.

- **Migrations v1→v9** (`migrations.py`). 9 versões em ~12 meses = schema evoluindo rápido. **Lição: avoid acoplar nosso schema ao deles.** Manter schema próprio mínimo (symbols + imports), evoluir devagar.

- **BFS via SQL recursive CTE** (`graph.py:634-744`) — substitui Python BFS por uma única query SQLite. **Steal a ideia se** o índice persistente for grafo de chamadas. Para um índice só de símbolos+imports, BFS é desnecessário.

---

## Bônus — itens fora dos 5 eixos que valem entrar no roadmap

### B1. `context_savings` panel pós-tool-call (UX)

CRG `2.3.5` introduziu um panel ASCII de Token Savings (`context_savings.py:269-317`) que aparece em **toda** chamada `--brief`, com `chars/4` baseline calibrado por tiktoken (±0.5% em agregado). É a feature mais demonstrável do CRG.

**Justificativa para Claudin:** já temos `TOKEN_BUDGET` flag (`scripts/build.ts`) e `bash-output-filter` reporta savings agregadas. Falta surfacing per-tool. Em um `LSPTool.findReferences` que devolveu 30 refs em vez do agente abrir 30 arquivos, mostrar "saved ~12k tokens (~94%)" no rodapé do tool result fecha o loop de feedback. Custo: ~50 linhas + 1 helper. Ganho: usuário confia mais no LSP path e o "agente Explore inteligente" vira observável. Cuidado: respeitar memória `no-overclaim-performance` — calibrar e citar metodologia, não chutar 100× como o README do CRG fez.

### B2. Refactor preview com `refactor_id` expirável + `dry_run` (segurança)

`refactor_tool` (`main.py:626-689`) retorna um `refactor_id` válido por 10min, e `apply_refactor_tool(dry_run=True)` mostra diff unificado antes de aplicar. Path validation garante in-repo (`main.py:674-675`).

**Justificativa para Claudin:** já temos `LSPTool.rename` mas a aplicação é direta. Para rename cross-package (50+ arquivos), o agente faz, usuário descobre depois. Um modo `rename --dry-run` que mostra diff antes + confirma resolve a anti-feature "agent renamed too much". Esforço pequeno, ganho de trust grande. Reusa permission flow já existente.

### B3. Calibração explícita "estimate vs verified" (anti-overclaim)

CRG `--verify` flag (`CHANGELOG:32-40`) compara estimate `chars/4` contra tiktoken `cl100k_base` real, mostra ambos lado-a-lado no panel, documenta bias de ±12% por-repo mas estável em ratio.

**Justificativa para Claudin:** qualquer claim de economia futura do nosso `/review`, wiki ou cache LSP precisa de mecanismo equivalente. `bash-output-filter` já cita ~50k tokens/sessão; se virem novos eixos, seguir o template do CRG: estimate barata default, `--verify` opt-in com tokenizer real, e committar a tabela de calibração no repo (`docs/REPRODUCING.md` no CRG, equivalente `docs/discovery/<feature>/calibration.md` para nós). Custo: ~1 dia por feature; ganho: claims defensáveis.


---

## Adendos por eixo (densificação 2ª passada)

### Eixo 1 — mais

- **Tom "Fall back to Grep/Glob/Read **only** when …"** (`CLAUDE.md:183`, `AGENTS.md:103`). Não diz "nunca use Grep"; estabelece hierarquia e libera o escape hatch explicitamente. **Recomendação: steal o pattern de "X first, fallback to Y only if Z".** Para Claudin: "Use `LSPTool` first for callers/refs/definition; fallback to `GrepTool` only when LSP server isn't running or symbol crosses non-indexed languages." Sem o escape hatch, agente fica preso quando LSP indisponível.

- **Tabela "Tool | Use when"** (`CLAUDE.md:187-196`, `AGENTS.md:107-116`). Cada tool ganha **uma linha** com "use when" em vez de docstring longa. Forma comprime para o agente decidir rápido. **Recomendação: steal o formato** para uma tabela de "decision matrix" injetável no Explore agent — Claudin hoje tem descriptions verbosas em cada tool; comprimir o ranking de when-to-use numa tabela aumenta hit rate.

### Eixo 2 — mais

- **`pre_merge_check` tem decisão GO/NO-GO explícita no prompt** (`prompts.py:157-158`): "Output: GO/NO-GO recommendation with 1-sentence justification + list of required follow-ups." Forma de resposta predefinida → LLM converge. **Recomendação: steal.** O `/review` no Claudin devia terminar **sempre** com bloco `## Verdict: GO|NO-GO|NEEDS-WORK` e `## Follow-ups`. Hoje cada review tem shape diferente.

- **Bug do `apply_refactor` multi-edit no mesmo arquivo** (CHANGELOG PR #228, line 388): "previous implementation re-read the file once per edit and could silently stomp earlier changes. Fix: group edits by file, apply sequentially against updated content". **Recomendação: avoid this bug.** Se o `/review --apply-suggestions` algum dia escrever (não vai, mas se evoluir para autofix tipo `eslint --fix`), agrupar por path e aplicar sequencial sobre buffer atualizado, não read+write por edit. Padrão idêntico ao `FileEditTool` em batch — verificar se já segue.

### Eixo 3 — mais

- **Wiki regeneração só substitui se mudou** + **`force=True` para reset** (`wiki.py:174, 223, 259`). Dois modos publicados. **Recomendação: steal os dois.** `/wiki regen` default = idempotente; `/wiki regen --force` = byte-a-byte rebuild (útil quando o LLM summarizer mudou). Match com convenção dos hooks Claudin.

- **Page generation isolada em função pura** (`_generate_community_page(store, community) -> str`, `wiki.py:29-168`). Recebe dados, devolve markdown — zero IO. Facilita teste snapshot. **Recomendação: steal a separação.** Nosso `generateModulePage(module, symbols, imports, summary) -> string` permite teste com `toMatchSnapshot()` (rule `testing.md`), sem fixtures de filesystem.

### Eixo 4 — mais

- **Padrão "cache miss → bool retorno"**: handler do watchdog (`incremental.py:1167-1192`) retorna `True/False` se atualizou, e só dispara `on_files_updated` callback se algum arquivo realmente atualizou (`incremental.py:1161`). Evita callbacks N=0. **Recomendação: steal o `if updated > 0: callback()`** — no Claudin, se hook PostToolUse(Edit) invalida cache mas hash não mudou (write idempotente), não recompute, não emit event.

- **CVE-2025-62800/62801/66416 em FastMCP 1.x** (CHANGELOG line 422) → XSS + command injection + Confused Deputy. CRG bumped para `fastmcp>=3.2.4`. **Recomendação: avoid o equivalente.** Se Claudin cache LSP ficar acessível via MCP server (improvável agora), validar inputs igual ao `_SAFE_GIT_REF` pattern. Memória `verify-privacy-bundle-only` já flag que `~/.claudin/` está fora do gate — adicionar índice in-memory cache não muda isso, mas se virar SQLite (Eixo 5), trata como surface adicional.

### Eixo 5 — mais

- **Hooks JSON exato do CRG** (`hooks/hooks.json`):
  - `SessionStart` → `code-review-graph status` (timeout 10s) — re-hydrate em entrada.
  - `PostToolUse(EnterWorktree)` → `code-review-graph build … &` — build assíncrono em background.
  - `PostToolUse(Write|Edit|Bash)` → `code-review-graph update --skip-flows` (timeout 30s) — invalidação síncrona com cap.

  **Recomendação para quando descongelar Eixo 5: steal o triplet exato**, adaptado para Claudin: hook SessionStart re-warm o cache; EnterWorktree dispara build async; Edit/Write invalida só os arquivos tocados. `Bash` matcher é overkill (qualquer `ls` invalida tudo) — restringir a `Bash` que reportou modificação via output filter.

- **Background build hidden em `>/dev/null 2>&1 &`** (hooks line 18). **Avoid o anti-pattern** — em caso de erro, usuário não vê. Para Claudin melhor: redirect para `~/.claudin/logs/index-build.log` e mostrar tail-3 no `/usage` ou `/wiki status`.

