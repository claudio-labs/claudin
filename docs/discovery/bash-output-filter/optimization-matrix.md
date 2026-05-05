# Matriz de otimização por comando

> **Notação padronizada:**
> - **P** = Pipeline (filtro declarativo de output: stripAnsi, replace, stripLines, etc.)
> - **R** = Rewrite (substitui comando do user antes de executar — `--oneline`, `--porcelain`, `-json`)
> - **M** = Match-output (curto-circuita pra mensagem fixa quando "tudo deu certo")
> - **D** = Dedup (collapseRuns / collapseDigitTemplates / dedupGlobal)
>
> ROI: medido empiricamente quando ✅, estimado quando 🔵, descartado/zero quando 🔴

---

## Git family (17+ comandos)

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **git status** | ✅ 26% (strip hints + replace headers) | 🔵 ~75% (`--porcelain`) | ✅ "✓ clean" se nothing to commit | n/a | **P+M** = 26-58% / **R** = 75% | P+M (preservar form) ou R se aceitar rewrite |
| **git log** default | ✅ 42% (strip Co-*, ## Summary) | ✅ 92% (`--oneline -30`) | n/a | n/a | **R = 92%** | **R (forçar `--oneline`)** — gap 50pp justifica |
| **git log --oneline** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough (já é R aplicado) |
| **git diff** | ✅ 4-5% (strip `index xxx..yyy`) | 🔵 ~30% (`-U1` reduz contexto, mas perde info) | n/a | n/a | **P = 5%** | P apenas; rewrite arrisca perder contexto |
| **git diff --stat** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |
| **git add** (real) | n/a | n/a | ✅ "✓ added" se exit 0 | n/a | **M = ~99%** | M (saída normal é silent) |
| **git add --dry-run** | 🔴 0% (lista de paths é signal) | n/a | n/a | n/a | passthrough | passthrough |
| **git commit** | ✅ proposto | n/a | 🔵 "✓ committed abc1234" — match_output | n/a | **M = ~95%** | **M** — Tier 1.5, validar com commit real |
| **git push** | ✅ proposto (strip Enumerating/Compressing) | n/a | 🔵 "✓ pushed branch -> branch" | n/a | **P = 80%** ou **M = 95%** | **P (Opção B)** — preserva PR creation URL |
| **git push --dry-run** | 🔴 22 bytes | n/a | n/a | n/a | passthrough | passthrough |
| **git pull** | ❌ não coberto | 🔵 parse → "✓ 3 files +10 -2" | n/a | n/a | **gap real** | criar `git-pull.md` + filter |
| **git fetch** | 🔴 silent normal | n/a | n/a | n/a | passthrough | passthrough |
| **git show --stat** | ✅ 3% (strip email author) | n/a | n/a | n/a | minimal | passthrough recomendado |
| **git show** (full) | ✅ 2% | n/a | n/a | n/a | minimal | passthrough |
| **git blame** | ✅ 25% (strip TZ + email + time) | n/a | n/a | n/a | **P = 25%** | **P** — replace pattern de meta block |
| **git branch -a** | 🔴 0% (1 branch/linha) | n/a | n/a | n/a | passthrough | passthrough |
| **git tag --list** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |
| **git remote -v** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |
| **git config --list** | 🔴 0% (filtrar arrisca perder config) | n/a | n/a | n/a | passthrough | passthrough |
| **git reflog** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |
| **git worktree list** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |
| **git stash list** (empty) | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |
| **git clean -nd** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |

---

## File system

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **ls -la** | ✅ 81% (strip drwx + owner + date via replace) | n/a | n/a | n/a | **P = 81%** | **P** (native parser dá 87%, v2) |
| **ls** plain | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |
| **find** (user-filtered) | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |
| **find** sem filter | 🔵 ~70% | n/a | n/a | n/a | maxLines: 500 | P apenas se output > N linhas |
| **tree -L 2** | 🔵 80% est | 🔵 force `-I 'node_modules'` | n/a | n/a | **P+R** | Tier 1.5 (não testado) |
| **du -h --max-depth=1** | 🔴 0% | n/a | n/a | n/a | passthrough | skiplist |
| **df -h** | 🔴 0% | n/a | n/a | n/a | passthrough | skiplist |
| **cat / head / tail** | 🔴 0% | n/a | n/a | n/a | passthrough | skiplist (FileReadTool cobre) |

---

## Search

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **grep -rn** (paths absolutos) | ✅ 33% (path → relative) | n/a | n/a | n/a | **P = 33%** | P |
| **rg** (paths absolutos via user) | ✅ 34% (mesmo replace) | n/a | n/a | n/a | **P = 34%** | P |
| **rg** (paths relativos) | 🔴 0% (já compacto) | n/a | n/a | n/a | passthrough | passthrough |

---

## Build / Test — JS/TS

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **tsc --noEmit** | ✅ 1% (strip hint repetidos) | n/a | n/a | 🔵 dedup global daria mais | minimal | **NÃO criar filter** — virar strategy do summarizer (volume 590KB!) |
| **vitest** | 🔵 70% est | n/a | 🔵 "✓ all tests passed" | n/a | **M ~90%** | Tier 1.5 — validar com bun test (cobre subset) |
| **bun test** | 🔴 1% (já compacto) | n/a | n/a | n/a | passthrough | skiplist |
| **jest** | 🔵 ~80% est | n/a | 🔵 "✓ all tests passed" | n/a | **M ~90%** | Tier 1.5 — não testado |
| **eslint** | 🔵 ~40% est (relative paths) | 🔵 force `--format=compact` | n/a | n/a | **P+R ~70%** | Tier 1.5 — não testado |
| **prettier --check** | ✅ 7% | n/a | 🔵 "✓ all formatted" se clean | n/a | minimal | passthrough ou M apenas |
| **playwright** | 🔵 ~80% est | n/a | M | n/a | **M ~90%** | Tier 1.5 — não testado |
| **next build** | 🔵 ~70% est | n/a | M | n/a | **P+M** | Tier 1.5 |
| **prisma generate** | 🔵 ~50% est (strip ASCII art) | n/a | M | n/a | P+M | Tier 1.5 |

---

## Build / Test — Rust

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **cargo build** | ✅ 55% (strip Compiling lines) | 🔵 force `--message-format=json` | ✅ "✓ Finished" | n/a | **P+M = 60%** | **P+M** (preservar Compiling principal) |
| **cargo check** | ✅ 64% | mesma | ✅ same | n/a | **P+M = 64%** | P+M |
| **cargo test** | 🔵 95%+ all-pass | mesma | ✅ "✓ all tests passed" | n/a | **P+M = 95%** | P+M |
| **cargo test --no-run** | 🔴 0% (delegate cargo-build) | n/a | n/a | n/a | n/a | reusa filter cargo-build |
| **cargo clippy** | ✅ 0% (warnings = signal) | mesma | n/a | n/a | minimal | passthrough |

---

## Build / Test — Python

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **pytest** (clean) | ✅ 95% | n/a | ✅ "✓ all tests passed" | n/a | **M = 95%** | **M** + P pra failures |
| **ruff check** (errors) | ✅ ~0% (compacto by design) | 🔵 80% (`--output-format=json`) | n/a | n/a | **R = 80%** ou passthrough | Tier 1: passthrough; rewrite v2 |
| **ruff check** (clean) | ✅ 11% | n/a | ✅ "✓ ruff clean" | n/a | **M ~99%** | M |
| **mypy** | 🔵 ~25% est (path-relative) | n/a | M | n/a | **P+M ~30%** | Tier 1.5 |
| **pip install** | 🔵 ~50% est | n/a | M | n/a | P+M | não medido |
| **pip list / outdated** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |

---

## Build / Test — Go

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **go test -v** (clean) | ✅ 82% (strip RUN/PASS) | 🔵 force `-json` parser | ✅ "✓ all packages passed" | n/a | **P+M = 82%** | **P+M** validado |
| **go test** (no -v) | 🔵 ~50% | n/a | M | n/a | M | small samples |
| **golangci-lint** | ✅ ~0% (compacto) | 🔵 85% (`-json` + parse) | n/a | n/a | passthrough ou rewrite v2 | Tier 1: passthrough |

---

## Build / Test — Ruby

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **rspec** (clean) | n/a | 🔵 60% (`-f json`) | ✅ 73% | n/a | **M = 73%** | **M** validado |
| **rubocop** | ✅ 83% (strip preamble "new cops") | 🔵 mesma | n/a | n/a | **P = 83%** | **P** validado, alto ROI exclusivo Ruby |
| **bundle install** | ✅ minimal | n/a | ✅ 96% "✓ Bundle complete" | n/a | **M = 96%** | **M** validado |
| **rake** (test) | 🔵 ~70% est | n/a | M | n/a | M | Tier 1.5 |

---

## Build / Test — Java/Kotlin

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **mvn package/test/install** | 🔵 99% est (strip `[INFO]`) | n/a | 🔵 "✓ BUILD SUCCESS" | n/a | **P+M = 99%** | Tier 1.5 — alto ROI esperado |
| **gradle / gradlew** | 🔵 99% est | n/a | 🔵 "✓ BUILD SUCCESSFUL" | n/a | **P+M = 99%** | Tier 1.5 |

---

## Containers

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **docker ps -a** | ✅ 26% (strip CONTAINER ID + CREATED) | 🔵 force `--format` | n/a | n/a | **P = 26%** | P |
| **docker images** | ✅ 37% (strip WARNING + ID) | 🔵 force `--format` | n/a | n/a | **P = 37%** | P |
| **docker logs** | ✅ 19% (strip timestamp + PID) | n/a | n/a | 🔵 dedup pode ajudar | **P = 19%** + dedup | P (+D opt-in) |
| **docker build** | 🔵 70-90% est | n/a | 🔵 "✓ docker build successful" | n/a | **P+M = 98%** | Tier 1.5 |
| **docker compose ps** | 🔵 mesmo padrão docker ps | n/a | n/a | n/a | P | Tier 1.5 (não testado separado) |
| **docker inspect** | 🔴 passthrough (JSON estruturado) | n/a | n/a | n/a | passthrough | passthrough |

---

## Kubernetes

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **kubectl get** | 🔵 0-30% est | 🔵 50% (`-o json` + parse, rtk faz) | n/a | n/a | **R = 50%** v2; passthrough v1 | Tier 1.5 |
| **kubectl describe** | 🔵 60% est (strip defaults) | n/a | n/a | n/a | **P = 60%** | Tier 1.5 |
| **kubectl logs** | 🔵 ~30% (similar docker logs) | n/a | n/a | dedup útil | **P+D** | Tier 1.5 |
| **helm list** | 🔵 0-20% est | n/a | n/a | n/a | passthrough provavel | Tier 1.5 |

---

## Cloud CLIs

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **aws ec2 describe-instances** | 🔵 ~50% est | 🔵 force JSON view | n/a | n/a | R | gap, não testado |
| **aws s3 ls** | 🔵 ~30% est | n/a | n/a | n/a | P maxLines | gap |
| **aws iam list-roles** | 🔵 strip policy docs (rtk faz!) | n/a | n/a | n/a | P | gap — feature de **segurança** |
| **aws lambda list-functions** | 🔵 strip secrets (rtk faz!) | n/a | n/a | n/a | P | gap — feature de **segurança** |
| **gcloud compute instances list** | 🔵 ~30% est | n/a | n/a | n/a | P | gap |

---

## IaC

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **terraform plan** (no changes) | 🔵 minimal | n/a | 🔵 97% "✓ no changes" | n/a | **M = 97%** | Tier 1.5 |
| **terraform plan** (com changes) | 🔵 37-67% (strip Refreshing) | n/a | n/a | n/a | **P** | Tier 1.5 |
| **terraform apply** | 🔵 70% est (strip "Still creating Ns") | n/a | M | dedup útil | **P+M+D** | Tier 1.5 |

---

## Network

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **curl -v** | ✅ 54% (strip TLS handshake) | n/a | n/a | n/a | **P = 54%** | **P** validado |
| **curl** (sem -v) | 🔴 minimal | n/a | n/a | n/a | passthrough | passthrough |
| **curl -I** | 🔴 minimal | n/a | n/a | n/a | passthrough | passthrough |
| **wget** | ✅ 72% (strip Resolving/Connecting/HTTP/progress) | n/a | n/a | n/a | **P = 72%** | **P** validado |
| **dig** | ✅ 51% (strip `;` comments) | n/a | n/a | n/a | **P = 51%** | **P** validado |
| **ss -tln / netstat** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |

---

## System / Process

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **ps aux** | ✅ 93% (strip kthreads + maxLines) | n/a | n/a | dedup possível | **P = 93%** | **P** validado |
| **top -bn1** | ✅ 52% (strip kthreads via VIRT=0) | n/a | n/a | n/a | **P = 52%** | **P** validado |
| **journalctl -u** | ✅ 33% (strip hostname + service prefix) | n/a | n/a | dedup possível | **P+D = 40%+** | **P (+D opt-in)** validado |

---

## Package managers

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **npm install** | 🔵 50-95% (varia) | n/a | 🔵 "✓ npm install completed" | n/a | **P+M** | Tier 1.5 — não medido com npm real |
| **pnpm install** | 🔵 ~70% est | n/a | M | n/a | M | Tier 1.5 |
| **yarn install** | 🔵 ~80% est | n/a | M | n/a | M | Tier 1.5 |
| **bun install** | 🔴 already minimal | n/a | n/a | n/a | passthrough | **skiplist** confirmado |
| **npm test / pnpm test / yarn test** | 🔵 wrapper strip + delegate | n/a | n/a | n/a | requer encadeamento | decisão design v1 |
| **npm ls** | 🔴 0% (já compacto) | n/a | n/a | n/a | passthrough | passthrough |
| **pip list / outdated** | 🔴 0% | n/a | n/a | n/a | passthrough | passthrough |

---

## Outros / data

| Comando | P | R | M | D | Combinado | Recomendação |
|---|---|---|---|---|---|---|
| **jq** | 🔴 signal puro | n/a | n/a | n/a | passthrough | passthrough |
| **env / env grep** | 🔴 values são content | n/a | n/a | n/a | passthrough | passthrough |
| **make / cmake** | 🔵 50-80% est (strip Entering/Leaving) | n/a | M | n/a | **P+M** | Tier 1.5 |
| **gh pr list** | 🔵 70% est | 🔵 force `--json` | n/a | n/a | **R = 70%** | Tier 1.5 — gap GitHub remote |

---

## Resumo executivo — ROIs medidos descendentes

### Top 10 ROI confirmado (>50%)

1. **bundle install** — 96% (M)
2. **pytest clean** — 95% (M)
3. **ps aux** — 93% (P)
4. **rubocop** — 83% (P)
5. **go test -v clean** — 82% (P+M)
6. **ls -la** — 81% (P)
7. **rspec clean** — 73% (M)
8. **wget** — 72% (P)
9. **cargo check cold** — 64% (P+M)
10. **cargo build warm** — 55% (P+M)

### Top "se aceitar Rewrite (R)" — gaps que viram wins

11. **git log default** — 92% se forçar `--oneline` (medido)
12. **ruff check com erros** — ~80% se forçar `--output-format=json` + parse
13. **git status** — ~75% se forçar `--porcelain`
14. **kubectl get** — ~50% se forçar `-o json` + parser nativo

### Padrões de uso de cada estratégia

| Strategy | Quantos comandos confirmados |
|---|---|
| **Pure passthrough** (skiplist + Tier 2) | ~25 |
| **P only** (pipeline) | ~12 |
| **M only** (match_output) | ~6 (commit, push, install completions) |
| **P+M** (pipeline + match_output) | ~10 (build/test tools) |
| **P+R** (pipeline + rewrite) | 0 na v1 conservadora; ~6 na v1 agressiva |
| **D** (dedup) opt-in | ~4 (logs, retry loops) |

---

## Output: o que entra na v1

Com base nesta matriz, a v1 deveria implementar:

### Conjunto mínimo viável (somente P+M, sem rewrite)

**~20 filtros nativos** cobrindo Top 10 medidos + análogos:

1. `bash-output-filter/git-status` (P+M, 26-58%)
2. `git-log` (P, 42% — sem rewrite)
3. `git-blame` (P, 25%)
4. `git-add/commit/push` (M, 90%+ cumulativo)
5. `ls -la` (P, 81%)
6. `cargo-build/check/test/clippy` (P+M, 55-95%)
7. `pytest` (M, 95%)
8. `rspec` (M, 73%)
9. `bundle install` (M, 96%)
10. `rubocop` (P, 83%)
11. `go test` (P+M, 82%)
12. `docker-ps/images/logs` (P, 19-37%)
13. `ps aux` (P, 93%)
14. `top` (P, 52%)
15. `journalctl` (P, 33%)
16. `curl -v` (P, 54%)
17. `wget` (P, 72%)
18. `dig` (P, 51%)
19. `grep/rg` paths absolutos (P, 33-34%)
20. **`dedup` global** (D, opt-in)

**Skiplist explícita (não tentar filter):** ~25 comandos zero-ROI.

### Conjunto agressivo (com rewrite na v1)

Adicional aos 20 acima:

21. `git-log` (R, força `--oneline`) → 92%
22. `git-status` (R, força `--porcelain`) → ~75%
23. `ruff check` (R, força `--output-format=json` + parse JSON) → ~80%
24. `kubectl get` (R, força `-o json` + parser nativo) → ~50%
25. `gh pr list` (R, força `--json`) → ~70%
26. `cargo build` (R, força `--message-format=json`) → ~80%

**6 filtros R adicionais com ganho 50-90pp acima das versões P-only.**

---

## Próximos passos

1. **Decidir Q2** (`open-questions.md`) — aceita rewrite na v1?
2. **Adicionar `git-pull`** — único gap real de cobertura git
3. **Validar Tier 1.5** críticos via install local (mvn? gradle? terraform?) — só os com ROI estimado >85%
4. **Fechar discovery** e mover pra spec da v1 em `docs/plans/bash-output-filter.md`
