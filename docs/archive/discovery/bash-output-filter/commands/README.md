# Catálogo de comandos compressíveis

Um arquivo por comando candidato. Cada arquivo descreve: padrão de match, saída crua representativa, sinal vs ruído, estratégia proposta, edge cases, estimativa de redução.

Use [`_template.md`](_template.md) como base ao criar novo arquivo.

## Status legend

- `candidate` — listado mas ainda não estudado
- `analyzed` — saída crua coletada, sinal/ruído mapeado
- `spec'd` — estratégia definida, pronto pra implementar
- `implemented` — código merged

## Tier 1 — VALIDADO com dados reais ✅

Comandos com sample real capturado, filter implementado em [`../validation/validate.ts`](../validation/validate.ts), 100% passing no harness empírico.

**Ordenado por ROI medido descendente.**

| Comando | Família | ROI medido | Arquivo |
|---|---|---|---|
| **bundle install** | ruby pkg | **96%** (`match_output`) | _(dentro de validate.ts)_ |
| **pytest** (clean) | python test | **95%** (`match_output`) | [`pytest.md`](pytest.md) |
| **rubocop** (preamble strip) | ruby lint | **83%** | _(dentro de validate.ts)_ |
| **go test -v** (clean) | go test | **82%** (`match_output`) | [`go-test.md`](go-test.md) |
| **wget** | network | **72%** | _(dentro de validate.ts)_ |
| **rspec** (clean) | ruby test | **73%** (`match_output`) | _(dentro de validate.ts)_ |
| **ps aux** | system | **93%** | [`ps-aux.md`](ps-aux.md) |
| **ls -la** | fs | **81%** (87% com native parser) | [`ls.md`](ls.md) |
| **cargo check** (cold) | rust | **64%** | [`cargo-build.md`](cargo-build.md) |
| **cargo build** (warm) | rust | **55%** | [`cargo-build.md`](cargo-build.md) |
| **curl -v** | network | **54%** (TLS noise) | [`curl.md`](curl.md) |
| **top -bn1** | system | **52%** (kthreads) | [`top.md`](top.md) |
| **dig** | network | **51%** | _(dentro de validate.ts)_ |
| **git log** default | git | **42%** (Opção B) | [`git-log.md`](git-log.md) |
| **git status** | git | **26%** | [`git-status.md`](git-status.md) |
| **git blame** | git | **25%** | [`git-blame.md`](git-blame.md) |
| **git show** (--stat / full) | git | **2-3%** | [`git-show.md`](git-show.md) |
| **git tag/branch/remote/config/reflog/worktree/stash/fetch/clean** | git | **0%** (já compactos) | [`git-misc.md`](git-misc.md) |
| **docker images** | docker | **37%** | [`docker-images.md`](docker-images.md) |
| **rg** (paths absolutos) | search | **34%** | [`grep-rg.md`](grep-rg.md) |
| **journalctl -u** | system | **33%** | [`journalctl.md`](journalctl.md) |
| **grep -rn** (paths absolutos) | search | **33%** | [`grep-rg.md`](grep-rg.md) |
| **docker ps -a** | docker | **26%** | [`docker-ps.md`](docker-ps.md) |
| **docker logs** | docker | **19%** | [`docker-logs.md`](docker-logs.md) |
| **ruff check** (clean) | python lint | **11%** (`match_output`) | [`ruff-check.md`](ruff-check.md) |
| **prettier --check** | js formatter | 7% | _(dentro de validate.ts)_ |
| **golangci-lint** (1 issue) | go lint | ~0% (compacto by design) | _(dentro de validate.ts)_ |
| **cargo clippy** (40 warnings) | rust lint | ~0% (warnings são sinal puro) | _(dentro de validate.ts)_ |
| **tsc --noEmit** | typescript | 1% (volume gigante mas sinal denso) | [`tsc.md`](tsc.md) |

**Confirmados zero-ROI (passthrough):** `ls`, `find`, `bun install`, `bun test`, `git push --dry-run`, `git add --dry-run`, `git diff` (empty), `git branch -a`, `df -h`, `du -h`, `ss -tln`, `tail`, `jq`, `npm ls`, `rg` (paths relativos), `git log --oneline`, `ruff` (already-clean) — total 17 cases.

## Tier 1.5 — Estimate-only ⚠️ (esperando dados reais)

