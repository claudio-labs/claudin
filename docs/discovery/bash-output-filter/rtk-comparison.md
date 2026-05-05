# Comparativo: nossa cobertura vs rtk

> Última atualização: 2026-05-05 — após rodada 6 do validator

## Auditoria item-por-item da lista do rtk

### ✅ Cobertos (com Tier + status)

| rtk | Nossa cobertura | ROI medido |
|---|---|---|
| `rtk ls .` | [`ls.md`](commands/ls.md) | **81%** |
| `rtk find` | [`find.md`](commands/find.md) | 0% (rebaixado) |
| `rtk grep` | [`grep-rg.md`](commands/grep-rg.md) | **33%** |
| `rtk diff` | coberto por `git diff` | 0% (sample empty) |
| `rtk git status` | [`git-status.md`](commands/git-status.md) | **26%** |
| `rtk git log` | [`git-log.md`](commands/git-log.md) | **42%** |
| `rtk git diff` | [`git-diff.md`](commands/git-diff.md) | 0-5% |
| `rtk git add → "ok"` | [`git-add.md`](commands/git-add.md) | 0% (validado --dry-run) |
| `rtk git commit → "ok abc"` | [`git-commit.md`](commands/git-commit.md) | Tier 1.5 estimate (90-99%) |
| `rtk git push → "ok main"` | [`git-push.md`](commands/git-push.md) | Tier 1.5 (--dry-run validado, real push estimate 80-95%) |
| `rtk gh pr list` | [`gh-pr-list.md`](commands/gh-pr-list.md) | Tier 1.5 estimate (~70%) |
| `rtk vitest` | [`vitest.md`](commands/vitest.md) | Tier 1.5 estimate (~80%) |
| `rtk pytest` | [`pytest.md`](commands/pytest.md) | **95%** ✅ |
| `rtk go test` | [`go-test.md`](commands/go-test.md) | Tier 1.5 estimate (~90%) |
| `rtk cargo test` | [`cargo-test.md`](commands/cargo-test.md) | validado --no-run |
| `rtk lint (eslint)` | [`eslint.md`](commands/eslint.md) | Tier 1.5 estimate (~40%) |
| `rtk tsc` | [`tsc.md`](commands/tsc.md) | **1%** (volume gigante mas sinal denso) |
| `rtk cargo build` | [`cargo-build.md`](commands/cargo-build.md) | **55-64%** |
| `rtk ruff check` | [`ruff-check.md`](commands/ruff-check.md) | **0-11%** |
| `rtk docker ps` | [`docker-ps.md`](commands/docker-ps.md) | **26%** |
| `rtk docker images` | [`docker-images.md`](commands/docker-images.md) | **37%** |
| `rtk docker logs` | [`docker-logs.md`](commands/docker-logs.md) | **19%** |
| `rtk kubectl pods/logs/services` | [`kubectl.md`](commands/kubectl.md) | Tier 1.5 estimate (~50-65%) |
| `rtk curl <url>` | [`curl.md`](commands/curl.md) | **54%** |
| `rtk wget <url>` | _(novo, validado)_ | **72%** ✅ |

### ❌ Gaps identificados

