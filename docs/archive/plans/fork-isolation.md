# Plano de design — Sub-agents em `child_process.fork()`

> Status: rascunho de design, não implementado | Data: 2026-05-04 | Cobre ROADMAP 5.11

## Problema concreto

Em sessões longas com múltiplos agents em paralelo (ex: review + dev + test simultâneos):

- RSS sobe de **240 MB → 1.6 GB** observado em `btop`
- **Não volta ao baseline** mesmo após sub-agents terminarem
- Causa raiz: `runAgent.ts:911-916` admite que "10× concurrent fan-out can leave 250 MB of clone bytes unreleased"; `globalThis.gc?.()` libera pro V8 reusar mas **jemalloc/glibc não devolve páginas ao kernel**

ROADMAP 5.11 propunha `worker_threads`. **Análise revisada concluiu que `worker_threads` não resolve o sintoma** — `worker.terminate()` libera o isolate mas não devolve memória ao kernel; só `_exit()` de processo faz isso. A solução correta é `child_process.fork()`.

## Decisão arquitetural

3 isolates V8 separados em **2 processos** (não 3):

```
┌─────────────────────────────────────────────────────┐
│  Main process                                       │
│  ─ Ink/React TUI                                    │
│  ─ QueryEngine principal + mutableMessages          │
│  ─ Tool dispatch                                    │
│  ─ Provider SDK ativo                               │
│  ─ Permission UI                                    │
│  ─ Sub-agent broker                                 │
│  ─ MCP connection broker                            │
└──────────────────────┬──────────────────────────────┘
                       │ IPC (process.send / on('message'))
                       │
┌──────────────────────▼──────────────────────────────┐
│  Sub-agent child pool (N children, default cpus)    │
│  ─ Cada child: QueryEngine slim                     │
│  ─ Bundle entry sem Ink/React/Markdown              │
│  ─ Spawn on-demand, _exit() libera ao kernel        │
└─────────────────────────────────────────────────────┘
```

**Pulamos a F4 do plano original** (mover QueryEngine principal pra worker). Análise crítica concluiu que F4 é cosmética — não diminui RSS pico, só rebalanceia. Custo 3-5× a estimativa original. Capturamos ~80% do ganho real sem F4.

## Por que fork e não worker_threads

| Aspecto | worker_threads | child_process.fork |
|---|---|---|
| RSS volta ao kernel após terminar? | ❌ não, mesmo processo Node | ✅ sim, via `_exit()` |
| Singletons (`bootstrap/state`, telemetry, cost) | gap crítico — RPC ou clone | natural — cada child tem o seu, descartado ao morrer |
| `process.cwd()` por agent (worktrees) | bug sutil — cwd compartilhado | ✅ cada child tem seu cwd |
| Cold-start retido (180 MB / log.ts puxa 94 MB) | cada worker re-paga no pool warm | child paga uma vez, morre |
| Per-agent overhead | ~50 MB | ~80–150 MB |
| Spawn time | ~30–50 ms | ~150–200 ms |
| AbortController cross-boundary | igualmente difícil | igualmente difícil |
| IPC | structured clone + transferable | JSON, sem structured clone (workaround pra payloads grandes via pipe/file) |

**Decisão:** fork. O sintoma reportado é "RSS não volta", e só fork resolve isso.

## Conta de pico esperada

Para 3 agents em paralelo:

| Estado | Hoje | Com fork |
|---|---|---|
| Idle baseline | 240 MB | 240 MB |
| 3 agents rodando | ~1.0–1.2 GB pico | ~690 MB pico (240 + 3×150) |
| Após terminar | **1.6 GB persistente** | **240 MB** (children morrem, kernel reclama) |

Em sessão longa de 4-5h: hoje sobe monotonicamente; com fork, sawtooth previsível em torno de 240 MB.

## Plano em fases (estimativas calibradas após auditoria do código)

