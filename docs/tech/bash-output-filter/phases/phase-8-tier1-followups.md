# Phase 8 — Tier-1 follow-ups: JS/TS toolchain, tsc, git diff/show, (Windows deferred)

> **Status:** ✅ Linux side done — 8 specs landed, harness + bench passing
> **LoC:** ~330 (filters: 5 jest/vitest/bun-test/mocha/playwright + tsc + 2 git extensions)
> **PR:** _(preencher)_
> **Parent spec:** [`../architecture.md`](../architecture.md)
> **Roadmap entry:** [6.2 — Bash output filter — tier-1 follow-ups](../../../../ROADMAP.md)

Expansão do bash-output-filter para os comandos de **maior frequência** numa sessão de coding agent que ainda não estavam cobertos pelo 6.1 — derivada de auditoria de gaps post-6.1 (ver `bench scripts/profile/bash-filter-gain.test.ts` + tabela em [`README.md`](../README.md#status)).

A lista de gaps original cobre Linux **e** Windows. Esta fase implementa **somente o lado Linux** (8 specs); Windows/PowerShell (Get-ChildItem, Get-Process, dotnet build/test, msbuild) fica documentado abaixo como sub-fase futura.

## Pré-requisitos

- [x] Phase 6.1.1 — skeleton + harness (precisa do `applyBashFilterToStdout` + `runFilterBody` do harness)
- [x] Phase 6.1.4 — rewrite layer (não usado aqui, mas o tipo `RewriteContext` é reaproveitado)
- [x] Phase 6.1.5 — git family (extendemos `git.ts`, não recriamos)

## Filters incluídos (8 specs em 3 arquivos)

| Filter | Comando | Família | Estratégia | ROI medido |
|---|---|---|---|---|
| **jest** | `jest`, `npx jest`, `yarn jest`, `pnpm jest` | `tests-js.ts` (NEW) | strip `RUNS  ` carousel + indented `✓` per-test lines; collapse on `Tests: N passed, N total` | **98.7%** |
| **vitest** | `vitest`, `npx vitest` | `tests-js.ts` | strip banner + indented `✓` lines; collapse on `Tests N passed (N)` | **98.5%** |
| **bun test** | `bun test [file…]` | `tests-js.ts` | strip banner + un-indented `✓` lines; collapse on `N pass\n0 fail` | **98.2%** |
| **mocha** | `mocha`, `npx mocha` | `tests-js.ts` | strip indented `✓` lines; collapse on `N passing (T)` | **97.6%** |
| **playwright** | `playwright test`, `npx playwright test` | `tests-js.ts` | strip indented `✓ N [project] › …` lines; collapse on `N passed (T)` | **98.4%** |
| **tsc** | `tsc`, `tsc --noEmit`, `npx tsc`, `yarn tsc` | `tsc.ts` (NEW) | strip ASCII `~~~` underline lines + trailing `Errors  Files` table | **18.2%** |
| **git diff** | `git diff [refs] [files]` | `git.ts` (EXTEND) | strip `diff --git a/X b/X` + `index <hash>..<hash>` + `\ No newline at end of file` lines | **10.8%** |
| **git show** | `git show [ref]` | `git.ts` (EXTEND) | mesma strip do git-diff + colapsa par `Author: Name <email>\nDate: ...` em uma linha | **9.4%** |

**Subtotal:** 5 test-runners JS/TS conseguem >97% colapsando para sentinela em runs limpos; tsc + git diff/show ficam em ~10–18% porque preservam o sinal de fato (erros, hunks, código). Nada-é-tudo: para git-diff/show o teto é a metadata + headers redundantes, já que o body do diff é deliberadamente preservado.

## O que muda no codebase

### Arquivos novos

| Arquivo | LoC | Specs |
|---|---|---|
| `src/outputFilter/Bash/filters/tests-js.ts` | ~140 | `jest`, `vitest`, `bunTest`, `mocha`, `playwright` |
| `src/outputFilter/Bash/filters/tsc.ts` | ~30 | `tsc` |
| `src/outputFilter/Bash/__fixtures__/samples/jest-clean.txt` | 60 lines | fixture |
| `src/outputFilter/Bash/__fixtures__/samples/vitest-clean.txt` | 50 lines | fixture |
| `src/outputFilter/Bash/__fixtures__/samples/bun-test-clean.txt` | 40 lines | fixture |
| `src/outputFilter/Bash/__fixtures__/samples/mocha-clean.txt` | 35 lines | fixture |
| `src/outputFilter/Bash/__fixtures__/samples/playwright-clean.txt` | 28 lines | fixture |
| `src/outputFilter/Bash/__fixtures__/samples/tsc-errors.txt` | 38 lines | fixture |
| (idem em `docs/discovery/bash-output-filter/validation/samples/`) | — | mirror — `bashFilter.test.ts` lê desse path |

### Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `src/outputFilter/Bash/filters/git.ts` | adiciona `gitDiff`, `gitShow` no final + 3 const regex (`GIT_DIFF_STRIP_HEADER`/`INDEX`/`NOEOL`) |
| `src/outputFilter/Bash/filters/index.ts` | importa + registra os 8 specs novos no `builtInFilters` (test-runners JS/TS antes dos single-word `jest`/`vitest`/`mocha` p/ ordem específica primeiro; git-diff/show no bloco git) |
| `src/outputFilter/Bash/__fixtures__/samples/git-diff.txt` | overwrite (era 0 bytes, agora 3.1 KB realista) |
| `src/outputFilter/Bash/bashFilter.test.ts` | + 8 `describe()` blocks no final do arquivo (1 por filter) — assertReduction + match positivo + reject + safety guards |
| `scripts/profile/bash-filter-gain.test.ts` | + 8 entradas no `SCENARIOS` array |

## Specs concretos

### tests-js.ts — pattern compartilhado

Os 5 test-runners seguem o mesmo formato de pytest/rspec/go-test (`tests.ts`):

```ts
const FOO_MATCH = /^(?:npx\s+|yarn\s+|pnpm\s+|bunx\s+)?foo\b/   // P|M
const FOO_PASSTHROUGH = /(?:^|\s)(?:--watch\b|...)/              // reject interactive modes
const FOO_STRIP_TEST_OK = /^\s+✓\s/                              // strip per-test lines
const FOO_OK = /^Tests:\s+\d+\s+passed,\s+\d+\s+total\s*$/m       // success sentinel
const FOO_HAS_PROBLEM = /\b(?:failed|FAIL\b|error)\b/             // safety guard

export const foo: FilterSpec = {
  name: 'foo',
  matchCommand: FOO_MATCH,
  matchCommandReject: FOO_PASSTHROUGH,
  stripAnsi: true,
  stripLinesMatching: [FOO_STRIP_TEST_OK],
  matchOutput: [{ pattern: FOO_OK, unless: FOO_HAS_PROBLEM, message: '✓ foo: all tests passed' }],
}
```

**Two-word verbs** (`bun test`, `playwright test`) precisam vir ANTES dos single-word (`bun`, `playwright`) no `builtInFilters` — porém aqui não há colisão porque não temos filtro `bun` standalone. Mantemos a ordem específica-primeiro como precaução.

**Safety:** o `unless` em todos os 5 specs barra o colapso quando `failed|FAIL|error` aparece — runs com falha mantêm output integral (incl. stack trace).

### tsc.ts — duas regras e nada mais

```ts
// Underline `~~~` sob preview de erro — visual-only, agente lê file:line:col diretamente.
const TSC_STRIP_UNDERLINE = /^\s*~+\s*$/

// Tabela `Errors  Files\n   N  path:line\n…` no final é redundante com a linha
// "Found N errors in M files." que já tem a contagem. Strip via replace global.
const TSC_STRIP_ERRORS_TABLE_RE =
  /\n\nErrors\s+Files\s*\n(?:\s*\d+\s+\S[^\n]*\n?)+/g
```

**Não tocamos:** mensagens de erro inline (`error TS2322:`), file:line:col, code preview. Em runs limpos tsc emite stdout vazio — `index.ts` já passa por isso sem aplicar marker (early return em `rawStdout === ""`).

### git.ts — extensão

```ts
const GIT_DIFF_STRIP_HEADER = /^diff --git\s+a\/\S+\s+b\/\S+$/   // redundante c/ --- a/X / +++ b/X
const GIT_DIFF_STRIP_INDEX  = /^index\s+[0-9a-f]+\.\.[0-9a-f]+(?:\s+\d+)?$/
const GIT_DIFF_STRIP_NOEOL  = /^\\ No newline at end of file$/

const GIT_SHOW_AUTHOR_DATE_RE =
  /^Author:\s+([^<\n]+?)\s*<[^>\n]+>\nDate:\s+(.+)$/m   // 2 linhas → "Author: Name (Date)"
```

`gitShow` reaproveita os 3 strip regex do `gitDiff` mais o replace de Author+Date. **Hunks (`@@`), linhas `+`/`-`, e `--- a/X` / `+++ b/X`** são preservados sempre.

**Rejeições deliberadas:**
- `git diff --stat`/`--shortstat`/`--name-only`/`--name-status`/`--check`/`--numstat`/`--summary` → output já é compacto, passthrough
- `git show --stat`/`--name-only`/`--no-patch`/`-s`/`--pretty`/`--format` → idem

## Tests

```bash
bun test src/outputFilter/Bash/bashFilter.test.ts          # +50 asserts em phase 6.2 blocks
bun test src/outputFilter/Bash                              # full suite — 306 pass / 71 skip
CLAUDIO_BENCH=1 bun test scripts/profile/bash-filter-gain.test.ts   # gain table — 31 filters total
bun run typecheck                                           # zero novos erros (TS errors pré-existentes não relacionados)
```

Cada `describe('phase 6.2 — <filter>')` cobre:
- **ROI** — `assertReduction` com target documentado
- **match positivo** — variantes (`npx`, `yarn`, `pnpm`, two-word forms)
- **reject** — passthrough modes (`--watch`, `--ui`, `--listFiles`, `--stat`, `-s`)
- **safety** — runs com falha não colapsam (test-runners) / hunks preservados (git-diff/show)
- **post-condition específica** — para tsc: `Errors  Files` ausente; para git-diff: `index` ausente, `@@` presente; para git-show: 1 linha `Author:`, 0 linhas `Date:`

## Acceptance criteria

- [x] 8 specs implementados, cada um com fixture realista
- [x] Cada spec passa `assertReduction` ≥ predicted-5pp
- [x] Test-runners JS/TS: safety guards (`unless`) cobrem `failed|FAIL|error`
- [x] git diff/show: hunks (`@@`), `+`/`-`, e headers `--- a/X`/`+++ b/X` nunca são tocados
- [x] tsc: file:line:col + códigos TS preservados em todos os erros
- [x] `regex-redos-scan.test.ts` passa (specs usam two-alternation forms onde aplicável)
- [x] Bench atualizado (`scripts/profile/bash-filter-gain.test.ts` mostra +8 linhas)
- [x] Zero regressões nos 23 specs existentes

## PR description template

```markdown
## feat(bash-filter): tier-1 follow-ups — JS/TS test runners + tsc + git diff/show (Phase 6.2)

Adds 8 filter specs covering the highest-frequency commands not yet hit by Phase 6.1:
JS/TS test runners (jest/vitest/bun-test/mocha/playwright), TypeScript compiler (tsc),
and git diff/show.

### Filters added
- **JS/TS test runners** (5): jest 98.7%, vitest 98.5%, bun test 98.2%, mocha 97.6%, playwright 98.4%
- **TypeScript compiler**: tsc 18.2% (strip `~~~` underlines + redundant `Errors  Files` table)
- **git diff/show**: 10.8% / 9.4% (strip `diff --git`, `index <hash>..<hash>`, `\ No newline at end of file`; collapse `Author: ... <email>\nDate: ...` pair on git-show)

### Notable details
- Test-runner success sentinels (`✓ jest: all tests passed`, etc.) reduce 1.5–1.9 KB clean runs to ~25 B
- `unless` guards (`failed|FAIL|error`) keep failed runs untouched — stack traces preserved
- git-diff/show hunks, `+`/`-` lines and `--- a/X / +++ b/X` headers always preserved
- tsc inline errors, TS codes and file:line:col always preserved

### Tests
- 8 new `describe('phase 6.2 — <filter>')` blocks, ~50 expect() calls
- All assertReduction targets met (within −5pp tolerance)
- Bench: 31 filters total, aggregate 71% reduction across full fixture corpus

### Refs
- Phase doc: docs/tech/bash-output-filter/phases/phase-8-tier1-followups.md
- Roadmap: 6.2 (Active)
```

## Sub-fase deferida — Windows / PowerShell

Não implementada nesta fase. Cobre os equivalentes Windows mais usados:

| Comando | Equivalente Linux já mapeado | Estratégia esperada |
|---|---|---|
| `Get-ChildItem` / `dir` | `ls -la` | strip Mode/LastWriteTime/Length cols, manter Name + tipo |
| `Get-Process` / `tasklist` | `ps aux` | strip Handles/NPM/PM/WS/CPU cols |
| `Get-Service` | (sem equiv) | strip Status header, manter Name + state |
| `Get-WinEvent` / `Get-EventLog` | `journalctl` | strip TimeCreated/ProviderName cabeçalhos |
| `dotnet build` | `cargo build` | strip `Restored…`/`Determining projects…` preamble + colapsar em `Build succeeded.` |
| `dotnet test` | `cargo test` | strip `Test execution time` + colapsar `Passed: N` |
| `msbuild` | `make` | strip `Project "X.csproj" on node N` + duplicates |

PowerShell tem 2 peculiaridades vs bash que precisam de spec antes de implementar:
1. **Output is tabular by default** com auto-format — strip de colunas requer detecção shape-aware (similar ao rewrite que fizemos pro `git status --porcelain`)
2. **Object pipeline** — quando o usuário faz `Get-Process | Where-Object …`, o output já vem filtrado pelo PS; nosso filtro precisa de um `matchCommandReject` p/ pipe operators (similar ao `hasCompound` que já temos pra bash)

**Recomendação:** abrir como Phase 9 (própria PR), depois de validar uso real em sessões Windows.

## Implementation notes

- **Two sample directories.** O harness (`bashFilter.test.ts:21`) lê de `docs/discovery/bash-output-filter/validation/samples/`, não de `src/outputFilter/Bash/__fixtures__/samples/`. Toda fixture nova precisa ser duplicada nos dois diretórios. (Causa pegou a primeira execução desta fase — 6 testes falharam porque só copiei pra `__fixtures__/`.)
- **`runFilterBody` vs `applyBashFilterToStdout`.** O helper de teste já strippa o `<bash-output-filtered>` wrapper antes de retornar — usar nos asserts. O `applyBashFilterToStdout` raw retorna com wrapper.
- **Bench fixture target ≠ test fixture target.** Reduzi `git-show` de 8% → 5% após medir; o teto real é a metadata (commit/Author/Date/index/diff--git lines), o body do diff é >95% do output e é preservado por design. Para um fixture com diff curtos a redução pode ir mais alto, mas 5% é o mínimo seguro.
- **Two-alternation forms.** `RSPEC_MATCH = /^rspec\b|^bundle\s+exec\s+rspec\b/` e similares são intencionais — evitam o flag REDOS_PATTERNS #5 (nested optional with quantifier). Não trocar por `^(?:bundle\s+exec\s+)?rspec\b`.
