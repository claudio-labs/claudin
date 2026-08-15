# Fase 7 — Plano formal

> Sub-item final do ROADMAP 11g (main.tsx split).
>
> **Meta:** reduzir `src/platform/main.tsx` de **2711 → <600 linhas** mantendo
> ordem de boot, `profileCheckpoint`s e snapshots verdes.
>
> **Estado de entrada:** Fase 1→6 já mergeadas. `main.tsx` em 2711
> linhas, 24 módulos novos em `src/platform/main/`.

---

## Inventário do que sobrou em `main.tsx`

| Linhas | Bloco | Tamanho | Destino |
|---|---|---|---|
| 1–221 | imports (~150 módulos) | 221 | Permanece (reduz com extrações) |
| 222–288 | side-effects: debug guard, `_pending*` slots, re-exports | 67 | Slots → `bootContext`, resto fica |
| 289–549 | **`main()`** — argv pre-parse (cc://, deep link, KAIROS assistant, SSH_REMOTE) + `clientType`/`isInteractive` | 260 | **7a** → `src/platform/main/argvPreparse.ts` + `src/platform/main/clientType.ts` |
| 551–639 | `run()` — Commander init + **preAction hook** (init, sinks, plugin-dir, migrations, remote settings) | 89 | **7b** → `src/platform/main/preActionHook.ts` |
| 640–678 + 2608–2658 | root `.option/.addOption` (root flags + worktree/advisor/kairos/teammate/sdk-url/teleport) | ~90 | **7b** → `src/platform/main/rootOptions.ts` |
| **679–2607** | **`.action(async (prompt, options) => {...})`** | **🐘 1929** | **7c.1–7c.6** (ver abaixo) |
| 2659–2701 | subcommand registration + `parseAsync` | 43 | **7b** → `src/platform/main/registerSubcommands.ts` |
| 2702–2711 | rodapé `run()` + `profileReport` | 9 | Permanece |

---

## Anatomia do `.action()` (1929 linhas)

| Sub | Linhas | Conteúdo | Aprox |
|---|---|---|---|
| **A** | 679–950   | options parse + bare/sessionId/fileSpecs/sysPrompt/teammate setup | ~270 |
| **B** | 950–1490  | MCP config parsing + enterprise MCP + KAIROS channels + brief tool + dangerous-perms validation | ~540 |
| **C** | 1490–1665 | `setup()` + UDS_INBOX + sessionName + agents loading + `mainThreadAgentDefinition` | ~175 |
| **D** | 1665–1810 | agent systemPrompt/initialPrompt/model resolution + advisor + brief/proactive + assistant pre-init | ~145 |
| **E** | 1812–1933 | trust dialog + onboarding + login + orgValidation | ~120 |
| **F** | 1942–2200 | LSP init + startup prefetches + MCP configs loading + thinking config + plugins init + telemetry | ~260 |
| **G** | 2200–2280 | `if (isNonInteractiveSession) runHeadlessBranch(...); return;` | ~80 (já Fase 5c) |
| **H** | 2280–2450 | permissionMode banner + deprecation + broad-bash warnings + CCR mirror + history | ~170 |
| **I** | 2450–2606 | `sessionConfig` + `resumeContext` + dispatch das branches | ~157 |

---

## Sub-fases

### Fase 7a — `main()` argv pre-parse  (~230 linhas cortadas)

**Novos módulos:**

- `src/platform/main/argvPreparse.ts`
  - `runDirectConnectArgvRewrite(argv): string[]` — DIRECT_CONNECT cc:// rewriting
  - `runDeepLinkArgvHandling(argv): { argv, pendingConnect } | null`
  - `runAssistantArgvStash(argv): boolean` — KAIROS assistant flag prefetch
  - `runSshArgvStash(argv): boolean` — SSH_REMOTE flag prefetch
- `src/platform/main/clientType.ts`
  - `resolveClientType(): { clientType, sessionSource, previewFormat, isInteractive }`

**Pós-corte:** `main()` em ~30 linhas (sequência de helpers + try/catch existente).

**Validação:** smoke + `bootSnapshot.test.ts` (4 testes).

---

### Fase 7b — `run()` Commander setup  (~170 linhas cortadas)

**Novos módulos:**

- `src/platform/main/preActionHook.ts` — `registerPreActionHook(program, deps)` retorna o `program` para encadear.
- `src/platform/main/rootOptions.ts` — `registerRootOptions(program)` (root + worktree + advisor + kairos + teammate + sdk-url + teleport/remote/remote-control + hard-fail).
- `src/platform/main/registerSubcommands.ts` — `registerSubcommands(program, { pendingConnect })` chama os 14 registers já extraídos na Fase 5a.

**Risco de tipos:** `extra-typings` perde inferência ao quebrar cadeia
`.option().option()`. Mitigação: retornar `program` tipado intermediário
ou usar declaração de tipo manual no callsite restante; **não toca**
no `.action()` signature.

**Validação:** smoke + `bootSnapshot.test.ts` + `--help` snapshots
(top-level + per-subcommand) garantem nenhuma option foi perdida ou
reordenada.

---

### Fase 7c — `.action()` em 6 sub-extrações  (~1530 linhas cortadas)

**Padrão:** `ActionContext` mutável (estende `BootContext`) carrega
estado entre helpers. Variáveis closure-shared (`mainThreadAgentDefinition`,
`inputPrompt`, `effectiveModel`, `systemPrompt`, etc.) viram refs
`{ current }` (padrão já validado nas Fases 5b/5c).

**`profileCheckpoint(...)` calls permanecem no callsite original**
(em `main.tsx`, chamando o helper logo em seguida) para preservar
ordem exata — `bootSnapshot.test.ts` trava 21 checkpoints.

| Sub | Bloco | Saída | Corte |
|---|---|---|---|
| 7c.1 | A          | `src/platform/main/action/parseOptions.ts` | ~250 |
| 7c.2 | B          | `src/platform/main/action/mcpAndPerms.ts` | ~520 |
| 7c.3 | C + D      | `src/platform/main/action/setupAgent.ts` | ~310 |
| 7c.4 | E          | `src/platform/main/action/trustAndOnboarding.ts` | ~110 |
| 7c.5 | F + H      | `src/platform/main/action/startupSequence.ts` | ~410 |
| 7c.6 | I          | `src/platform/main/defaultAction/dispatch.ts` | ~150 |

**Validação por sub-fase:** build + smoke + `bootSnapshot.test.ts` +
typecheck (net ≤0 vs entrada) + commit isolado.

---

## Projeção & margem

| Etapa | Δ linhas | Total estimado |
|---|---|---|
| Entrada Fase 7 | — | 2711 |
| Pós 7a | −230 | 2481 |
| Pós 7b | −170 | 2311 |
| Pós 7c | −1530 | **~780** |

**~180 linhas acima da meta.** Margens para fechar <600:

1. Mover `_pending*` slots inteiramente para `bootContext.ts` (−30)
2. Extrair construção de `sessionConfig`/`resumeContext` da dispatch para helper dedicado (−60)
3. Extrair MCP enterprise + KAIROS channels parsing como módulo próprio (−80)
4. Consolidar imports via re-export barrels nos novos módulos (−50)

**Trajetória realista:** **~560 linhas**.

---

## Riscos & mitigações

| Risco | Mitigação |
|---|---|
| **Profile checkpoint reordering** quebra `bootSnapshot.test.ts` | Manter `profileCheckpoint(...)` calls no callsite original; helpers não chamam checkpoints |
| **Closure-shared mutables** entre blocos | `ActionContext { ref }` boxes — padrão validado em 5b/5c |
| **Commander type inference quebrada** ao partir cadeia | Tipo manual no callsite + retornar `program` intermediário; `.action()` signature intacta |
| **Volume de commits** (~9 sub-fases) | Quebrar em **3 PRs** independentes (ver abaixo) |
| **Surface pública de `startDeferredPrefetches`** (consumida por `interactiveHelpers.tsx`) | Re-export onde está hoje; ou atualizar imports (mecânico, zero runtime impact) |
| **Telemetria opt-in/out preservada** | `bun run verify:privacy` rodado em cada PR antes de merge |

---

## Estratégia de PR

Três PRs sequenciais (cada uma rebaseada em cima da anterior; permite
rollback isolado):

### PR 1 — Fase 7a + 7b  (~400 linhas movidas, 3 commits)
Mecânico, baixo risco. Mexe em `main()` + `run()` (sem tocar `.action()`).

### PR 2 — Fase 7c.1–7c.3  (~1080 linhas, 3 commits)
Núcleo: options + MCP + setup/agent. Maior risco de regressão
runtime (parsing/validação) — exige roteiro manual de smoke
(diversos cenários: `-p`, `--resume`, KAIROS, SSH_REMOTE,
worktree, teammate).

### PR 3 — Fase 7c.4–7c.6  (~670 linhas, 3 commits)
Fecha meta <600 linhas. Foco em trust/onboarding/dispatch
(branches já isoladas nas Fases 5b/5c).

---

## Pré-PR checklist (em cada PR)

- [ ] `bun run build`
- [ ] `bun run smoke`
- [ ] `bun test src/platform/main/__tests__/bootSnapshot.test.ts`
- [ ] `bun test src/platform/main/__tests__/` (suite completa do split)
- [ ] `bun run typecheck` (net Δerros ≤ 0 vs entrada)
- [ ] `bun run verify:privacy` (PR 2 e PR 3 — tocam telemetria adjacente)
- [ ] `wc -l src/platform/main.tsx` reportado no PR description
- [ ] Smoke manual de pelo menos 2 branches do default action por PR

---

## Estado final esperado

```
src/platform/main.tsx               ~560 linhas (de 4379 originais, −87%)
src/platform/main/                  ~33 módulos
src/platform/main/action/           6 módulos novos (Fase 7c)
src/platform/main/argvPreparse.ts   novo (Fase 7a)
src/platform/main/clientType.ts     novo (Fase 7a)
src/platform/main/preActionHook.ts  novo (Fase 7b)
src/platform/main/rootOptions.ts    novo (Fase 7b)
src/platform/main/registerSubcommands.ts  novo (Fase 7b)
```

**ROADMAP 11g concluído** após Fase 7.