| Fase | Esforço inicial | **Esforço real auditado** | LoC novo + mod | Conteúdo |
|---|---|---|---|---|
| ~~**F5**~~ | S (1d) | **CANCELADA** | — | Auditoria mostrou que client.ts já usa `await import()` em Bedrock/Vertex/Foundry/openaiShim. Anthropic SDK eager custa só 18 MB — baixo valor pelo trabalho. |
| **F1** | S (1d) | **S+ (1.5d)** | ~500-700 LoC novo, ~25 mod | `ChildProcessPool` primitive + `src/entrypoints/agent-worker.ts` + ajustar `build.ts` (dual entries) + verify-no-phone-home contemplar 2º bundle. |
| **F3** | M (2d) | **M (2-3d)** | ~700-900 LoC novo | MCP broker + Permission RPC. 134 callsites de `canUseTool` no codebase (a maioria só passa o ref, sem mudança). 13.7k LoC em `services/mcp/` mas só protocolo de transport precisa wrapper IPC. **Risco:** elicitation com `AbortSignal` cruzando processo. |
| **F2** | M (2-3d) | **M+ (3-4d)** | ~700-1000 LoC novo + 200 mod em runAgent | `runAgent.ts` dispatch via pool. **AppState: 1298 callsites no codebase, 29 só em runAgent**, ~156 campos no STATE singleton — cada precisa decisão (read-only no child? mutate-report? IPC sync?). Snapshot+delta strategy é a única viável. |

**Total revisado: 6.5-8.5 dias úteis (vs 7d original). Bate, mas F2 ficou maior por causa da superfície de AppState.**

## Gaps críticos identificados (e mitigações)

### 1. AppState atravessa boundary síncrono

**Problema:** `Tool.ts:188-198` expõe `getAppState(): AppState` síncrono; `setAppState(prev => ...)` é reducer functional. `runAgent.ts:346-352, 466-548, 890-894` usa em hot path. Não vira RPC sem reescrever a API de Tool.

**Mitigação:** Child começa com **snapshot completo do AppState** via IPC inicial. Lê localmente (sync). Quando muta, registra a mutação localmente e envia **delta** ao parent ao terminar. Whitelist de campos com mutação válida em sub-agent:

- `modelUsage[model]` (delta de tokens)
- `totalCostUSD` (delta de cost)
- `agentColorMap[agentId]` (entry nova)
- `todos[agentId]` (criação/atualização — limpo por parent)
- `plan slug registry entry` (criação)
- `perfetto trace events` (lista append-only)

Campos read-only no sub-agent (a maioria): permission rules, settings, mcpClients, mcpResources, etc.

### 2. `bootstrap/state.ts` é singleton de 1.7k LoC

**Problema:** Cada child carrega seu próprio STATE, paga 94 MB do log.ts/bootstrap por instância. Pool warm de 4 children = ~376 MB sempre.

**Mitigação:**
- **Não usar pool warm** — spawn on-demand, terminate after job. Spawn time de 150-200ms é aceitável para chamadas de agent (que duram segundos a minutos).
- Bundle do `agent-worker.ts` **exclui** Ink, React, Markdown, cli-highlight, `screens/*`, `components/*`. Cada child paga ~80 MB em vez de 240 MB.

### 3. MCP "broker via RPC" no F3 dobra latência

**Problema:** `client.ts` usa `StdioClientTransport`/`SSEClientTransport`. Compartilhar entre children exige re-encode JSON-RPC. Cancel/elicitation com `AbortSignal` cruzando boundary é race-condition.

**Mitigação:**
- Broker simples no main: child manda `{toolName, args}`, main executa contra MCP client compartilhado, retorna `{result}` ou `{error}`.
- Elicitation: child manda request, main resolve via UI, retorna. Cancel: main mantém map `{requestId → AbortController}`, SIGTERM no child cancela tudo.
- ~10-30ms de IPC overhead por chamada MCP. Aceitável (chamadas MCP duram 100ms-segundos).

## Cache token preservation (crítico — pode regredir custo 10×)

