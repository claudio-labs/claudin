# Bash Output Filter — Technical Design

> **Status:** v1 spec rev 2 — pós-review aplicado. Pronta para implementação.
> **Discovery:** [`docs/archive/discovery/bash-output-filter/`](../../archive/discovery/bash-output-filter/) — fechado em 2026-05-05.

## Resumo de uma frase

`src/tools/shared/outputFilter/Bash/` é um módulo puro, fail-open e command-aware de compressão de saída — registry de ~20 `FilterSpec` escaneadas linearmente, chamadas de `BashTool.call()` pra (a) reescrever `input.command` antes do `runShellCommand` e (b) aplicar pipeline declarativo + prepend de markers `<bash-output-rewritten>`/`<bash-output-filtered>` diretamente no `result.stdout` — protegido por kill-switches via env var, defesas ReDoS (length cap + denylist + build-time scan) e o `toolResultSummarizer` existente (com extensão de 2 linhas em `isAlreadyCompacted`) como safety net.

## Documentos

| Arquivo | Conteúdo |
|---|---|
| [`architecture.md`](architecture.md) | **Spec v1 rev 2** (~900 linhas, 22 seções). Pós-review crítico aplicado — corrigiu 4 bloqueadores e 5 misalignments. |
| [`phases/`](phases/) | **8 phase docs** — uma por PR. Cada doc é self-contained: pré-requisitos, file changes line-by-line, tests, acceptance criteria, PR description template. Status global em [`phases/README.md`](phases/README.md). |

## Mudanças rev 1 → rev 2 (driven by review)

| Mudança | Razão |
|---|---|
| **Markers no `result.stdout`, não em `Out.filterMeta`** | Elimina mudança no zod schema + transcript-replay risk + fix automático do error-exit gap (review §"Misalignments #1, #2") |
| **Phase 0 nova**: estender `isAlreadyCompacted` no summarizer | Sem isso, output filtrado >8KB seria re-collapsed (review §"Misalignments #3") |
| **Drop `Promise.race` 200ms timeout** | Não interrompe sync regex backtracking — era teatro (review §"Misalignments #5") |
| **Drop `verb: string` field** | Linear scan de 20 filtros é sub-microsegundo; hash hashmap optimization deferida pra v2 |
| **Drop 4 arquivos** (safety/analytics/debug/parse) | Cada <30 LoC, single-digit callers — inline (review §"Over-engineering #2-6") |
| **Reusar `escapeXmlAttr`** de `src/shared/data/xml.ts` | Já existe, evita reinvenção (review §"Over-engineering #1") |
| **Reusar `collapseIdenticalRuns`/`collapseDigitTemplates`** de `toolResultSummarizer.ts` | Saves ~80 LoC duplicação (review §"Over-engineering #3") |
| **Tests colocados** ao invés de `__tests__/` | Viola `.claudin/rules/testing.md` (review §"Misalignments #7") |
| **Config keys flat** (`bashOutputFilterEnabled`) | Match `toolResultSummarizerEnabled` precedent (review §"Missed conventions #4") |
| **Drop `extractBaseCommand` reuse claim** | Função é private + não tem redaction (review §"Misalignments #4") |
| **Single integration harness**, não per-filter test files | Duplica assertions (review §"Testing strategy") |
| **Drop ruff/cargo/kubectl rewrite v1** | Requer JSON parsing — move pra v2 native parsers |
| **`logError` 1-arg** | Match assinatura real em `src/shared/log.ts:159` (review §"Misalignments #6") |
| **Mention `processToolResultBlock` test surface** | Coverage gap (review §"Recommended changes #14") |

## Sequenciamento de PRs (rev 2)

7 PRs, cada um shippable atrás de `bashOutputFilterEnabled: false`:

| Phase | Conteúdo | LoC |
|---|---|---|
| **0** | Plumbing — extend `isAlreadyCompacted` + register config keys + export collapse helpers | ~10 |
| **1** | Skeleton + harness port + redos scan | ~700 |
| **2** | Built-in batch 1 (10 highest-ROI filters) | ~400 |
| **3** | BashTool integration (pipeline only) | ~30 |
| **4** | Rewrite layer + 5 rewrite filters (git-log/status/gh) | ~150 |
| **5** | Built-in batch 2 (git family, docker, network, journalctl) | ~250 |
| **6** | User filters via JSON + zod | ~290 |
| **7** | Default-on flip | ~3 |

**Total:** ~1.295 produção + ~910 test = **~2.200 LoC** (vs rev 1: ~4.675 — corte de **~53%**).

## v1 Rewrite filters (5)

Reduzido de 6 (rev 1) → 5 após review. JSON-parsing rewrites movem pra v2:

- ✅ `git log` — força `--oneline`
- ✅ `git status` — força `--porcelain --branch`
- ✅ `gh pr list` / `gh issue list` / `gh run list` — força `--json` + format

Movidos pra v2 (precisam native parser):
- `ruff check --output-format=json`
- `cargo build --message-format=json`
- `kubectl get -o json`

## Decisões arquiteturais centrais (rev 2)

1. **Plug em `BashTool.call()`** — filter precisa command + is_error
2. **Markers vão direto pro `result.stdout`** — survive both error and success paths automaticamente
3. **Pipeline puro de 11 estágios** — port de `validation/pipeline.ts`, reusa helpers do summarizer
4. **Registry com linear scan** — sub-microsegundo, dominado por regex cost mesmo
5. **Filter specs = object literals em TS** — uma família por arquivo (~10 arquivos × ~60 LoC)
6. **User filters via JSON + zod + ReDoS guards** (length cap + denylist + build-time scan)
7. **2 markers, open-tag style** (matching `<persisted-output>` precedent), `isAlreadyCompacted` extendido
8. **3 eventos de telemetria** com sufixo de privacidade
9. **Fail-open** com inline `safeApply` (não arquivo separado)
10. **Sem feature flag** — kill-switch via env var

## Acceptance criteria (rev 2)

- ✅ `bun run build` clean
- ✅ `bun test src/tools/shared/outputFilter/Bash` — 100% pass (single harness + 5 unit test files)
- ✅ `bun run verify:privacy` clean
- ✅ `scripts/regex-redos-scan.test.ts` — no denylisted patterns
- ✅ Smoke: 5 comandos com `CLAUDIN_BASH_FILTER_DEBUG=1`
- ✅ Compound: `git log -5 | wc -l` — no rewrite
- ✅ Error-exit: `cargo build` falha — rewrite marker shown (não pipeline)
- ✅ User filter `~/.claudin/filters.json` carrega + aplica
- ✅ Sandbox annotations preservadas em todos built-ins
- ✅ Coverage ≥ 80%
- ✅ `processToolResultBlock` test surface cobre filter+summarizer interaction

Detalhes completos em [`architecture.md` §21](architecture.md#21-acceptance-criteria-for-v1).
