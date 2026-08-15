# Phase 2 — Built-in batch 1 (10 highest-ROI filters)

> **Status:** ⏸ Not started
> **LoC estimado:** ~400
> **PR:** _(preencher)_
> **Parent spec:** [`../architecture.md` §4, §17](../architecture.md)

Implementa os 10 filters de maior ROI medido empiricamente no discovery. Sem rewrite (vem em Phase 4). Cada filter tem assertion no harness garantindo ROI ≥ predicted-5pp.

## Pré-requisitos

- [ ] Phase 1 done (skeleton + harness)
- ~~Phase 0~~ (não bloqueia, mas idealmente done)

## Filters incluídos (10 specs em 7 family files)

| Filter | ROI medido | Família file | Estratégia dominante |
|---|---|---|---|
| `bundle install` | **96%** | `pkg.ts` | M (`✓ Bundle complete`) |
| `pytest` (clean) | **95%** | `tests.ts` | M (`✓ all tests passed`) |
| `ps aux` | **93%** | `system.ts` | P (strip kthreads + maxLines: 50) |
| `rubocop` | **83%** | `linters.ts` | P (strip "new cops" preamble) |
| `go test -v` | **82%** | `tests.ts` | P+M (strip RUN/PASS + match_output) |
| `ls -la` | **81%** | `ls.ts` | P (replace drwx/owner/date) |
| `rspec` (clean) | **73%** | `tests.ts` | M (`✓ all tests passed`) |
| `top -bn1` | **52%** | `system.ts` | P (strip kernel threads via VIRT=0) |
| `cargo build/check` | **55-64%** | `cargo.ts` | P+M (strip Compiling + match Finished) |
| `cargo test` (all-pass) | **95%** | `cargo.ts` | P+M |
| `cargo clippy` | ~0% (warnings = signal) | `cargo.ts` | passthrough natural |
| `ruff check` (clean) | **11%** (M apenas) | `linters.ts` | M (`✓ ruff: all clean`) |
| `grep -rn` (paths abs) | **33%** | `grep-rg.ts` | P (replace path → relative) |

**Total: ~14 specs em 7 family files.** A contagem de "10 filters" no spec é aproximada; alguns family files agrupam variantes próximas (cargo build/check/test/clippy compartilham 80% do regex).

## O que muda no codebase

### Arquivos novos

| Arquivo | LoC est. | Specs |
|---|---|---|
| `src/tools/shared/outputFilter/Bash/filters/pkg.ts` | ~50 | `bundleInstall` |
| `src/tools/shared/outputFilter/Bash/filters/tests.ts` | ~120 | `pytest`, `rspec`, `goTest` |
| `src/tools/shared/outputFilter/Bash/filters/system.ts` | ~80 | `psAux`, `top` |
| `src/tools/shared/outputFilter/Bash/filters/linters.ts` | ~60 | `rubocop`, `ruffCheck` (passthrough+M) |
| `src/tools/shared/outputFilter/Bash/filters/ls.ts` | ~40 | `lsLa` |
| `src/tools/shared/outputFilter/Bash/filters/grep-rg.ts` | ~30 | `grepRg` |
| `src/tools/shared/outputFilter/Bash/filters/cargo.ts` | ~100 | `cargoBuild`, `cargoCheck`, `cargoTest`, `cargoClippy` |

### Arquivos modificados

| Arquivo | Mudança | LoC |
|---|---|---|
| `src/tools/shared/outputFilter/Bash/filters/index.ts` | Importar e exportar todos os specs no array `builtInFilters` | +14 |
| `src/tools/shared/outputFilter/Bash/bashFilter.test.ts` | Trocar inline filter definitions nos `CASES[]` para imports dos specs reais | (replace ~14 entries) |
| `scripts/regex-redos-scan.test.ts` | Não muda (auto-detecta novos arquivos) | n/a |

## Steps

Para cada filter, seguir o template:

