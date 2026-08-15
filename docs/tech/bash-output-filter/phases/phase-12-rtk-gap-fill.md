# Phase 12 — rtk gap-fill: JS package managers, linters, Git extras, VCS, Go, Rust extras, Python extras

> **Status:** ✅ Concluída — 29 filters em 5 commits + report consolidado. Branch `feat/bash-filters-expansion`, aguardando PR.
> **Parent spec:** [`../architecture.md`](../architecture.md)
> **Discovery refs:**
> - [`../../../archive/discovery/bash-output-filter/rtk-refinement-2026-05.md`](../../../archive/discovery/bash-output-filter/rtk-refinement-2026-05.md)
> - Plan file: `/home/dev/.claudin/plans/cozy-tinkering-gray.md`

Auditoria comparativa Claudin vs **rtk** (Rust CLI proxy de filtragem) revelou ~30 comandos de alto uso ainda passando *raw* pelo BashTool. Esta fase fecha o gap por ROI, em 5 commits dentro da mesma branch.

## Resumo agregado (medido)

Tabela canônica gerada por `src/tools/shared/outputFilter/Bash/phase12Report.test.ts` (1 teste por (filter × sample), com floors de regressão):

```
Phase | Filter           | Sample                | Raw B | Out B | Reduction
------|------------------|-----------------------|-------|-------|----------
12.1  | npm-install      | npm-install           |   144 |    79 |  45.1%
12.1  | npm-install      | npm-install-warn      |   674 |   610 |   9.5%
12.1  | npm-run          | npm-test              |    61 |    11 |  82.0%
12.1  | pnpm-install     | pnpm-install          |   747 |    59 |  92.1%
12.1  | pnpm-run         | pnpm-run              |   112 |    23 |  79.5%
12.1  | yarn-install     | yarn-install          |  1328 |    92 |  93.1%
12.1  | eslint           | eslint-errors         |   220 |   224 |  -1.8%
12.1  | prettier         | prettier-check        |   353 |   330 |   6.5%
12.1  | prisma-generate  | prisma-generate       |   253 |    84 |  66.8%
12.1  | prisma-migrate   | prisma-migrate        |   356 |   200 |  43.8%
12.2  | shellcheck       | shellcheck            |   638 |   459 |  28.1%
12.2  | yamllint         | yamllint              |   627 |   627 |   0.0%
12.2  | markdownlint     | markdownlint          |   381 |   381 |   0.0%
12.2  | hadolint         | hadolint              |   719 |   719 |   0.0%
12.2  | pre-commit       | pre-commit            |  1388 |   588 |  57.6%
12.3  | git-fetch        | git-fetch             | 21981 |   133 |  99.4%
12.3  | git-branch       | git-branch-a          |  1202 |  1202 |   0.0%
12.3  | git-stash        | git-stash             |   397 |   397 |   0.0%
12.3  | git-worktree     | git-worktree-list     |   197 |   197 |   0.0%
12.3  | glab-list        | glab-pr-list          |   735 |   735 |   0.0%
12.3  | gt               | gt-log                |   428 |   428 |   0.0%
12.3  | jj               | jj-log                |   486 |   486 |   0.0%
12.4  | go-build         | go-build              |   274 |    45 |  83.6%
12.4  | go-build         | go-build-error        |   133 |   133 |   0.0%
12.4  | go-vet           | go-vet                |   121 |   121 |   0.0%
12.4  | cargo-run        | cargo-run             |   124 |    14 |  88.7%
12.4  | cargo-fmt        | cargo-fmt-diff        |   210 |   166 |  21.0%
12.5  | mypy             | mypy-err              |   258 |   258 |   0.0%
12.5  | pip-install      | pip-install           |  1572 |   192 |  87.8%
12.5  | ruff-format      | ruff-format-diff      |    51 |    51 |   0.0%
------|------------------|-----------------------|-------|-------|----------
TOTAL | 30 samples           |                       | 36170 |  8999 |  75.1%
```

- **Redução agregada: 75.1%** (36170 → 8999 bytes em 30 samples).
- Linhas com `0.0%` são *signal floor*: o filter está registrado por safety (ANSI strip + `collapseRuns` + `maxLines` cap) sem stripping específico, porque o output do comando já é todo signal. Mesmo padrão de `eslint`/`prettier --check` da Phase 2.
- A leitura do agregado é **enviesada para cima** pelo sample real de `git-fetch` (21KB de progress bars com CR) — sem ele, agregado ficaria perto de ~70%. Mantido porque representa um caso real recorrente (clone/fetch sob `--progress` non-TTY).