Filter speccado mas **sem sample real capturado**. ROI é estimativa baseada em conhecimento do tool + análise de prior art (rtk). Promover pra Tier 1 conforme samples reais virem (via Fase 0 telemetria ou installs locais).

| Comando | Família | ROI estimado | Bloqueador | Arquivo |
|---|---|---|---|---|
| `mvn` | java build | **~90-99%** | mvn não instalado | [`mvn.md`](mvn.md) |
| `gradle` / `gradlew` | java/kotlin | **~85-99%** | gradle não instalado | [`gradle.md`](gradle.md) |
| `terraform plan` (no changes) | iac | **~97%** | terraform não instalado | [`terraform.md`](terraform.md) |
| `docker build` (success) | docker | ~98% (`match_output`) | sem Dockerfile demo | [`docker-build.md`](docker-build.md) |
| `git commit` (sucesso) | git | ~90-99% | requer commit real | [`git-commit.md`](git-commit.md) |
| `git push` (push real) | git | ~80-95% | requer push real | [`git-push.md`](git-push.md) |
| `vitest` / `jest` | js test | ~70-90% | não rodado | [`vitest.md`](vitest.md) |
| `go test` | go test | ~70-99% | go não instalado | [`go-test.md`](go-test.md) |
| `gh pr list` | github | ~70% | repo sem GitHub remote | [`gh-pr-list.md`](gh-pr-list.md) |
| `kubectl get/describe` | k8s | ~50-65% | kubectl não instalado | [`kubectl.md`](kubectl.md) |
| `make` / `cmake` | build | ~50-80% | sem Makefile demo | [`make.md`](make.md) |
| `eslint` / `biome` | js linter | ~30-50% | não rodado | [`eslint.md`](eslint.md) |
| `mypy` | python types | ~10-30% | sample errored em path | [`mypy.md`](mypy.md) |
| `npm test` / `pnpm test` | js test wrapper | depende framework + 5-15% wrapper | requer encadeamento | [`npm-test.md`](npm-test.md) |
| `npm install` (verboso) | js | ~50-95% | só bun capturado | [`npm-install.md`](npm-install.md) |
| `tree -L 2` | fs | ~80% | tree não instalado | [`tree.md`](tree.md) |

**Total Tier 1.5:** 16 comandos. Cada um tem sua razão de não ter sido validado documentada no arquivo respectivo.

## Como promover Tier 1.5 → Tier 1

1. Capturar sample real do comando (rodar localmente ou via colaborador)
2. Salvar em `src/outputFilter/Bash/__fixtures__/samples/<nome>.txt` (corpus único)
3. Adicionar test case em `validation/validate.ts` com filter spec do `.md`
4. Rodar `bun run validation/validate.ts` — ajustar predição se delta > 15pp
5. Atualizar `<comando>.md` com nota "VALIDATED" + ROI medido
6. Mover entrada na tabela acima de Tier 1.5 pra Tier 1

## Tier 2 — rebaixados após análise empírica

Comandos onde a medição real mostrou ROI muito menor que o esperado pela tabela do rtk:

| Comando | Família | Redução medida | Razão da queda | Arquivo |
|---|---|---|---|---|
| `docker ps` | docker | ~30% | Nomes/imagens/portas são incompressíveis; rtk reporta 80% mas só em casos com muitos exited | [`docker-ps.md`](docker-ps.md) |
| `git diff` | git | ~5% | Diff é puro sinal; só index hashes removíveis | [`git-diff.md`](git-diff.md) |
| `find` | fs | ~0% (user-filtered) | Em uso real users já passam `-not -path`; claudin tem `GlobTool` | [`find.md`](find.md) |
| `bun install` | js | **0%** (não criar filtro) | Output já máximo de compacto (96 bytes pra 505 packages) | [`npm-install.md`](npm-install.md) |

## Tier 1.5 — promover após Fase 0 se uso real for alto

Comandos com **ROI intuitivo alto** mas que dependem de uso real do agent claudin. Telemetria da Fase 0 deve confirmar antes de virar Tier 1.