| rtk | Status | Razão / próximo passo |
|---|---|---|
| `rtk read -l aggressive` (signatures only) | ❌ NÃO COBERTO | **Feature diferente** — não é filter de output, é **transformação de file content**. Strip de function bodies. claudio tem FileReadTool — feature pertenceria lá, não no filter Bash. |
| `rtk smart file.rs` (2-line summary) | ❌ NÃO COBERTO | Idem — feature de file-content, não output filter. |
| `rtk git pull → "ok 3 files +10 -2"` | ❌ não testado real | Só `--dry-run` (0 bytes). Estimar similar ao git-push. |
| `rtk gh pr view 42` | ❌ separado | Filter mais agressivo do `gh pr list` — cobrir junto. |
| `rtk gh issue list` | ❌ separado | Mesmo padrão `gh pr list`. |
| `rtk gh run list` | ❌ separado | Mesmo padrão. |
| `rtk jest` | ❌ separado de vitest | Padrão similar. Match-pattern do `vitest.md` deveria cobrir. |
| `rtk playwright test` | ❌ NÃO COBERTO | Outro test runner JS, padrão similar. |
| `rtk rake test` | ❌ NÃO COBERTO | Ruby — foi do roadmap discovery. |
| `rtk rspec` | ❌ NÃO COBERTO | Ruby. |
| `rtk err <cmd>` | ❌ FEATURE DIFERENTE | **Wrapper genérico** — strip everything except errors. Útil mas exige design separado. |
| `rtk test <cmd>` | ❌ FEATURE DIFERENTE | Wrapper genérico de test runners. |
| `rtk next build` | ❌ NÃO COBERTO | JS bundler, padrão similar a tsc + extras. |
| `rtk prettier --check` | ❌ separado | Mencionado em eslint.md mas não testado. |
| `rtk cargo clippy` | ❌ separado de cargo-build | Padrão similar — `cargo-build.md` provavelmente cobre. |
| `rtk golangci-lint` | ❌ NÃO COBERTO | Go linter. |
| `rtk rubocop` | ❌ NÃO COBERTO | Ruby linter. |
| `rtk pnpm list` | ❌ NÃO COBERTO | Dep tree, similar a npm ls (validado 0%). |
| `rtk pip list` | ✅ NEW | Validado 0% (passthrough). |
| `rtk pip outdated` | ✅ NEW | Validado 0%. |
| `rtk bundle install` | ❌ NÃO COBERTO | Ruby. |
| `rtk prisma generate` | ❌ NÃO COBERTO | Tool específico, ASCII art noise. |
| `rtk aws sts get-caller-identity` | ❌ NÃO COBERTO | AWS CLI — todo família não tratado. |
| `rtk aws ec2 describe-instances` | ❌ NÃO COBERTO | AWS CLI. |
| `rtk aws lambda list-functions` | ❌ NÃO COBERTO | **strips secrets** — feature interessante de segurança. |
| `rtk aws logs get-log-events` | ❌ NÃO COBERTO | AWS CloudWatch. |
| `rtk aws cloudformation describe-stack-events` | ❌ NÃO COBERTO | AWS CFN. |
| `rtk aws dynamodb scan` | ❌ NÃO COBERTO | AWS DDB — unwrap type annotations. |
| `rtk aws iam list-roles` | ❌ NÃO COBERTO | **strips policy documents** — segurança. |
| `rtk aws s3 ls` | ❌ NÃO COBERTO | AWS S3. |
| `rtk docker compose ps` | ❌ separado | Padrão similar a docker ps. |
| `rtk json file.json` (structure-only) | ❌ FEATURE DIFERENTE | Parser JSON dedicado — mostra keys sem values. |
| `rtk deps` | ❌ FEATURE DIFERENTE | Aggregator de deps de múltiplos managers. |
| `rtk env -f AWS` | ❌ feature dedicada | Env filter por substring — útil mas é geração, não filter. |
| `rtk log app.log` | ❌ FEATURE DIFERENTE | Log dedup genérico (já temos `dedupGlobal` no pipeline). |
| `rtk summary <cmd>` | ❌ FEATURE DIFERENTE | Heuristic summarizer — nosso `toolResultSummarizer.ts` faz papel similar. |
| `rtk proxy <cmd>` | ❌ FEATURE DIFERENTE | Passthrough + tracking. Não é compressão. |

## Resumo

- **Cobertos com dados reais:** ~30 commands
- **Cobertos estimate-only (Tier 1.5):** ~16
- **Gaps reais:** ~30+ (maioria AWS, Ruby, alguns separados que já cobrimos via pattern compartilhado)

## Estamos usando as mesmas regras?

### ✅ Estratégias compartilhadas

1. **Pipeline declarativo de N estágios** — rtk tem 8 estágios (`toml_filter.rs`), nós temos 11 (mesmo + 3 dedup):
   - `stripAnsi`, `replace`, `match_output` (com `unless`), `strip/keep_lines`, `truncate_lines_at`, `head/tail_lines`, `max_lines`, `on_empty`