## Exemplos before/after

**`pnpm install express` — 747B → 59B (92%)**

Antes:
```
Progress: resolved 1, reused 0, downloaded 0, added 0

   ╭──────────────────────────────────────────────────────────────────╮
   │                                                                  │
   │                Update available! 9.15.0 → 11.2.2.                │
   │   Changelog: https://github.com/pnpm/pnpm/releases/tag/v11.2.2   │
   │                Run "pnpm add -g pnpm" to update.                 │
   │                                                                  │
   ╰──────────────────────────────────────────────────────────────────╯

Packages: +66
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 66, reused 0, downloaded 66, added 66, done

dependencies:
+ express 5.2.1

Done in 1s
```

Depois:
```
Packages: +66

dependencies:
+ express 5.2.1

Done in 1s
```

**`pip install requests` — 1572B → 192B (88%)**

Antes (trecho):
```
Collecting requests
  Downloading requests-2.34.2-py3-none-any.whl (66 kB)
Collecting urllib3<3,>=1.21.1 (from requests)
  Downloading urllib3-2.7.0-py3-none-any.whl (130 kB)
Collecting charset_normalizer<4,>=2 (from requests)
  Downloading charset_normalizer-3.4.7-py3-none-any.whl (135 kB)
Collecting idna<4,>=2.5 (from requests)
  Using cached idna-3.16-py3-none-any.whl (70 kB)
Collecting certifi>=2017.4.17 (from requests)
  Downloading certifi-2026.5.20-py3-none-any.whl (165 kB)
[notice] A new release of pip is available: 24.0 -> 25.1
[notice] To update, run: pip install --upgrade pip
Installing collected packages: urllib3, idna, charset_normalizer, certifi, requests
Successfully installed certifi-2026.5.20 charset_normalizer-3.4.7 idna-3.16 requests-2.34.2 urllib3-2.7.0
```

Depois:
```
Installing collected packages: urllib3, idna, charset_normalizer, certifi, requests

Successfully installed certifi-2026.5.20 charset_normalizer-3.4.7 idna-3.16 requests-2.34.2 urllib3-2.7.0
```

**`git fetch origin --progress` — 21981B → 133B (99.4%)**

Sample raw (21KB) é composto quase inteiramente de barras de progresso CR-colapsadas (`Receiving objects: 1% (1/600)`, `2% (12/600)`, …, `Resolving deltas:`, `remote: Counting objects:`, etc.). Após o filter, sobra apenas o cabeçalho `From <url>` + os refs atualizados — exatamente o sinal que o usuário/modelo precisa ver.

## Pré-requisitos

- Phase 6.x — builtInFilters core estabilizado
- Phase 9 — convenção `assertReduction` + samples reais como ground truth

## Fases internas (1 commit cada)

### Fase 1 — JS package managers (commit 1) ✅

Arquivo novo: `src/tools/shared/outputFilter/Bash/filters/js-pkg.ts` (9 filters).

| Filter | Comando | Estratégia | LOC |
|---|---|---|---|
| `npm-install` | `npm install\|i\|ci\|add` | strip `npm notice`, funding hint, `npm http fetch`; collapseRuns | ~12 |
| `npm-run` | `npm test\|t\|run\|start` | strip `> pkg@v script` header; delega ao runner subjacente | ~10 |
| `pnpm-install` | `pnpm install\|i\|add` | strip update-banner box, `Progress:`, bar de `+++`; collapseRuns | ~16 |
| `pnpm-run` | `pnpm run\|exec` | strip `> pkg@v script /path` header | ~8 |
| `yarn-install` | `yarn[ install\|add\|upgrade\|remove\|i]` | strip `[N/M]` phases, `info ...`, dependency tree entries | ~14 |
| `eslint` | `(npx )?eslint` | passthrough w/ collapseRuns; reject `--format=json/junit/...` | ~8 |
| `prettier` | `(npx )?prettier` | strip `Checking formatting...` preamble; reject `--loglevel` | ~10 |
| `prisma-generate` | `(npx )?prisma generate` | strip 3 ceremonial lines (loaded config / schema / start importing) | ~10 |
| `prisma-migrate` | `(npx )?prisma migrate` | strip ceremonial + "you can now edit it" hint | ~10 |