| Comando | Domínio | ROI medido / esperado | Status | Arquivo |
|---|---|---|---|---|
| `tsc --noEmit` | typescript | **~15% medido** (mas volume gigante: 590KB!) | analyzed | [`tsc.md`](tsc.md) |
| `ps aux` | system | **~87% medido** | analyzed | [`ps-aux.md`](ps-aux.md) |
| `journalctl -u <svc>` | system | **~41% medido** | analyzed | [`journalctl.md`](journalctl.md) |
| `gh pr list` / `gh pr view` | github | ~70% (estimado, não capturado) | not analyzed | [`gh-pr-list.md`](gh-pr-list.md) |
| `vitest` / `jest` | js test | ~70-90% (estimado) | not analyzed | [`vitest.md`](vitest.md) |
| `eslint` / `biome` | js linter | ~30-50% (estimado) | not analyzed | [`eslint.md`](eslint.md) |
| `tree -L 2` | fs | ~80% (estimado, não instalado local) | not analyzed | [`tree.md`](tree.md) |
| `gh issue list` / `gh run list` | github | ~70% (mesmo perfil) | TBD | (cobrir junto com `gh-pr-list.md`) |
| `kubectl get`/`describe`/`logs` | k8s | ~50-60% estimado | not analyzed | [`kubectl.md`](kubectl.md) |
| `terraform plan` / `apply` | iac | **~67-97%** estimado (no-changes = 97%) | not analyzed | [`terraform.md`](terraform.md) |
| `mvn` | java build | **~90-99%** estimado | not analyzed | [`mvn.md`](mvn.md) |
| `gradle` / `gradlew` | java/kotlin build | **~85-99%** estimado | not analyzed | [`gradle.md`](gradle.md) |
| `cargo test` | rust test | **~90-99%** (all-pass) | analyzed | [`cargo-test.md`](cargo-test.md) |
| `go test` | go test | **~70-99%** (all-pass) | not analyzed | [`go-test.md`](go-test.md) |
| `npm test` / `pnpm test` / `yarn test` | js test wrapper | depende do framework + 5-15% wrapper | not analyzed | [`npm-test.md`](npm-test.md) |
| `ruff check` / `ruff format` | python linter | ~30-90% (varia) | not analyzed | [`ruff-check.md`](ruff-check.md) |
| `grep -rn` (paths absolutos) | search | **33% medido** | analyzed | [`grep-rg.md`](grep-rg.md) |
| `docker logs <ct>` | docker | **19% medido** | analyzed | [`docker-logs.md`](docker-logs.md) |
| `docker images` | docker | **37% medido** | analyzed | [`docker-images.md`](docker-images.md) |
| `docker build` | docker | ~70-98% est | not analyzed | [`docker-build.md`](docker-build.md) |
| `curl -v` | network | **54% medido** | analyzed | [`curl.md`](curl.md) |
| `make` / `cmake` | build | ~50-80% est | not analyzed | [`make.md`](make.md) |
| `top -bn1` | system | **52% medido** | analyzed | [`top.md`](top.md) |
| `mypy` | python type check | ~10-30% est | not analyzed | [`mypy.md`](mypy.md) |

## Zero ROI — não criar filtro

Comandos onde a medição mostrou que **não vale a pena**: [`_zero-roi-skiplist.md`](_zero-roi-skiplist.md)

## Tier 2 — adicionar quando saturarmos Tier 1+1.5

Listados sem arquivo dedicado ainda. Agrupados por domínio.

### Git family — adicional
- `git add` / `git commit` / `git push` / `git pull` — outputs simples, geralmente curto-circuito (`match_output`)
- `git branch -a` — outputs longos em repo com muitas branches; force `--list` ou cap
- `git fetch` — output curto, talvez não vale
- `git show <hash>` — similar ao `diff`, já analisamos que diff é incompressível
- `git stash list` — colunas com timestamps
- `git tag --list` — pode ter centenas de linhas
- `git remote -v` — 4-8 linhas, baixo ROI
- `git config --list` — pode ter dezenas de linhas, poucas acionáveis
- `git blame <file>` — author + timestamp redundantes em cada linha; ROI alto se file grande
- `git reflog` — timestamps + actions; pode comprimir bastante
- `git log --graph` — ASCII art preservar
- `glab` (GitLab CLI), `gt` (Graphite), `jj` (Jujutsu) — análogos ao gh