Anthropic prompt cache é **server-side, indexado por hash do prefix + API key**. Fork não muda nada **por padrão**. Duas armadilhas:

### Singleton 1: `largeSystemPromptLatched` (`claude.ts:395-409`)

Decide TTL `5min` vs `1h`. Se parent latched=true mas child latched=false, mandam `cache_control` diferentes no mesmo prefix → **hash diferente, miss, custo 10× maior**.

**Mitigação:** Serializar `largeSystemPromptLatched` no payload IPC inicial. 1 campo. Trivial.

### Singleton 2: `previousStateBySource` (`promptCacheBreakDetection.ts:98`)

Cada child detecta breaks isoladamente. Não é catastrófico — detection é warning UI, não funcional. Mas usuário perde alguns warnings.

**Mitigação:** Aceitável. Eventualmente, mover detection pro main (children reportam request hash, main faz comparison). Pode ser pós-F2.

### Singleton 3: `perfettoRegistry` (telemetry)

Hierarquia visual de agent tree quebra se cada child mantém o seu.

**Mitigação:** Children enviam eventos perfetto via IPC ao main, que mantém registry consolidado. Adiciona ~50 LoC ao broker.

## Outros riscos não-óbvios

- **`AbortController.signal` não cruza process boundary.** `runAgent.ts:574-578` cria controllers child linkados; `executeSubagentStartHooks(agentId, agentType, agentAbortController.signal)` (`:582-586`) passa o signal pra hook runtime. Atravessar processo requer reimplementar como events-over-IPC.
- **`process.cwd()` é process-global.** `bootstrap/state.ts:265 cwd()` e `setCwdState`/`runWithCwdOverride` assumem 1 processo. Em fork: cada child pode ter seu cwd próprio (vantagem para `EnterWorktreeTool`).
- **`feature()` pre-processing.** `scripts/build.ts:101-116` pré-processa todos os `src/`. Segundo entry `agent-worker.ts` precisa do mesmo flag map ou um set diferente — verificar como o build trata 2 entries com flags potencialmente divergentes.
- **`canUseTool` retorna sync-ish.** `wrappedCanUseTool` em `QueryEngine.ts:260-287` mantém `permissionDenials` mutável local. Já é async — viraria RPC com `await` natural.

## UX impact matrix (revisada após auditoria UX 2026-05-04)

| Área | Impacto |
|---|---|
| **Cache tokens** | ✅ preservados se F2 serializar `largeSystemPromptLatched` |
| **Streaming output** | ~3–8ms IPC overhead/chunk — invisível |
| **TTFT** | inalterado (network-bound) |
| **Permission prompts** | ~15ms round-trip extra — invisível (queue já async). F3 deve garantir FIFO. |
| **Ctrl+C / abort** | main → SIGTERM children. Bash em vôo pode atrasar 100-300ms o "encerrando..." |
| **`/cost`, `/usage`** | ⚠️ **VISÍVEL:** sem ajuste, mostra valor stale durante fan-out concorrente. **Mitigação obrigatória:** stream `cost_delta` periódico (1 msg/turno), não só no terminate. |
| **`/resume`** | funciona — sidechain transcripts em disco |
| **MCP** | F3 broker; sem F3, +50-200ms reconexão por child |
| **Hooks frontmatter** | ⚠️ **RISCO ALTO:** se mal-projetado, hooks `SubagentStop` podem silenciosamente não disparar. Decisão de design obrigatória antes de F3 (ver "Pontos delicados"). |
| **`BackgroundHint` UI** | ⚠️ `setToolJSX(<BackgroundHint />)` (`AgentTool.tsx:848-851`) não cruza fork. F2 deve incluir IPC `set_tool_jsx`. |
| **Background bash órfão** | ⚠️ `killShellTasksForAgent` no finally do child. Ordem cleanup precisa: child manda `kill_my_bashes` → ack → `_exit()`. |
| **Spawn latency** | ⚠️ **VISÍVEL em built-ins one-shot:** 150-200ms é 10-20% do TTFT em sub-agents triviais. **Mitigação:** não forkar built-in agents one-shot (Explore, Plan); só user-defined OU fan-out concorrente ≥2. |
| **Memória** | ✅ sawtooth em torno de 240 MB; sem retenção pós-execução |