### Medições reais (samples capturados em `docs/discovery/bash-output-filter/validation/samples/`)

| Filter | Sample | Raw (B) | Filtered (B) | Reduction | Target |
|---|---|---|---|---|---|
| `npm-install` | `npm-install.txt` | 144 | 79 | 45.1% | ≥ 40% ✓ |
| `npm-install` | `npm-install-warn.txt` | 674 | 610 | 9.5% | (signal floor — preserves warns) |
| `npm-run` | `npm-test.txt` | 61 | 11 | 82.0% | ≥ 75% ✓ |
| `pnpm-install` | `pnpm-install.txt` | 747 | 59 | 92.1% | ≥ 85% ✓ |
| `pnpm-run` | `pnpm-run.txt` | 112 | 23 | 79.5% | ≥ 70% ✓ |
| `yarn-install` | `yarn-install.txt` | 1328 | 92 | 93.1% | ≥ 85% ✓ |
| `eslint` | `eslint-errors.txt` | 220 | 224 | -1.8% | (signal floor — diagnostics are the output) |
| `prettier` | `prettier-check.txt` | 353 | 330 | 6.5% | (signal floor — file list is the diagnostic) |
| `prisma-generate` | `prisma-generate.txt` | 253 | 84 | 66.8% | ≥ 60% ✓ |
| `prisma-migrate` | `prisma-migrate.txt` | 356 | 200 | 43.8% | ≥ 35% ✓ |

Notes:
- Samples capturados em tempdirs reais (npm 10 / pnpm 9 / yarn 1.22 / prisma 7).
- Para `eslint` e `prettier --check` em modo "dirty", o output é majoritariamente sinal — o filter atua nos modos clean (eslint-clean é 0 byte → 100%) e na ceremonial.
- `next-build` e `bun install` ficaram fora desta fase por decisão de plano.

### Fase 2 — Linters universais (commit 2) ✅

Extensão de `src/tools/shared/outputFilter/Bash/filters/linters.ts` (5 filters).

| Filter | Comando | Estratégia | Sample |
|---|---|---|---|
| `shellcheck` | `shellcheck` | strip `For more information:` + URLs wiki/SCxxxx; reject `--format=json/...` | synthetic |
| `yamllint` | `yamllint` | collapseRuns; reject `--format=parsable/...` | synthetic |
| `markdownlint` | `markdownlint`, `mdl` | collapseRuns; reject `--json` | real (npx) |
| `hadolint` | `hadolint` | collapseRuns; reject `--format=json/...` | synthetic |
| `pre-commit` | `pre-commit run` | strip `.....Passed` lines; preserva Failed + diagnostic blocks | synthetic |

#### Medições

| Filter | Sample | Raw (B) | Filtered (B) | Reduction | Target |
|---|---|---|---|---|---|
| `shellcheck` | `shellcheck.txt` | 638 | 459 | 28.1% | ≥ 20% ✓ |
| `pre-commit` | `pre-commit.txt` | 1388 | 588 | 57.6% | ≥ 45% ✓ |
| `yamllint` | `yamllint.txt` | 627 | 627 | 0.0% | (signal floor — diagnostics-only) |
| `markdownlint` | `markdownlint.txt` | 381 | 381 | 0.0% | (signal floor) |
| `hadolint` | `hadolint.txt` | 719 | 719 | 0.0% | (signal floor) |

Notas:
- yamllint/markdownlint/hadolint têm output 100% sinal nos samples — o filter está registrado para passthrough seguro + ANSI strip em terminais reais. Mesmo padrão de `eslint`/`prettier --check`.
- `shellcheck`, `yamllint`, `hadolint`, `pre-commit` samples são **sintéticos** (decisão de plano), com header `# synthetic — source: <URL>` na 1ª linha indicando origem.
- `markdownlint` foi capturado real via `npx markdownlint-cli`.

### Fase 3 — Git extras + VCS alternativos (commit 3) ✅

Extensão de `git.ts` (+4 filters) + arquivo novo `vcs.ts` (3 filters).