### File system / inspeção
- `tree -L N` — recursivo
- `du -sh *` / `du -h --max-depth=1` — alinhamento de colunas
- `df -h` — colunas largas, talvez `truncate_lines_at`
- `stat <file>` — output multi-linha, pouco útil inteiro
- `file <path>` — 1 linha, passthrough
- `wc -l *` — várias linhas, contagem simples
- `which X` / `command -v X` — 1 linha
- `realpath <path>` / `readlink -f <path>` — 1 linha

### JavaScript/TypeScript — adicional
- `npm test` / `pnpm test` / `yarn test` — wrap pra `vitest`/`jest`/etc.
- `npm run <script>` — output do script, depende
- `npm ls` / `pnpm ls` — dep tree, pode ter 1000+ linhas
- `next build` — banners + warnings + bundle stats
- `prisma migrate dev` / `prisma generate` — verbose
- `playwright test` — output similar a jest
- `prettier --check` — lista de arquivos não-formatados
- `prettier --write` — lista de arquivos formatados, pode ser longa
- `tsc --watch` — streaming, fora de escopo (não chega no BashTool)

### Rust — adicional
- `cargo test` — output diferente de `cargo build` (com `running N tests`); spec separada
- `cargo clippy` — similar a `cargo check`, mesmo filtro provável
- `cargo fmt --check` — lista de arquivos malformatados
- `cargo bench` — output de benchmark
- `cargo tree` / `cargo tree -d` — dep tree, pode ter 1000+ linhas
- `cargo metadata --format-version=1` — JSON enorme, passthrough

### Python — adicional
- `ruff check` / `ruff format` — similar a eslint, lista de problemas
- `mypy` — type errors com path + line + msg
- `pip install` — verbose com `Collecting`, `Downloading`, `Installing`
- `pip list` — pode ter 100+ pacotes
- `pip show <pkg>` — multi-linha, partes acionáveis
- `poetry install` / `poetry add` — banners
- `uv sync` — relativamente compacto
- `unittest` (`python -m unittest`) — output similar a pytest mas formato diferente

### Go
- `go test` / `go test ./...` — `=== RUN`, `--- PASS`, `--- FAIL` blocks
- `go build` — silent on success
- `go vet` — lista de issues
- `golangci-lint run` — lista de lints + paths
- `go mod tidy` — geralmente silent
- `go mod graph` — pode ter 1000+ linhas

### Containers
- `docker images` — colunas com IMAGE ID + CREATED + SIZE
- `docker build` — `Step N/M`, `Successfully built X`, layers; verboso
- `docker inspect <ct>` — JSON enorme, passthrough (já é estruturado)
- `docker stats --no-stream` — colunas com %
- `docker compose ps` — formato similar a `docker ps`
- `docker compose logs` — interleaved logs com prefixos de service
- `docker network ls` / `docker volume ls`

### Kubernetes
- `kubectl get nodes` — colunas largas com STATUS
- `kubectl get services` / `kubectl get deployments`
- `kubectl describe deployment X` — events + spec
- `kubectl top pods` — métricas de uso
- `kubectl explain X` — documentação verbose
- `helm list` — colunas com NAMESPACE + REVISION + UPDATED + STATUS
- `helm history <release>` — timestamps + revisions
- `helm get values <release>` — YAML, talvez passthrough

### Cloud CLIs
- `aws ec2 describe-instances` — JSON enorme, passthrough
- `aws s3 ls s3://bucket` — colunas com timestamp + size
- `aws s3 ls --recursive` — milhares de linhas
- `gcloud compute instances list` — formato tabular
- `gcloud projects list`
- `az vm list` — Azure, formato similar

### IaC / Infra
- `terraform plan` — diff-like (`+ resource "..."`); preservar mudanças
- `terraform apply` — output do plan + execution
- `terraform state list`
- `terraform output -json` — passthrough JSON
- `pulumi preview` / `pulumi up`
- `ansible-playbook` — `PLAY`/`TASK` blocks

### Linters / formatters cross-language
- `shellcheck` — lista de issues
- `hadolint Dockerfile` — Dockerfile linter
- `yamllint` — yaml errors
- `markdownlint` — markdown errors
- `actionlint` — github actions linter

