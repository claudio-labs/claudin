# Branches do default action handler

> Sub-item da Fase 0 do ROADMAP 11g.
>
> Mapa exato das ramificações de alto nível dentro do default action
> registrado em `src/main.tsx:1005` (chamado quando o usuário roda
> `claudin [prompt]` sem subcomando).
>
> Base para a **Fase 5b**, que extrai cada branch para
> `src/main/defaultAction/<branch>.ts`.

---

## Anatomia do handler

```text
main.tsx:1005   .action(async (prompt, options) => {
                    profileCheckpoint('action_handler_start')
                    /* ~1700 linhas de setup compartilhado:
                       parsing de flags, system prompt, MCP config,
                       teammate, files, plugins, hooks, etc. */
                    profileCheckpoint('action_after_hooks')  // 3606
                    maybeActivateProactive(options)
                    maybeActivateBrief(options)
                    ⬇⬇⬇  cadeia if/else if/else terminal
                  })
```

A "cadeia terminal" começa após `action_after_hooks` (3606). Cada
branch é mutuamente exclusivo e termina o handler chamando
`runHeadless`, `launchRepl`, `launchResumeChooser`,
`processResumedConversation`, ou equivalente.

---

## Branches identificadas

Ordem **importa** (avaliada de cima para baixo; é a ordem real do
`if`/`else if`). Linhas referem-se ao source atual.

| # | Branch | Condição (em pseudo-código) | Início | Sai chamando | Destino do split |
|---|---|---|---|---|---|
| 1 | **print (headless)**       | `print === true`               | 2769 | `runHeadless()`                     | `defaultAction/print.ts` |
| 2 | **continue**               | `options.continue`              | 3030 | `launchRepl(...)`                   | `defaultAction/continue.ts` |
| 3 | **direct-connect (open)**  | `feature('DIRECT_CONNECT') && _pendingConnect?.url` | 3085 | conexão `cc://` → `launchRepl`     | `defaultAction/directConnect.ts` |
| 4 | **ssh remote**             | `feature('SSH_REMOTE') && _pendingSSH?.host`        | 3122 | proxy SSH → `launchRepl`           | `defaultAction/sshRemote.ts` |
| 5 | **assistant chat**         | `feature('KAIROS') && _pendingAssistantChat?.{sessionId,discover}` | 3188 | bridge attach                       | `defaultAction/assistantChat.ts` |
| 6 | **resume / from-pr / teleport / remote** | `options.resume \|\| options.fromPr \|\| teleport \|\| remote !== null` | 3284 | `launchResumeChooser` ou `processResumedConversation` | `defaultAction/resume.ts` |
| 7 | **default (interactive REPL)** | `else`                       | 3578 | `launchRepl(...)`                   | `defaultAction/interactive.ts` |

> **Observação:** o `print` (#1) entra ANTES da cadeia
> `continue / DIRECT_CONNECT / SSH_REMOTE / KAIROS / resume / else` —
> ele é dispatchado em um `if (print)` separado ~2700, não como
> `else if` da cadeia. Confirmar na Fase 5b qual a relação real (pode
> precisar de wrapper se o estado entre `print` e o resto for
> divergente).

---

## Setup compartilhado (NÃO entra em nenhum modo)

Tudo entre `action_handler_start` (1006) e `action_after_hooks` (3606)
é **invariante por branch**. Cai em duas categorias:

1. **Vai para `BootContext` (Fase 4)**: as ~35 variáveis listadas em
   `bootContext-fields.md`.
2. **Vira função em `lifecycle.ts` ou `helpers.ts` (Fases 1-2)**:
   `runMigrations`, `eagerLoadSettings`, `initializeEntrypoint`,
   etc., além de `extractTeammateOptions`, `loadSettingsFromFlag`.

Logo a Fase 5b NÃO duplica esse setup — cada módulo de branch recebe
o `BootContext` já construído.

---

## Gates de feature flag

Branches 3, 4, 5 dependem de flags **build-time** (`DIRECT_CONNECT`,
`SSH_REMOTE`, `KAIROS`). No build aberto atual (`scripts/build.ts`)
essas flags estão off, então:

- Os arquivos `defaultAction/directConnect.ts`,
  `defaultAction/sshRemote.ts`, `defaultAction/assistantChat.ts`
  **são extraídos mas viram dead-code no bundle final**, igual aos
  `_pending*` slots correspondentes hoje.
- O dispatch no `interactive.ts` (ou em uma função `dispatchModes`)
  continua usando `feature('...')` exatamente como `main.tsx` faz hoje.
- Nada de `require()` runtime novo — segue a regra de
  `typescript-patterns.md` (flags via `feature()` build-time).

---

## Ordem de extração proposta (Fase 5b)

ROI/risco crescente:

1. `print.ts` — branch mais isolada (sai imediatamente em
   `runHeadless`).
2. `continue.ts` — só toca `loadConversationForResume` +
   `processResumedConversation` + `launchRepl`. Padrão claro.
3. `resume.ts` — mesma família de `continue`, com sub-branches
   (`launchResumeChooser` vs `processResumedConversation` quando há
   sessionId). Extrair em commit próprio.
4. `directConnect.ts`, `sshRemote.ts`, `assistantChat.ts` — três
   commits separados, mesmo template (flag-gated, fluxo paralelo).
5. `interactive.ts` — branch terminal (`else { launchRepl(...) }`).
   **Último**, porque é o caminho default que o smoke gate exercita.

Cada commit:

```bash
bun run typecheck
bun run build
bun run smoke
./bin/claudin --help | diff - src/main/__tests__/__snapshots__/help.txt
bun test src/main/__tests__/bootSnapshot.test.ts
```

---

## Lista de verificação (executada na Fase 5b)

- [ ] Reconfirmar as linhas de início (o source pode ter mudado entre
      Fase 0 e Fase 5b).
- [ ] Garantir que nenhuma branch fala diretamente com `options.*` —
      tudo vem de `BootContext` (Fase 4 entregou isso).
- [ ] Cada arquivo de branch tem `export default async function ...`
      ou `export async function runXxxMode(ctx: BootContext): Promise<void>`.
- [ ] Smoke + provider tests + help diff verdes a cada commit.
- [ ] `process.exit()` mantido inline em cada branch (decisão fechada
      do plano).