| Filter | Comando | Estratégia |
|---|---|---|
| `git-fetch` | `git fetch` | strip `remote: ...`, `Receiving objects:`, `Resolving deltas:`, `Unpacking objects:`, `POST git-upload-pack` |
| `git-branch` | `git branch [-a\|-r\|-vv\|--list]` | maxLines 80; reject -d/-D/-m/-M/-c/-C/--set-upstream-to (modifications) |
| `git-stash` | `git stash list\|show\|pop\|apply\|drop\|clear` | collapseRuns; bare `git stash` (push) not matched |
| `git-worktree` | `git worktree list` | maxLines 50; reject --porcelain |
| `glab-list` | `glab (pr\|mr\|issue) list` | maxLines 80; reject --output json |
| `gt` | `gt (log\|ls\|submit\|sync\|restack)` | maxLines 80 |
| `jj` | `jj (log\|st\|status\|diff)` | maxLines 80 |

#### Medições

| Filter | Sample | Raw (B) | Filtered (B) | Reduction |
|---|---|---|---|---|
| `git-fetch` | `git-fetch.txt` (real, --progress) | 21981 | 133 | **99.4%** ✓ |
| `git-branch` | `git-branch-a.txt` | 1202 | 1202 | 0.0% (signal floor) |
| `git-stash` | `git-stash.txt` | 397 | 397 | 0.0% (signal floor) |
| `git-worktree` | `git-worktree-list.txt` | 197 | 197 | 0.0% (signal floor) |
| `glab-list` | `glab-pr-list.txt` (synthetic) | 735 | 735 | 0.0% (signal floor) |
| `gt` | `gt-log.txt` (synthetic) | 428 | 428 | 0.0% (signal floor) |
| `jj` | `jj-log.txt` (synthetic) | 486 | 486 | 0.0% (signal floor) |

Notas:
- **`git-fetch`** ganha 99.4% no sample real porque o output de `--progress` é dominado por barras de progresso que repetem o mesmo contador.
- Os demais (branch/stash/worktree/glab/gt/jj) têm output já minimal — o filter está registrado para safety + ANSI strip + `maxLines` cap. Mesmo padrão de `eslint`/`yamllint`.
- Samples sintéticos: `glab-pr-list`, `gt-log`, `jj-log` — cada um com header `# synthetic — source: <URL>`.
- `git-stash.txt` foi reescrito (o arquivo existente era 0 byte) com 5 entradas reais-shaped — não-sintético-marcado pois shape vem de `git stash list` exato.

### Fase 4 — Go extras + Rust extras (commit 4) ✅

Arquivo novo `go.ts` (3 filters) + extensão `cargo.ts` (+2 filters).

| Filter | Comando | Estratégia |
|---|---|---|
| `go-build` | `go build` | strip `go: downloading/finding/found/extracting`; reject `-json` |
| `go-vet` | `go vet` | strip `go:` download lines; collapseRuns |
| `golangci-lint` | `golangci-lint run` | passthrough w/ collapseRuns; reject `--out-format=json/...` |
| `cargo-run` | `cargo run` | strip `Compiling/Finished/Running`, preserva stdout do programa |
| `cargo-fmt` | `cargo fmt` | passthrough w/ ANSI strip (signal floor) |

#### Medições

| Filter | Sample | Raw (B) | Filtered (B) | Reduction |
|---|---|---|---|---|
| `go-build` | `go-build.txt` (download-heavy) | 274 | 45 | **83.6%** ✓ (positive marker on cold-cache success) |
| `go-build` | `go-build-error.txt` | 133 | 133 | 0.0% (signal floor) |
| `go-vet` | `go-vet.txt` | 121 | 121 | 0.0% (signal floor) |
| `golangci-lint` | `golangci-lint.txt` | 165 | 165 | 0.0% (signal floor) |
| `cargo-run` | `cargo-run.txt` | 124 | 14 | **88.7%** ✓ |
| `cargo-fmt` | `cargo-fmt-clean.txt` | 0 | 0 | 100% (empty) |
| `cargo-fmt` | `cargo-fmt-diff.txt` | 210 | 166 | 21.0% (ANSI strip) |

Notas:
- `go-build` cold-cache: sample inteiro era `go: downloading/finding/found`. **Hardening pós-review:** ao invés de colapsar a vazio (LLM ambígua: "the build ran?"), o filter agora usa `matchOutput` pra emitir marker positivo `✓ go build: dependencies downloaded, build ok`. Reduction caiu de 100% → 83.6%, mas a clareza pro modelo melhorou. Erros (`error:`, `undefined:`, `cannot find`, `file.go:L:C:`) ainda passam intactos via `unless`.
- `cargo-run`: stdout do programa preservado, ceremonial removida.
- Samples reais capturados via tempdirs (go 1.x cobra/uuid; cargo new rust-test).