### Sistema / processo
- `ps aux` / `ps -ef` — colunas largas, tempo + comando truncado
- `top -b -n 1` — header com averages + tabela
- `htop` — interativo, fora de escopo
- `journalctl -u <service>` — timestamps + hostname + service prefix em cada linha
- `journalctl -f` — streaming, fora de escopo
- `systemctl status <service>` — header + últimas N linhas de log com timestamps
- `systemctl list-units --failed`
- `dmesg` / `dmesg -T` — kernel ring buffer, longo
- `lsof` / `lsof -i :80` — colunas largas
- `netstat -tlnp` — formato tabular legacy
- `ss -tlnp` — replacement moderno do netstat
- `iptables -L` — regras com colunas
- `ip addr` / `ip route`
- `free -h` — pequeno, baixo ROI
- `uptime` — 1 linha
- `crontab -l` — sensível, fora de escopo

### Network
- `curl -v` — request/response headers + body; verbose mata cache
- `curl -I` — só headers, geralmente OK
- `wget -v`
- `dig <host>` — formato verboso com `;; ANSWER`, `;; AUTHORITY`
- `nslookup`
- `ping <host>` — streaming, talvez fora de escopo
- `traceroute`
- `nmap` — output longo

### Database CLIs
- `psql -c "SELECT..."` — output tabular
- `psql -c "\dt"` — lista de tabelas
- `mysql -e "..."`
- `mongosh --eval "..."`
- `redis-cli INFO` — multi-linha verboso
- `sqlite3 file.db ".schema"`

### Archive / arquivos
- `tar -tvf archive.tar` — listing, colunas com timestamps + perms (igual `ls -la`!)
- `tar -tzf archive.tar.gz` — só nomes
- `unzip -l archive.zip`
- `zip -sf archive.zip`

### Build tools (não language-specific)
- `make` — `Compiling...`, `Linking...`, recipe echoes
- `make -n` (dry run) — pode ser longo
- `cmake` / `cmake --build` — verbose
- `mvn package` / `mvn test` — banners + downloads + Maven verbosity legendária
- `gradle build` / `gradlew build` — daemon banners + tasks
- `bazel build` / `bazel test` — INFO logs prefixados
- `dotnet build` / `dotnet test` — MSBuild output
- `swift build` / `swift test` — verbose
- `xcodebuild` — extremamente verboso (Apple)

### Help / version (transversal)
- `<cmd> --help` — geralmente compacto, mas alguns têm `Examples:` longo no fim
- `<cmd> -h`
- `<cmd> --version` — geralmente 1 linha; passthrough
- `man <cmd>` — não chega via Bash usualmente, fora de escopo

### Pacotes / sistema
- `apt list` / `apt list --installed`
- `apt-cache search`
- `dpkg -l`
- `brew list`
- `brew info <pkg>`
- `rpm -qa`
- `pacman -Qe`

### Outros
- `jq '.'` — JSON pretty-print, longo dependendo do input
- `xmllint --format` — XML pretty-print
- `awk` / `sed` — output do script
- `column -t` — formatação tabular
- `head` / `tail` — caso especial: filtro só faz sentido se output do head/tail ainda for grande

## Fora de escopo

Comandos onde não vale fazer filtro Bash porque já há tool dedicada no claudin:

| Comando | Razão |
|---|---|
| `cat` / `head` / `tail` / `less` | Coberto por `FileReadTool` |
| `grep` / `rg` | Coberto por `GrepTool` |
| `sed` (read/replace) | Coberto por `FileEditTool` |
| `glob` patterns | Coberto por `GlobTool` |
| `curl` / `wget` para HTTP | Coberto por `WebFetchTool` |

## Métricas a capturar (Fase 0)

Para cada comando, antes de spec final:

1. **Frequência real** — quantas vezes aparece no `BashTool.call()` em uma semana de uso?
2. **Tamanho mediano da saída** — vale filtrar `git status` se mediana é 200 bytes?
3. **% de saídas que já caem no summarizer** — se 90% já dispara o summarizer existente, ROI marginal do filtro novo é baixo.
4. **% de saídas com `is_error: true`** — se alta, filtro vai skipar a maioria, ROI baixo.

## Como contribuir / preencher um arquivo

1. Copiar `_template.md` → `<comando>.md`
2. Coletar 2-3 amostras reais de saída (idealmente: trivial, médio, grande)
3. Anotar inline o que é sinal vs ruído
4. Propor estratégia (declarative pipeline ou native parsing)
5. Listar edge cases que conhecemos
6. Mudar status pra `analyzed`
7. Commit + PR pra revisão da spec antes de virar código