1. **Identificar família** — adicionar a um arquivo existente da família ou criar novo se a família é nova
2. **Escrever spec object literal** baseado em [`../architecture.md` §4](../architecture.md#4-filter-spec-syntax--the-authoring-shape)
3. **Module-level regex consts** (typescript-patterns.md regra 3)
4. **Importar e re-exportar de `filters/index.ts`**
5. **Trocar test case inline por import real** em `bashFilter.test.ts`
6. **Rodar `bun test src/tools/shared/outputFilter/Bash`** e confirmar ROI ≥ predicted-5pp

### Specs concretos

Os filter specs são portados das discovery files. Para cada:

- **`pkg.ts:bundleInstall`** — usar regex e match_output documentados em [`../../../archive/discovery/bash-output-filter/validation/validate.ts`](../../../archive/discovery/bash-output-filter/validation/validate.ts) (case "bundle install")
- **`tests.ts:pytest`** — usar [`../../../archive/discovery/bash-output-filter/commands/pytest.md`](../../../archive/discovery/bash-output-filter/commands/pytest.md) + validate.ts case "pytest (clean)"
- **`tests.ts:rspec`** — validate.ts case "rspec (clean)"
- **`tests.ts:goTest`** — [`../../../archive/discovery/bash-output-filter/commands/go-test.md`](../../../archive/discovery/bash-output-filter/commands/go-test.md) + validate.ts case
- **`system.ts:psAux`** — [`../../../archive/discovery/bash-output-filter/commands/ps-aux.md`](../../../archive/discovery/bash-output-filter/commands/ps-aux.md)
- **`system.ts:top`** — [`../../../archive/discovery/bash-output-filter/commands/top.md`](../../../archive/discovery/bash-output-filter/commands/top.md)
- **`linters.ts:rubocop`** — validate.ts case "rubocop (preamble dominate)"
- **`linters.ts:ruffCheck`** — [`../../../archive/discovery/bash-output-filter/commands/ruff-check.md`](../../../archive/discovery/bash-output-filter/commands/ruff-check.md)
- **`ls.ts:lsLa`** — [`../../../archive/discovery/bash-output-filter/commands/ls.md`](../../../archive/discovery/bash-output-filter/commands/ls.md)
- **`grep-rg.ts:grepRg`** — [`../../../archive/discovery/bash-output-filter/commands/grep-rg.md`](../../../archive/discovery/bash-output-filter/commands/grep-rg.md)
- **`cargo.ts:cargoBuild/check/test/clippy`** — [`../../../archive/discovery/bash-output-filter/commands/cargo-build.md`](../../../archive/discovery/bash-output-filter/commands/cargo-build.md) e [`cargo-test.md`](../../../archive/discovery/bash-output-filter/commands/cargo-test.md)

## Tests

```bash
bun test src/tools/shared/outputFilter/Bash
# Espera 67/67 harness cases passing (todos os specs Phase 2 + os Phase 5 ainda mockados)
bun test scripts/regex-redos-scan.test.ts
# Espera pass — nenhum dos novos regex no denylist
bun run typecheck
```

## Acceptance criteria

- [ ] 10+ specs implementados em 7 family files
- [ ] Cada spec passa harness assertion `reductionPct >= predicted - 5` no seu sample
- [ ] `regex-redos-scan.test.ts` passa para todos os novos regex
- [ ] Módulo continua dead code (BashTool integration é Phase 3)
- [ ] Coverage do módulo ≥80%
- [ ] `bun run build` clean

## PR description template

```markdown
## feat(bash-filter): built-in filters batch 1 — 10 highest-ROI commands (Phase 2)

Implements 10 filter specs across 7 family files for the highest-ROI bash commands measured during discovery.

### Filters added (ROI in parens, all measured)
- `bundle install` (96%), `pytest` (95%), `ps aux` (93%), `rubocop` (83%), `go test -v` (82%)
- `ls -la` (81%), `rspec` (73%), `top -bn1` (52%), `cargo build/check/test/clippy` (55-95%)
- `grep -rn` paths absolute (33%), `ruff check` clean (11% via match_output)

### Module is still dead code
This PR only adds filter specs to the registry. Phase 3 wires the registry into `BashTool.call()`.

### Tests
- All 10+ filters pass the integration harness with ROI ≥ predicted-5pp
- ReDoS scan passes for every new regex literal
- Coverage ≥80%

### Refs
- Spec: docs/tech/bash-output-filter/architecture.md §4
- Phase doc: docs/tech/bash-output-filter/phases/phase-2-builtin-batch-1.md
- Discovery measurements: docs/archive/discovery/bash-output-filter/optimization-matrix.md
```

## Implementation notes

_(Preencher durante/após execução.)_
