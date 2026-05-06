# Phase 5 — Built-in batch 2 (git family, docker, network, journalctl)

> **Status:** ⏸ Not started
> **LoC estimado:** ~250
> **PR:** _(preencher)_
> **Parent spec:** [`../architecture.md` §17](../architecture.md)

Cobre o long-tail de filters validados empiricamente: git family completo (sem rewrite, P only), containers, network e journalctl. Pode rodar em paralelo com Phase 4 (são specs independentes).

## Pré-requisitos

- [ ] Phase 1 done (skeleton)
- ~~Phase 4~~ (não bloqueia — Phase 4 e 5 podem rodar em paralelo)

## Filters incluídos (~10 specs em 4 family files)

| Filter | ROI medido | Família | Estratégia |
|---|---|---|---|
| **git status** (P only, sem rewrite) | **26%** | `git.ts` | P (strip hints + replace headers) |
| **git log** (P only, sem rewrite) | **42%** | `git.ts` | P (strip Co-*, ## Summary, trailers) |
| **git blame** | **25%** | `git.ts` | P (replace `(Author Date Time TZ N)` → `(Date N)`) |
| **git pull** | **51%** (sintético) | `git.ts` | P (strip remote: progress lines) |
| **git add/commit/push** | M apenas | `git.ts` | M (`✓ ok abc1234`) |
| **docker ps -a** | **26%** | `containers.ts` | P (strip CONTAINER ID + CREATED) |
| **docker images** | **37%** | `containers.ts` | P (strip WARNING + ID hash) |
| **docker logs** | **19%** | `containers.ts` | P (strip timestamps + PID) + opt-in dedup |
| **curl -v** | **54%** | `network.ts` | P (strip TLS handshake) |
| **wget** | **72%** | `network.ts` | P (strip Resolving/Connecting/HTTP) |
| **dig** | **51%** | `network.ts` | P (strip `;` comments) |
| **journalctl -u** | **33%** | `system.ts` (extend) | P (strip hostname + service prefix) |

**Nota:** se Phase 4 já adicionou `gitLog` e `gitStatus` com rewrite no `git.ts`, Phase 5 só adiciona pipeline-only stages para o caso `matchCommandReject` (cobre quando rewrite é skipped). Se Phase 5 vai antes de Phase 4, os specs ficam só com pipeline e Phase 4 adiciona `rewriteCommand` em cima.

## O que muda no codebase

### Arquivos novos

| Arquivo | LoC est. | Specs |
|---|---|---|
| `src/outputFilter/Bash/filters/git.ts` (NEW or EXTEND from Phase 4) | ~150 | `gitStatus`, `gitLog`, `gitBlame`, `gitPull`, `gitAdd`, `gitCommit`, `gitPush` |
| `src/outputFilter/Bash/filters/containers.ts` | ~80 | `dockerPs`, `dockerImages`, `dockerLogs` |
| `src/outputFilter/Bash/filters/network.ts` | ~70 | `curl`, `wget`, `dig` |

### Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `src/outputFilter/Bash/filters/system.ts` (Phase 2) | Adicionar spec `journalctl` |
| `src/outputFilter/Bash/filters/index.ts` | Importar e re-exportar todos os novos specs |
| `src/outputFilter/Bash/bashFilter.test.ts` | Trocar inline filter definitions pelos imports reais (mesma operação que Phase 2) |
| `src/outputFilter/Bash/__fixtures__/samples/` | Confirmar que samples desses comandos foram copiados em Phase 1 |

## Steps

Para cada filter, mesmo template do Phase 2:

1. Identificar família + criar/estender file
2. Module-level regex consts
3. Spec object literal
4. Re-exportar de `filters/index.ts`
5. Trocar test case inline por import
6. Rodar harness, confirmar ROI

### Specs concretos (vêm de discovery + validate.ts)

Discovery files:
- [`commands/git-status.md`](../../../discovery/bash-output-filter/commands/git-status.md), [`git-log.md`](../../../discovery/bash-output-filter/commands/git-log.md), [`git-blame.md`](../../../discovery/bash-output-filter/commands/git-blame.md), [`git-pull.md`](../../../discovery/bash-output-filter/commands/git-pull.md), [`git-add.md`](../../../discovery/bash-output-filter/commands/git-add.md), [`git-commit.md`](../../../discovery/bash-output-filter/commands/git-commit.md), [`git-push.md`](../../../discovery/bash-output-filter/commands/git-push.md)
- [`docker-ps.md`](../../../discovery/bash-output-filter/commands/docker-ps.md), [`docker-images.md`](../../../discovery/bash-output-filter/commands/docker-images.md), [`docker-logs.md`](../../../discovery/bash-output-filter/commands/docker-logs.md)
- [`curl.md`](../../../discovery/bash-output-filter/commands/curl.md) (network)
- [`journalctl.md`](../../../discovery/bash-output-filter/commands/journalctl.md)

Validate.ts case names: `git-status (clean state)`, `git-log (default — Opção B declarativa)`, `git blame (author + date dominam)`, `git pull (synthetic, fast-forward 3 files)`, `docker ps -a`, `docker images`, `docker logs (postgres tail 50)`, `curl -v (TLS noise dominates)`, `wget`, `dig (DNS query)`, `journalctl -u systemd-logind`.

### Detalhe: `git add/commit/push` strategy M (match-output)

Esses 3 são output-light. Strategy:

```ts
export const gitCommit: FilterSpec = {
  name: 'git-commit',
  matchCommand: /^git(\s+-[^\s]+)*\s+commit\b/,
  matchCommandReject: /--dry-run|--amend\s+--no-edit/,
  matchOutput: [
    {
      pattern: /^\[\S+\s+([0-9a-f]{7,40})\]/,
      message: '✓ committed $1',
      unless: /\b(error|fail|hook exited|denied|rejected)\b|✗|gpg failed/i,
    },
    {
      pattern: /nothing to commit, working tree clean/,
      message: '✓ nothing to commit',
      unless: /\berror\b/i,
    },
  ],
}
```

Nota: `match_output` com captures (`$1`) é parte do feature já validado no harness — re-utilizar.

### Opt-in dedup pra docker logs

```ts
export const dockerLogs: FilterSpec = {
  name: 'docker-logs',
  matchCommand: /^docker(\s+-[^\s]+)*\s+logs\b/,
  matchCommandReject: /-f\b|--follow|--timestamps=false/,
  stripAnsi: true,
  replace: [
    { pattern: /^\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2})\.\d+\s+UTC\s+\[\d+\]\s+/gm, replacement: '$1 ' },
  ],
  collapseRuns: true,                      // opt-in dedup
  collapseDigitTemplates: { minRun: 5 },   // checkpoint ticks
  maxLines: 200,
}
```

## Tests

```bash
bun test src/outputFilter/Bash
bun test scripts/regex-redos-scan.test.ts
bun run typecheck
```

Validation harness deve passar todos os ~25 cases (10 da Phase 2 + 15 da Phase 5 +  rewrite tests da Phase 4).

## Acceptance criteria

- [ ] 10+ specs implementados em 3-4 family files (git, containers, network, system extend)
- [ ] Cada spec passa harness assertion `reductionPct >= predicted - 5`
- [ ] `git add/commit/push` matchOutput rules têm `unless` cobrindo error/fail/hook/✗/gpg/denied/rejected
- [ ] `docker logs` opt-in dedup funciona (collapseRuns + collapseDigitTemplates)
- [ ] `regex-redos-scan.test.ts` passa
- [ ] Coverage ≥80%

## PR description template

```markdown
## feat(bash-filter): built-in filters batch 2 — git/containers/network/journalctl (Phase 5)

Implements 10+ filter specs covering git family (without rewrite — Phase 4 added rewrite layer separately), containers, network, and journalctl.

### Filters added
- **git**: status (26%), log (42% P-only fallback), blame (25%), pull (51%), add/commit/push (~95% via matchOutput)
- **containers**: docker ps (26%), docker images (37%), docker logs (19% + opt-in dedup)
- **network**: curl -v (54%), wget (72%), dig (51%)
- **system extend**: journalctl -u (33%)

### Notable details
- `git commit` matchOutput collapses success to `✓ committed abc1234` — cumulative ~95% over a 20-commit session
- `docker logs` enables `collapseRuns` + `collapseDigitTemplates` opt-in for log-line patterns (postgres checkpoints etc.)
- `git push` strips remote: progress lines but preserves PR creation URL (Opção B from rewrite-design.md)

### Tests
- All 10+ filters pass harness assertion ROI ≥ predicted-5pp
- `unless` clauses validated in safety subset
- ReDoS scan passes

### Refs
- Spec: docs/tech/bash-output-filter/architecture.md §17 Phase 5
- Phase doc: docs/tech/bash-output-filter/phases/phase-5-builtin-batch-2.md
- Discovery: docs/discovery/bash-output-filter/optimization-matrix.md
```

## Implementation notes

_(Preencher durante/após execução.)_
