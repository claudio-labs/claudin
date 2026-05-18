# BootContext — campos compartilhados de `run()`

> Sub-item da Fase 0 do ROADMAP 11g (split de `src/main.tsx`).
>
> Inventário das variáveis que vivem hoje na closure léxica da função
> default-action (a partir de `src/main.tsx:1005`) e dos 3 slots
> top-level mutáveis. Todas viram **campos do `BootContext`** quando a
> Fase 4 do split for executada — o objetivo é tornar explícita a
> superfície que cada modo (Fase 5b) precisa receber.
>
> **NÃO mexer no comportamento.** Este documento é estrutural; cada
> campo aqui já existe em `main.tsx` hoje.

---

## 1) Slots top-level mutáveis (linhas 542 – 578)

Atribuídos pela parsing precoce de argv (ainda fora de `run()`), lidos
pelas branches dos respectivos modos:

| Campo | Tipo | Gate | Fonte | Consumido em |
|---|---|---|---|---|
| `pendingConnect`     | `PendingConnect \| undefined`       | `DIRECT_CONNECT` | `main.tsx:542` | branches `server` / `open` (3790 / 3887) |
| `pendingAssistantChat` | `PendingAssistantChat \| undefined` | `KAIROS`         | `main.tsx:553` | branch `assistant` (4163) |
| `pendingSSH`         | `PendingSSH \| undefined`           | `SSH_REMOTE`     | `main.tsx:571` | branch `ssh` (3874) |

Na Fase 4: viram `ctx.pending.{connect, assistantChat, ssh}` (mantém
`undefined` quando flag off — semântica idêntica).

---

## 2) Locais do default action (a partir de `main.tsx:1005`)

Agrupados por responsabilidade. Linhas indicativas (a re-validar quando
a Fase 4 for executada — o source pode ter mudado).

### 2.1) Flags / opções já extraídas de `options`

| Campo | Origem em `options` | Linha |
|---|---|---|
| `prompt`              | argumento posicional   | 1005 |
| `outputFormat`        | `options.outputFormat` | 1124 |
| `inputFormat`         | `options.inputFormat`  | 1125 |
| `verbose`             | `options.verbose ?? config.verbose` | 1126 |
| `print`               | `options.print`        | 1127 |
| `init` / `initOnly` / `maintenance` | flags diretas | 1128-1130 |
| `disableSlashCommands` | `options.disableSlashCommands` | 1133 |
| `agentsJson`          | `options.agents`       | 1113 |
| `agentCli`            | `options.agent`        | 1114 |

### 2.2) Worktree / TMUX

| Campo | Linha |
|---|---|
| `worktreeOption` (raw) | 1140 |
| `worktreeName`         | 1143 |
| `worktreeEnabled`      | 1144 |
| `worktreePRNumber`     | 1147 |
| `tmuxEnabled`          | 1157 |

### 2.3) Teammate / Kairos

| Campo | Linha |
|---|---|
| `kairosEnabled`        | 1047 |
| `assistantTeamContext` | 1048 |
| `storedTeammateOpts`   | 1179 |
| `teammateOpts` (parsed) | 1183 |
| `hasAnyTeammateOpt`    | 1187 |
| `hasAllRequiredTeammateOpts` | 1188 |

### 2.4) Files / downloads

| Campo | Linha |
|---|---|
| `fileDownloadPromise` | 1112 |
| `fileSpecs`           | 1298 |
| `fileSessionId`       | 1310 |

### 2.5) Session / SDK / remote

| Campo | Linha |
|---|---|
| `sdkUrl`                          | 1214 |
| `effectiveIncludePartialMessages` | 1219 |
| `teleport`                        | 1248 |
| `remoteOption` / `remote`         | 1253 / 1256 |
| `remoteControlOption` / `remoteControl` / `remoteControlName` | 1259 / 1266 / 1267 |
| `validatedSessionId`              | 1283 |
| `isNonInteractiveSession`         | 1331 |

### 2.6) System prompt

| Campo | Linha |
|---|---|
| `systemPrompt`       | 1340 |
| `appendSystemPrompt` | 1361 |
| `addendum` (teammate) | 1383 |

### 2.7) MCP

| Campo | Linha |
|---|---|
| `dynamicMcpConfig`  | 1411 |
| `processedConfigs`  | 1414 |
| `allConfigs`        | 1415 |
| `allErrors`         | 1416 |

### 2.8) Misc / derivados (a confirmar na Fase 4)

| Campo | Linha aproximada |
|---|---|
| `taskListId`                       | 1136 |
| (… campos adicionais que aparecem depois de `1450`) | a auditar durante a Fase 4 |

> **Total inicial**: ~35 campos identificados. A contagem definitiva é
> apurada na Fase 4 lendo `run()` na íntegra — este documento é o
> ponto de partida, não a verdade final.

---

## 3) Princípios para o tipo `BootContext`

1. **Read-only por default** — usar `Readonly<>` em todos os campos
   que não precisam ser mutados depois da construção. Campos
   genuinamente mutáveis (`worktreeName`, `kairosEnabled`,
   `assistantTeamContext`, etc.) ficam fora do `Readonly`.
2. **Sem métodos** — só dados. Comportamento permanece nos módulos
   `commands/` e `defaultAction/`.
3. **Construção em uma única função** (`buildBootContext(options)`)
   chamada no topo do action handler. Substitui as 30+ declarações
   inline preservando ordem e semântica.
4. **Tipo sólido** — nada de `Record<string, any>`. Cada campo carrega
   seu tipo original (a maioria já existe em `main.tsx`).
5. **Gating preservado** — campos `pending.*` continuam `undefined`
   quando a feature flag está off (não emular truthy).

---

## 4) Não-objetivo (NÃO entra no `BootContext`)

- `program` (instância Commander) — fica local de `run()`, é detalhe
  de despacho.
- `profileCheckpoint` calls — continuam inline; `BootContext` não
  emite eventos.
- Slots derivados que só uma branch usa (ex.: `processedConfigs` só na
  validação MCP) — ficam locais ao módulo do modo correspondente
  depois da Fase 5b.

---

## 5) Lista de verificação (executada na Fase 4)

- [ ] Reler `main.tsx:1005-3720` e confirmar o multiset exato.
- [ ] Identificar campos que cruzam ≥2 branches (esses são
      obrigatórios no `BootContext`).
- [ ] Identificar campos que só uma branch usa (esses descem para o
      módulo da branch na Fase 5b).
- [ ] Validar que nenhuma branch escreve em campo declarado `readonly`.
- [ ] Smoke + provider tests verdes.