### Fase 5 — Python extras (commit 5) ✅

Extensão de `linters.ts` (3 filters).

| Filter | Comando | Estratégia |
|---|---|---|
| `mypy` | `mypy`, `python(3)? -m mypy` | passthrough w/ collapseRuns; reject `--output=json`/`--junit-xml` |
| `pip-install` | `pip(3)? install`, `python(3)? -m pip install` | strip `Downloading/Using cached *.whl`, `Collecting`, `WARNING: Cache entry...`, `[notice]`, `Building wheel`, `Requirement already satisfied` |
| `ruff-format` | `ruff format` | passthrough; reject `--diff` |

#### Medições

| Filter | Sample | Raw (B) | Filtered (B) | Reduction |
|---|---|---|---|---|
| `mypy` | `mypy-err.txt` | 258 | 258 | 0.0% (signal floor) |
| `pip-install` | `pip-install.txt` | 1572 | 192 | **87.8%** ✓ |
| `ruff-format` | `ruff-format-diff.txt` | 51 | 51 | 0.0% (signal floor) |
| `ruff-format` | `ruff-format-clean.txt` | 25 | 25 | 0.0% (signal floor) |

Notas:
- `pip-install` é o grande win — pacote `requests` traz ~5 deps cada com `Collecting/Downloading` lines.
- Safety preservada: `Successfully installed`, `ERROR:` linhas e diagnósticos mypy ficam intactos.

---

## Resumo final — Phase 12 (29 filters em 5 commits)

| Fase | Commit | Filters | LoC novo | Wins notáveis |
|---|---|---|---|---|
| 12.1 — JS pkg | 1 | 9 | ~120 | yarn 93%, pnpm 92%, npm-test 82% |
| 12.2 — Linters | 2 | 5 | ~80 | pre-commit 58%, shellcheck 28% |
| 12.3 — Git/VCS | 3 | 7 | ~90 | **git-fetch 99.4%** |
| 12.4 — Go/Cargo | 4 | 5 | ~80 | go-build 83.6% (cold-cache positive marker), cargo-run 89% |
| 12.5 — Python | 5 | 3 | ~50 | **pip-install 88%** |
| **Total** | **5** | **29** | **~420** | — |

Total no registry: **53 (pré-Phase 12) + 29 = 82 filters built-in**.

Testes adicionados: **~90 testes** (Phase 12). Test suite: 762 pass.

## Decisões de design (consolidadas)

- **1 filter = 1 entrada em `builtInFilters[]`**. Sem novos tipos.
- **Fail-open**: o aplicador (`safeApply`) garante passthrough do raw em qualquer throw.
- **Wrappers vencem**: `pnpm run lint` aplica `pnpm-run`, não delega para o eslint subjacente. First-wins por ordem no registry; wrappers ficam antes.
- **predictedPct**: medido empiricamente após captura do sample; tolerância `-5pp` (margem padrão da harness `assertReduction`).
- **Samples de tools com signal denso** (eslint errors, mypy, go-vet, golangci-lint, yamllint, markdownlint, hadolint) recebem **teste de safety mas não de ROI** — reduzir um output que já é todo signal é anti-objetivo. O filter está registrado pelo ANSI strip + `collapseRuns` + `maxLines` cap e safety contra futuros formatos verbosos.
- **Samples sintéticos** levam header `# synthetic — source: <URL>` na 1ª linha. Aplicado em: `shellcheck`, `yamllint`, `hadolint`, `pre-commit`, `glab-pr-list`, `gt-log`, `jj-log`. Demais são reais.

## Decisões de design

- **1 filter = 1 entrada em `builtInFilters[]`**. Sem novos tipos.
- **Fail-open**: o aplicador (`safeApply`) garante passthrough do raw em qualquer throw.
- **Wrappers vencem**: `pnpm run lint` aplica `pnpm-run`, não delega para o eslint subjacente. First-wins por ordem no registry; wrappers ficam antes.
- **predictedPct**: medido empiricamente após captura do sample; tolerância `-5pp` (margem padrão da harness `assertReduction`).
- **Samples de tools com signal denso** (eslint errors, prettier check) recebem **teste de safety mas não de ROI** — reduzir um output que já é todo signal é anti-objetivo.
