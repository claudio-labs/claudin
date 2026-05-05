# Implementation phases — bash-output-filter v1

> **Parent spec:** [`../architecture.md`](../architecture.md) (rev 2)
> **Discovery:** [`../../../discovery/bash-output-filter/`](../../../discovery/bash-output-filter/)

8 PRs sequenciados, cada um shippable independentemente atrás de `bashOutputFilterEnabled: false` até Phase 7.

## Status global

| # | Fase | LoC | Status | Doc |
|---|---|---|---|---|
| 0 | Plumbing (isAlreadyCompacted + config keys + export helpers) | ~10 | ⏸ Not started | [`phase-0-plumbing.md`](phase-0-plumbing.md) |
| 1 | Skeleton + harness port + redos scan | ~700 | ⏸ Not started | [`phase-1-skeleton.md`](phase-1-skeleton.md) |
| 2 | Built-in batch 1 (10 highest-ROI filters) | ~400 | ⏸ Not started | [`phase-2-builtin-batch-1.md`](phase-2-builtin-batch-1.md) |
| 3 | BashTool integration (pipeline only) | ~30 | ⏸ Not started | [`phase-3-bashtool-integration.md`](phase-3-bashtool-integration.md) |
| 4 | Rewrite layer + 5 rewrite filters | ~150 | ⏸ Not started | [`phase-4-rewrite-layer.md`](phase-4-rewrite-layer.md) |
| 5 | Built-in batch 2 (git/docker/network/journalctl) | ~250 | ⏸ Not started | [`phase-5-builtin-batch-2.md`](phase-5-builtin-batch-2.md) |
| 6 | User filters via JSON + zod + ReDoS guards | ~290 | ⏸ Not started | [`phase-6-user-filters.md`](phase-6-user-filters.md) |
| 7 | Default-on flip + post-flip verification | ~3 | ⏸ Not started | [`phase-7-default-on.md`](phase-7-default-on.md) |

**Status legend:** ⏸ Not started | 🔄 In progress | ✅ Done | ⛔ Blocked

## Dependências entre fases

```
Phase 0 (plumbing) ────┐
                       ├─► Phase 3 (BashTool integration)
Phase 1 (skeleton) ────┘
       │
       └─► Phase 2 (filters batch 1) ─┐
                                      ├─► Phase 4 (rewrite layer) ─┐
       └─► Phase 5 (filters batch 2) ─┘                            │
                                                                   │
                                              Phase 6 (user) ──────┤
                                                                   │
                                                                   ▼
                                                         Phase 7 (default-on)
```

- **Phase 0** plumbing + **Phase 1** skeleton podem rodar em paralelo (não dependem entre si)
- **Phase 2** depende de Phase 1 (precisa do skeleton)
- **Phase 3** depende de Phase 0 + 1 (precisa do plumbing E do skeleton)
- **Phase 4** depende de Phase 3 (precisa do BashTool integration)
- **Phase 5** pode rodar em paralelo com Phase 4 (só adiciona mais filters)
- **Phase 6** depende de Phase 1 (precisa do skeleton + zod schema)
- **Phase 7** depende de TODAS as anteriores

## Como pickup uma fase

1. Ler [`../architecture.md`](../architecture.md) na íntegra (uma vez)
2. Ler o phase doc específico abaixo
3. Verificar pré-requisitos (fases anteriores done?)
4. Seguir o checklist de file changes do phase doc
5. Atualizar status do phase doc para 🔄 ao começar, ✅ ao terminar
6. Atualizar status nesta tabela

## Convenções dos phase docs

Cada phase doc segue o template:

```markdown
# Phase N — <título>

> Status: ⏸/🔄/✅/⛔
> LoC estimado: ~N
> PR: #N (preencher quando criado)

## Pré-requisitos
- [ ] Phase X done
- [ ] Phase Y done

## O que muda no codebase
Lista concreta de arquivos novos + arquivos modificados com line numbers.

## Steps
1. ...
2. ...

## Tests
Lista de tests novos/modificados + comando pra rodar.

## Acceptance criteria
Subset do §21 do architecture.md aplicável a esta fase.

## PR description template
Snippet pronto pra usar.

## Implementation notes
(Preenchido durante/após execução — desvios da spec, aprendizados, decisões em runtime.)
```