## Critérios de aceite

Para considerar F2 done:

**Performance:**
- Bench `scripts/profile/cold-start-retained-bench.ts` baseline preservado
- Novo bench `scripts/profile/concurrent-agents-bench.ts` mostra RSS pós-fanout = baseline ± 20 MB
- Cache hit rate em sessão de 50 turnos: queda <5% vs baseline (mede `cache_read_input_tokens`)
- `STATE.totalCostUSD` no main após N fan-outs = soma dos deltas reportados pelos children (teste exato)
- 459 testes provider passam
- `verify:privacy` passa

**UX (adicionado 2026-05-04 após auditoria):**
- One-shot built-in agents (Explore, Plan, agents com `ONE_SHOT_BUILTIN_AGENT_TYPES`) **não são forkados** — heuristic: só fork em fan-out concorrente ≥2 OU user-defined agent
- `/cost` durante fan-out concorrente reflete custo dentro de ±5% do real (stream periódico `cost_delta`)
- Hooks frontmatter `SubagentStop` disparam de forma deterministica (teste explícito com agent forkado)
- `<BackgroundHint />` aparece em sub-agent forkado após `PROGRESS_THRESHOLD_MS` (teste de integração)
- Background bash spawnado por agent forkado é morto quando agent termina (sem PPID=1 zombies)
- Permission prompts de child mantêm ordem FIFO no UI queue (teste com 2 children gerando prompts simultâneos)

## Pontos delicados surgidos na auditoria (não estavam no plano original)

1. **Build pipeline tem 1 entrypoint hoje.** `scripts/build.ts:162` é literal `['./src/entrypoints/cli.tsx']` e `naming.entry: 'cli.mjs'` é string fixa. F1 precisa virar template `[name].mjs` ou functional. `verify-no-phone-home.ts` e `.sh` também hardcodam `cli.mjs` — precisa scan de ambos os bundles.
2. **`STATE` tem ~156 campos** (`bootstrap/state.ts`, contagem real). A whitelist de "campos com mutação válida no child" precisa cobrir todos — a maioria é read-only no agent, mas omitir um campo de mutate quebra silenciosamente (cost tracking, agent colors, plan slugs). Auditoria sistemática é parte do trabalho da F2.
3. **`claude.ts` é 3179 LoC com 25 callsites.** Importa eager `log.ts` (linha 75) que é o que puxa 94 MB. **F5 cancelada não significa que log.ts foi atacado** — esse é tema separado (ROADMAP 5.9 ainda vale).
4. **MCP elicitation com AbortSignal** atravessando boundary é o item mais técnico da F3. Race quando child morre enquanto request elicitation está em vôo. Precisa map `{requestId → AbortController}` no main e cleanup ordenado.
5. **Hooks frontmatter precisam decisão de design ANTES da F3** (auditoria UX 2026-05-04): `runAgent.ts:618-624` registra hooks no STATE do main hoje. `SubagentStop` precisa de STATE coerente, e `hooksConfigSnapshot.ts` é singleton. Opções:
   - (a) hook config snapshot vai no payload IPC inicial; child roda hooks localmente; `clearSessionHooks` via IPC → main
   - (b) main roda hooks; child manda eventos via IPC; AbortSignal de hook usa events-over-IPC
   - Opção (a) é mais simples mas re-parseia settings.json; opção (b) preserva singleton mas tem latência. **Decidir antes de F3.**