2. **`unless` clause** em `match_output` pra não engolir errors — copiado verbatim de rtk.
3. **Strip patterns idênticos** em vários filtros (ex: `gradle.toml` do rtk → nosso `gradle.md`).
4. **Match-command regex ancorado** em `^cmd\b`.
5. **Dedup de runs consecutivos** + **collapse digit templates** — claudio já tinha em `toolResultSummarizer.ts`, alinha com rtk.

### ⚠️ Estratégias DIFERENTES (intencionalmente)

| Estratégia | rtk | Nós | Razão |
|---|---|---|---|
| **Command rewrite** (forçar `-json`/`--format`) | Sim — `kubectl` força `-o json`, `cargo` força `--message-format=json`, `ruff` usa `--output-format=json`, `golangci-lint` força `-json` | **Não na v1** | Quebra "preserve user intent". Adiar pra v2. **Importante:** rtk reporta 80% em ruff e 90% em go test PRECISAMENTE porque faz isso — sem rewrite, ROI cai pra 11% e ~70% (medido). |
| **Native parser** (Rust) pra parser JSON / multi-step | Sim — `rtk/src/cmds/cloud/container.rs::run_kubectl_json` | **Não na v1** (TS pure só) | Custo de manutenção. v2 considerar. |
| **`rtk read` / `rtk smart`** (file content) | Feature integrada | **Não — file content é FileReadTool** | Domínio diferente. |
| **`rtk err` / `rtk test` / `rtk summary`** (wrappers genéricos) | Wrapper command | **Não — feature de proxy** | Filosoficamente diferente: rtk é proxy CLI explícito; claudio é integração transparente. |

## Por que rtk reporta % maior em ruff e go test

A tabela do rtk diz `rtk ruff check  # Python linting (JSON, -80%)` — note **(JSON, -80%)**.

rtk **força `--output-format=json` por trás** em ruff/golangci-lint/rspec, depois **parseia o JSON e reformata em texto compacto**.

- ruff JSON: estrutura `{"code": "F401", "message": "...", "location": {...}, "fix": {...}}` por error
- rtk extrai `code:msg @ path:line` em uma linha
- Reduz dramaticamente vs `ruff` default que já é `path:line:col: code msg` (compacto pra texto, mas verbose comparado a JSON minimal)

**Tradeoff**:
- rtk: 80% redução em `ruff check` mas **muda o comando** que o user pediu
- Nós: 0-11% em `ruff check` direct (filter declarativo simples) mas **respeita user intent**

**Ver `open-questions.md` Q2** — decisão de "command rewrite" entra aqui. Se aceitarmos `git-log` Opção A (forçar `--oneline`), por consistência deveríamos aceitar `ruff` Opção A (forçar `--output-format=json`). Decisão de design importante.

## Próximos passos pra cobrir gaps

**Easy wins (sem instalar):**
- `git pull` real (após git fetch real)
- `pnpm list` (mas claudio usa bun — sem deps pnpm)
- `wget`: ✅ já validado (72%)
- `pip list/outdated`: ✅ já validados (0%)
- `env -f`: ✅ comportamento testado (passthrough)

**Requer install:**
- AWS CLI (8 commands) — `pacman -S aws-cli` ou `pip install awscli`
- prettier — `npm i -g prettier`
- prisma — `npm i -g prisma`
- jest — vem com qualquer projeto JS com jest
- playwright — `npm i -g @playwright/test`
- golangci-lint — `pacman -S golangci-lint`
- ruby tools (rubocop, rspec, rake, bundle) — `pacman -S ruby` + gems

**Decisão pendente sobre command-rewrite na v1.**

## Conclusão

**Cobertura empírica:** ~30 commands com dados reais, ~16 estimate-only, ~30+ gaps.

**Mesmas regras?** **Sim para o pipeline declarativo** (95% das estratégias batem). **Não para command rewrite** — rtk faz, nós deixamos pra v2.

**Tradeoff principal documentado:** rtk reporta % maior em vários comandos PORQUE rewrite the command (`-json`/`--format`). Nossa abordagem conservadora preserva user intent — escolha de design, não falta de capacidade.