6. **Heuristic de "quando forkar" é parte do design da F2** (auditoria UX 2026-05-04): forkar TODO sub-agent paga 150-200ms de spawn em built-ins one-shot (Explore, Plan) que retornam em <1.5s. Captura 90% do problema RSS forkando só quando: fan-out concorrente ≥2 OU user-defined agent. Built-ins one-shot ficam in-process.
7. **Cost delta deve ser stream, não terminate-only** (auditoria UX 2026-05-04): `/cost` durante fan-out fica stale se children só reportam no `terminate`. Stream `cost_delta` periódico (1 msg/turno do child) elimina o sintoma. Trivial em volume (~10/min/child).
8. **`setToolJSX` cross-process** (auditoria UX 2026-05-04): `AgentTool.tsx:848-851` chama `toolUseContext.setToolJSX(<BackgroundHint />)` após threshold. Sem IPC explícito, sub-agent forkado nunca mostra hint. F2 deve incluir mensagem IPC `set_tool_jsx` no contrato.
9. **Ordem de cleanup de background bash** (auditoria UX 2026-05-04): `runAgent.ts:898 killShellTasksForAgent` no finally. Se child crasha antes do finally-IPC, bash filho fica reparented a init. Protocolo: child manda `kill_my_bashes` → ack do main → `_exit()`. SIGTERM forçado só se ack timeout (2s).

## Próximas ações (continuar daqui amanhã)

1. **Spike de F1 primeiro (~2h):** branch isolada com pool primitive + `agent-worker.ts` minimal que faz `console.log("hello"); process.exit(0)`. Bench: spawn time real + RSS volta ao baseline. Decide se a abordagem mantém propostas.
2. **Bench novo `concurrent-agents-bench.ts`** — reproduz o sintoma "review + dev + test em paralelo" com 3 fake sub-agents. **Capturar número antes da implementação.** Sem isso, não temos contrafactual honesto.
3. **Doc de contrato IPC** (~1 página): mensagens parent→child (spawn, abort, mcp_response, permission_response, app_state_snapshot), child→parent (ready, message stream, mcp_request, permission_request, app_state_delta, cost_delta, terminate_complete).
4. **Auditoria sistemática dos 156 campos do STATE:** classificar cada um como read-only-no-child / mutate-report / mutate-roundtrip. ~2-3h de trabalho — output é a whitelist exata que vira código na F2.
5. **Decidir F2 inicial scope:** dispatch via pool **só quando há fan-out concorrente** (3+ agents simultâneos)? Ou todo sub-agent? Começar conservador (só fan-out) reduz risco e ainda captura o sintoma do user.

## Resumo executivo da dificuldade

- **F5 cancelada:** trabalho mostrou que já está parcialmente feito; baixo valor.
- **F1 (1.5d):** sem surpresas técnicas. Build pipeline aceita modificação clean. Pool primitive é bem-conhecido.
- **F3 (2-3d):** moderado. Elicitation/abort cross-process é o ponto técnico real.
- **F2 (3-4d):** **fase mais arriscada.** A superfície do AppState é grande (156 campos, 1298 callsites globalmente). Snapshot+delta é a estratégia certa, mas testabilidade depende de ROADMAP 4.1 (testes em QueryEngine que ainda não existem).
- **Total: ~7-9d úteis.** Cada PR é entregável e revertível independentemente.

**Ponto de saída intermediário viável:** após F1+F3, sem F2, já temos a infraestrutura. Pode-se rodar 1 agent simples por fork (não todo runAgent) como prova de vida, validar memory + cache antes de comitar a F2 maior.

## Referências

- ROADMAP 5.11 (worker_threads original)
- `runAgent.ts:866-917` (cleanup atual em finally + gc?.())
- `Tool.ts:188-198` (AppState API)
- `claude.ts:395-409` (largeSystemPromptLatched)
- `promptCacheBreakDetection.ts:98` (previousStateBySource)
- `bootstrap/state.ts:417` (STATE singleton)
- `scripts/profile/cold-start-retained-bench.ts` (bench novo, não comitado)
- `scripts/profile/query-engine-mem-bench.ts` (bench existente do 5.7)
