# Refinamento RTK × Claudio — 6 famílias prioritárias

> Última atualização: 2026-05-13

Escopo: comparativo focado entre o conjunto declarativo do [rtk](../../../../rtk/) (handlers Rust em `src/cmds/**/*.rs` + specs TOML em `src/filters/*.toml`) e o output-filter do Claudio em [`src/outputFilter/Bash/`](../../../src/outputFilter/Bash/). Recorte explícito em 6 famílias: system utils, .NET, IaC, JVM/mobile, JS toolchain (não-teste) e linters genéricos. Test runners, git/gh, containers, rede e linters já cobertos (`ruff`, `rubocop`) ficam fora deste documento — ver [`rtk-comparison.md`](./rtk-comparison.md) para o panorama geral.

Objetivo: identificar gaps concretos onde o Claudio ainda paga tokens por output verboso e priorizar 8–12 alvos de maior ROI. Não há código novo aqui — apenas inventário, links e impacto qualitativo.

Referências cruzadas:
- Registry atual do Claudio: [`src/outputFilter/Bash/filters/index.ts`](../../../src/outputFilter/Bash/filters/index.ts)
- Exemplos de spec idiomática: [`filters/linters.ts`](../../../src/outputFilter/Bash/filters/linters.ts), [`filters/network.ts`](../../../src/outputFilter/Bash/filters/network.ts)
- Regras de implementação: [`.claudio/rules/typescript-patterns.md`](../../../.claudio/rules/typescript-patterns.md)

---

## 1. System utils

### Cobertura RTK

Handlers Rust dedicados (parsing/tree-walking, não declarativo puro):
- [`cmds/system/find_cmd.rs`](../../../../rtk/src/cmds/system/find_cmd.rs) — agrupa resultados por diretório, glob nativo.
- [`cmds/system/tree.rs`](../../../../rtk/src/cmds/system/tree.rs) — wrapper com `ignore::WalkBuilder`.
- [`cmds/system/wc_cmd.rs`](../../../../rtk/src/cmds/system/wc_cmd.rs)
- [`cmds/system/json_cmd.rs`](../../../../rtk/src/cmds/system/json_cmd.rs), [`pipe_cmd.rs`](../../../../rtk/src/cmds/system/pipe_cmd.rs), [`log_cmd.rs`](../../../../rtk/src/cmds/system/log_cmd.rs), [`read.rs`](../../../../rtk/src/cmds/system/read.rs), [`summary.rs`](../../../../rtk/src/cmds/system/summary.rs), [`env_cmd.rs`](../../../../rtk/src/cmds/system/env_cmd.rs).

Specs TOML declarativas (pipeline-only, modelo idêntico ao Claudio):
- [`filters/df.toml`](../../../../rtk/src/filters/df.toml), [`du.toml`](../../../../rtk/src/filters/du.toml), [`stat.toml`](../../../../rtk/src/filters/stat.toml), [`jq.toml`](../../../../rtk/src/filters/jq.toml), [`ping.toml`](../../../../rtk/src/filters/ping.toml), [`rsync.toml`](../../../../rtk/src/filters/rsync.toml), [`ssh.toml`](../../../../rtk/src/filters/ssh.toml).
- `cat`/`head`/`tail`/`dmesg`/`env` não têm spec dedicada — passthrough no rtk.

### Cobertura Claudio

Em [`filters/system.ts`](../../../src/outputFilter/Bash/filters/system.ts): `psAux`, `top`, `journalctl`. Em [`filters/ls.ts`](../../../src/outputFilter/Bash/filters/ls.ts): `lsLa`. Em [`filters/grep-rg.ts`](../../../src/outputFilter/Bash/filters/grep-rg.ts): `grepRg`. Em [`filters/network.ts`](../../../src/outputFilter/Bash/filters/network.ts): `curlV`, `dig`. Nenhum filter para `find`, `tree`, `wc`, `jq`, `df`, `du`, `stat`, `ping`, `rsync`, `ssh`, `dmesg`, `env`, `cat`, `head`, `tail`.

Docs já redigidos: [`commands/find.md`](./commands/find.md), [`commands/tree.md`](./commands/tree.md), [`commands/cat.md`](./commands/cat.md).

### Matriz

| comando | RTK | Claudio |
|---|---|---|
| `cat` | passthrough | passthrough — doc em [`commands/cat.md`](./commands/cat.md) |
| `head` | passthrough | passthrough |
| `tail` | passthrough | passthrough |
| `find` | sim — handler em [`find_cmd.rs`](../../../../rtk/src/cmds/system/find_cmd.rs) (agrupa por dir) | não — doc-only em [`commands/find.md`](./commands/find.md), ROI medido 0% (rebaixado) |
| `tree` | sim — handler em [`tree.rs`](../../../../rtk/src/cmds/system/tree.rs) | não — apenas [`commands/tree.md`](./commands/tree.md) |
| `wc` | parcial — handler em [`wc_cmd.rs`](../../../../rtk/src/cmds/system/wc_cmd.rs) | não |
| `jq` | sim — spec em [`jq.toml`](../../../../rtk/src/filters/jq.toml) (`max_lines=40`, `truncate=120`) | não |
| `df` | sim — [`df.toml`](../../../../rtk/src/filters/df.toml) (`max_lines=20`, `truncate=80`) | não |
| `du` | sim — [`du.toml`](../../../../rtk/src/filters/du.toml) (`max_lines=40`, blank strip) | não |
| `stat` | sim — [`stat.toml`](../../../../rtk/src/filters/stat.toml) | não |
| `ping` | sim — [`ping.toml`](../../../../rtk/src/filters/ping.toml) (`tail_lines=4`, drop per-packet) | não |
| `rsync` | sim — [`rsync.toml`](../../../../rtk/src/filters/rsync.toml) (`ok (synced)` short-circuit) | não |
| `ssh` | sim — [`ssh.toml`](../../../../rtk/src/filters/ssh.toml) (strip banners + debug + close) | não |
| `dmesg` | passthrough | passthrough |
| `env` | sim — handler em [`env_cmd.rs`](../../../../rtk/src/cmds/system/env_cmd.rs) (substring filter `-f`) | não |

### Impacto qualitativo

`ping` e `rsync` são alvos de altíssimo ROI: per-packet/per-file lines explodem para milhares em sessões reais. `ssh` em scripts CI verbosos tem o mesmo padrão de banner repetido. `df`/`du`/`stat`/`jq` são wins pequenos mas baratos de implementar (declarativo trivial). `find`/`tree` precisam de redesign mais complexo (agrupamento por diretório) e o ROI medido do `find` no Claudio é 0% — adiar. `cat`/`head`/`tail`/`dmesg`/`env` são corretos como passthrough — nada a fazer.

---

## 2. .NET

### Cobertura RTK

Handlers Rust full-blown com parsers nativos:
- [`cmds/dotnet/dotnet_cmd.rs`](../../../../rtk/src/cmds/dotnet/dotnet_cmd.rs) — entry-point para build/test/restore/format, força `DOTNET_CLI_UI_LANGUAGE=en-US`, ativa binlog/trx.
- [`cmds/dotnet/binlog.rs`](../../../../rtk/src/cmds/dotnet/binlog.rs) — parser do `.binlog` (formato binário de MSBuild) para extrair só erros/warnings.
- [`cmds/dotnet/dotnet_trx.rs`](../../../../rtk/src/cmds/dotnet/dotnet_trx.rs) — parser XML do TRX (test results) via `quick_xml`.
- [`cmds/dotnet/dotnet_format_report.rs`](../../../../rtk/src/cmds/dotnet/dotnet_format_report.rs) — parser JSON de `dotnet format --report`.

Spec TOML adicional (modo declarativo simples):
- [`filters/dotnet-build.toml`](../../../../rtk/src/filters/dotnet-build.toml) — short-circuit `ok (build succeeded)` quando `0 Warning(s) / 0 Error(s)`.

### Cobertura Claudio

Zero. Nenhum filtro em [`filters/index.ts`](../../../src/outputFilter/Bash/filters/index.ts) cobre `dotnet`. Nenhum doc em [`commands/`](./commands/).

### Matriz

| comando | RTK | Claudio |
|---|---|---|
| `dotnet build` | sim — [`dotnet_cmd.rs`](../../../../rtk/src/cmds/dotnet/dotnet_cmd.rs) + binlog + [`dotnet-build.toml`](../../../../rtk/src/filters/dotnet-build.toml) | não |
| `dotnet test` | sim — handler + TRX parser ([`dotnet_trx.rs`](../../../../rtk/src/cmds/dotnet/dotnet_trx.rs)) | não |
| `dotnet format` | sim — handler + JSON report ([`dotnet_format_report.rs`](../../../../rtk/src/cmds/dotnet/dotnet_format_report.rs)) | não |
| `dotnet restore` | sim — handler delega binlog | não |
| binlog parser | sim — [`binlog.rs`](../../../../rtk/src/cmds/dotnet/binlog.rs) (Rust nativo) | não — exigiria parser binário em TS, custo alto |
| trx parser | sim — [`dotnet_trx.rs`](../../../../rtk/src/cmds/dotnet/dotnet_trx.rs) | não — exigiria XML parsing |

### Impacto qualitativo

`dotnet build` no caso clean é caso clássico de short-circuit declarativo (mesma estrutura do `cargo build` que o Claudio já tem em [`filters/cargo.ts`](../../../src/outputFilter/Bash/filters/cargo.ts)) — viável em pipeline puro. `dotnet test` e `dotnet format` ganham muito com parser estruturado, mas isso quebra a regra "TS puro / declarativo" da v1 do Claudio — análogo à decisão de não fazer command-rewrite (ver [`rtk-comparison.md`](./rtk-comparison.md) §Por que rtk reporta % maior). Recomendação: implementar apenas o `dotnet build` declarativo no curto prazo; `test/format` ficam para v2 se a base de usuários .NET justificar.

---

## 3. IaC

### Cobertura RTK

Apenas TOML declarativo — IaC é território perfeito para o pipeline:
- [`filters/terraform-plan.toml`](../../../../rtk/src/filters/terraform-plan.toml) — strip `Refreshing state`, state lock, `# unchanged`.
- [`filters/tofu-plan.toml`](../../../../rtk/src/filters/tofu-plan.toml), [`tofu-init.toml`](../../../../rtk/src/filters/tofu-init.toml), [`tofu-fmt.toml`](../../../../rtk/src/filters/tofu-fmt.toml), [`tofu-validate.toml`](../../../../rtk/src/filters/tofu-validate.toml) — OpenTofu (fork do Terraform), padrões idênticos + `ok (valid)` short-circuit.
- [`filters/ansible-playbook.toml`](../../../../rtk/src/filters/ansible-playbook.toml) — strip `ok: [host]`/`skipping: [host]` (mantém `changed:` e `failed:`).
- [`filters/liquibase.toml`](../../../../rtk/src/filters/liquibase.toml) — strip banner ASCII + jar manifest verbose.
- [`filters/helm.toml`](../../../../rtk/src/filters/helm.toml) — strip `W0115 …` glog warnings, blanks.

### Cobertura Claudio

Zero filtros. Único doc redigido: [`commands/terraform.md`](./commands/terraform.md) (Tier 1.5, Not analyzed).

### Matriz

| comando | RTK | Claudio |
|---|---|---|
| `terraform plan` | sim — [`terraform-plan.toml`](../../../../rtk/src/filters/terraform-plan.toml) | não — doc em [`commands/terraform.md`](./commands/terraform.md) |
| `terraform apply` | parcial — não tem spec específica; passa pelo pattern de `plan` se compartilhado | não |
| `tofu plan` | sim — [`tofu-plan.toml`](../../../../rtk/src/filters/tofu-plan.toml) | não |
| `tofu init` | sim — [`tofu-init.toml`](../../../../rtk/src/filters/tofu-init.toml) | não |
| `tofu fmt` | sim — [`tofu-fmt.toml`](../../../../rtk/src/filters/tofu-fmt.toml) | não |
| `tofu validate` | sim — [`tofu-validate.toml`](../../../../rtk/src/filters/tofu-validate.toml) (`ok (valid)`) | não |
| `ansible-playbook` | sim — [`ansible-playbook.toml`](../../../../rtk/src/filters/ansible-playbook.toml) | não |
| `liquibase` | sim — [`liquibase.toml`](../../../../rtk/src/filters/liquibase.toml) | não |
| `helm` | sim — [`helm.toml`](../../../../rtk/src/filters/helm.toml) | não |

### Impacto qualitativo

`terraform plan`/`tofu plan` em runs grandes geram dezenas de KB de `Refreshing state... [id=…]` que são puro ruído — alvo de altíssimo ROI. `ansible-playbook` em playbook de N hosts emite N×M linhas `ok: [host]` que dominam o output. `helm` e `liquibase` são wins menores mas baratos. Toda a família mapeia 1:1 para o pipeline declarativo TS — nenhum parser nativo necessário.

---

## 4. JVM / mobile

### Cobertura RTK

Apenas specs TOML:
- [`filters/gradle.toml`](../../../../rtk/src/filters/gradle.toml) — strip `> Task :…UP-TO-DATE`, `NO-SOURCE`, `FROM-CACHE`, daemon banners, transforms; `on_empty="gradle: ok"`.
- [`filters/mvn-build.toml`](../../../../rtk/src/filters/mvn-build.toml) — match `^mvn\s+(compile|package|clean|install)`, strip `[INFO]` noise.
- [`filters/xcodebuild.toml`](../../../../rtk/src/filters/xcodebuild.toml) — strip CompileC/Ld/CodeSign verbose.
- [`filters/swift-build.toml`](../../../../rtk/src/filters/swift-build.toml) — short-circuit `ok (build complete)`.
- [`filters/spring-boot.toml`](../../../../rtk/src/filters/spring-boot.toml) — `keep_lines_matching` para `Started …`, `Tomcat started`, `ERROR`, `WARN`, `Exception`, `Caused by:`, `Tests run:`.

### Cobertura Claudio

Zero filtros. Docs redigidos: [`commands/gradle.md`](./commands/gradle.md), [`commands/mvn.md`](./commands/mvn.md) (ambos Tier 1.5, Not analyzed). Nada para xcodebuild/swift-build/spring-boot.

### Matriz

| comando | RTK | Claudio |
|---|---|---|
| `gradle` / `gradlew` | sim — [`gradle.toml`](../../../../rtk/src/filters/gradle.toml) | não — doc em [`commands/gradle.md`](./commands/gradle.md) |
| `mvn` (compile/package/clean/install) | sim — [`mvn-build.toml`](../../../../rtk/src/filters/mvn-build.toml) | não — doc em [`commands/mvn.md`](./commands/mvn.md) |
| `mvn test` / `verify` / `deploy` | parcial — pattern não cobre, depende de fallback | não |
| `xcodebuild` | sim — [`xcodebuild.toml`](../../../../rtk/src/filters/xcodebuild.toml) | não |
| `swift build` | sim — [`swift-build.toml`](../../../../rtk/src/filters/swift-build.toml) | não |
| `spring-boot:run` / `bootRun` / `java -jar …jar` | sim — [`spring-boot.toml`](../../../../rtk/src/filters/spring-boot.toml) | não |

### Impacto qualitativo

`mvn` tem reputação consolidada como um dos outputs mais verbosos do ecossistema (rtk estima ~80–90% de redução, registro corroborado em [`commands/mvn.md`](./commands/mvn.md)). `gradle` é menos verboso por padrão mas runs incrementais em monorepos emitem centenas de `Task :…UP-TO-DATE` — strip de uma única linha resolve. `spring-boot` boot logs em desenvolvimento são gigantes mas `keep_lines_matching` reduz para 5–10 linhas relevantes. `xcodebuild` é nicho (macOS-only) mas usuários mobile pagam pesado. `swift-build` é o alvo trivial — short-circuit declarativo simples.

---

## 5. JS toolchain (não-teste)

### Cobertura RTK

Mix de handler + spec:
- [`cmds/js/npm_cmd.rs`](../../../../rtk/src/cmds/js/npm_cmd.rs) — wrapper com auto-inject de `run` (lista hardcoded de subcomandos não-`run`).
- [`cmds/js/pnpm_cmd.rs`](../../../../rtk/src/cmds/js/pnpm_cmd.rs).
- [`cmds/js/prettier_cmd.rs`](../../../../rtk/src/cmds/js/prettier_cmd.rs) — handler que extrai apenas arquivos que precisam formatting.
- [`cmds/js/lint_cmd.rs`](../../../../rtk/src/cmds/js/lint_cmd.rs) — handler ESLint + Biome com parser JSON (`EslintMessage`/`EslintResult` via serde).
- [`cmds/js/next_cmd.rs`](../../../../rtk/src/cmds/js/next_cmd.rs) — extrai route metrics + bundle sizes via regex.
- [`cmds/js/prisma_cmd.rs`](../../../../rtk/src/cmds/js/prisma_cmd.rs) — strip ASCII art / verbose decoration.
- Specs TOML: [`oxlint.toml`](../../../../rtk/src/filters/oxlint.toml), [`biome.toml`](../../../../rtk/src/filters/biome.toml), [`turbo.toml`](../../../../rtk/src/filters/turbo.toml), [`nx.toml`](../../../../rtk/src/filters/nx.toml).
- `yarn` não tem handler/spec dedicado no rtk (passthrough).

### Cobertura Claudio

[`filters/tsc.ts`](../../../src/outputFilter/Bash/filters/tsc.ts) cobre TypeScript. ESLint é parcialmente coberto via doc [`commands/eslint.md`](./commands/eslint.md) (estimate ~40%). Sem filtros para `npm`/`pnpm`/`yarn`/`prettier`/`biome`/`oxlint`/`prisma`/`next`/`turbo`/`nx`. Docs `npm-install.md`/`npm-test.md` existem.

### Matriz

| comando | RTK | Claudio |
|---|---|---|
| `npm install` / `npm ci` | parcial — handler [`npm_cmd.rs`](../../../../rtk/src/cmds/js/npm_cmd.rs) injeta `run`; passa stdout cru | parcial — doc [`commands/npm-install.md`](./commands/npm-install.md) |
| `npm run …` | sim — auto-inject | não |
| `pnpm` | sim — [`pnpm_cmd.rs`](../../../../rtk/src/cmds/js/pnpm_cmd.rs) | não |
| `yarn` | não | não |
| `prettier --check` | sim — handler [`prettier_cmd.rs`](../../../../rtk/src/cmds/js/prettier_cmd.rs) (só files com diff) | não |
| `eslint` | sim — handler [`lint_cmd.rs`](../../../../rtk/src/cmds/js/lint_cmd.rs) (JSON parse, agrupa por rule) | parcial — doc [`commands/eslint.md`](./commands/eslint.md), 0 spec |
| `biome` | sim — TOML [`biome.toml`](../../../../rtk/src/filters/biome.toml) | não |
| `oxlint` | sim — TOML [`oxlint.toml`](../../../../rtk/src/filters/oxlint.toml) | não |
| `prisma generate` / `migrate` / `db push` | sim — handler [`prisma_cmd.rs`](../../../../rtk/src/cmds/js/prisma_cmd.rs) | não |
| `next build` | sim — handler [`next_cmd.rs`](../../../../rtk/src/cmds/js/next_cmd.rs) (extrai routes + bundles) | não |
| `turbo` | sim — TOML [`turbo.toml`](../../../../rtk/src/filters/turbo.toml) (`cache hit/miss` strip) | não |
| `nx` | sim — TOML [`nx.toml`](../../../../rtk/src/filters/nx.toml) (strip `> NX Running …`) | não |

### Impacto qualitativo

`biome`/`oxlint` são wins triviais (specs TOML quase 1:1 com os filtros declarativos já existentes do Claudio). `turbo`/`nx` em monorepos emitem `cache hit/miss, replaying logs <hash>` por package — fácil strip, alto ROI. `prettier --check` em codebase grande lista N arquivos OK que ninguém quer ver — útil mas exige short-circuit declarativo. `next build` é o mais alto valor entre os JS: bundle size table é o sinal, ~50 linhas de webpack-style noise são puro ruído; mas o handler do rtk faz extração estruturada, em TS puro daria pra fazer com `keep_lines_matching` para `Route|Size|First Load JS|warn|error`. `prisma generate` tem ASCII art notório (~30 linhas só de decoração). `yarn` segue cabendo como passthrough.

---

## 6. Linters genéricos

### Cobertura RTK

Specs TOML puras (modelo idêntico ao Claudio):
- [`filters/shellcheck.toml`](../../../../rtk/src/filters/shellcheck.toml) — só strip blank lines + `max_lines=50`.
- [`filters/hadolint.toml`](../../../../rtk/src/filters/hadolint.toml) — `truncate=120`, `max_lines=40`.
- [`filters/yamllint.toml`](../../../../rtk/src/filters/yamllint.toml) — strip blanks.
- [`filters/markdownlint.toml`](../../../../rtk/src/filters/markdownlint.toml) — strip blanks.
- [`filters/basedpyright.toml`](../../../../rtk/src/filters/basedpyright.toml) — strip header/`Searching for source files`/`Found N source files`/version banner; `on_empty="basedpyright: ok"`.

### Cobertura Claudio

Em [`filters/linters.ts`](../../../src/outputFilter/Bash/filters/linters.ts): `rubocop`, `ruffCheck`. Doc separado para [`commands/mypy.md`](./commands/mypy.md) (Python type-checker do mesmo nicho que `basedpyright`). Sem cobertura para `shellcheck`/`hadolint`/`yamllint`/`markdownlint`/`basedpyright`.

### Matriz

| comando | RTK | Claudio |
|---|---|---|
| `shellcheck` | sim — [`shellcheck.toml`](../../../../rtk/src/filters/shellcheck.toml) | não |
| `hadolint` | sim — [`hadolint.toml`](../../../../rtk/src/filters/hadolint.toml) | não |
| `yamllint` | sim — [`yamllint.toml`](../../../../rtk/src/filters/yamllint.toml) | não |
| `markdownlint` | sim — [`markdownlint.toml`](../../../../rtk/src/filters/markdownlint.toml) | não |
| `basedpyright` | sim — [`basedpyright.toml`](../../../../rtk/src/filters/basedpyright.toml) | não |

### Impacto qualitativo

ROI individual baixo-a-médio — esses linters já emitem output relativamente denso. O ganho real é uniformidade: usuário roda `basedpyright` em CI grande e paga 5–10 linhas de banner por execução; `shellcheck` em script-heavy repos repete blank lines entre cada diagnostic. Implementação é a mais barata do documento — cinco filtros idênticos em estrutura ao [`ruffCheck`](../../../src/outputFilter/Bash/filters/linters.ts) atual.

---

## Resumo

| família | comandos no escopo | cobertos no RTK | cobertos no Claudio | gap |
|---|---:|---:|---:|---:|
| System utils | 15 | 9 (6 TOML + 3 handler) | 0 | 9 |
| .NET | 4 + 2 parsers | 4 + 2 | 0 | 4 (binlog/trx fora) |
| IaC | 9 | 9 | 0 | 9 |
| JVM / mobile | 6 | 6 | 0 | 6 |
| JS toolchain | 12 | 11 | 1 (eslint, parcial via doc) | 10 |
| Linters genéricos | 5 | 5 | 0 | 5 |
| **Total** | **51** | **46** | **1 parcial** | **~43** |

O gap é dominado por specs declarativas trivialmente portáveis. Os únicos casos que exigem parser estruturado (e portanto ficariam fora da v1) são `dotnet test` (TRX/XML), `dotnet build` com binlog binário, `next build` com extração de bundle table e `eslint` com agrupamento por rule via JSON.

---

## Top priorities (8–12 comandos)

Ordem por ROI estimado × custo de implementação. Todos viáveis como spec declarativa TS pura, exceto onde marcado.

1. **`terraform plan` / `tofu plan`** — ALTO. Refreshing state lines dominam runs reais em qualquer infra não-trivial; padrão pronto em [`terraform-plan.toml`](../../../../rtk/src/filters/terraform-plan.toml) e [`tofu-plan.toml`](../../../../rtk/src/filters/tofu-plan.toml). Doc Claudio: [`commands/terraform.md`](./commands/terraform.md).
2. **`mvn` (compile/package/install)** — ALTO. Maven é caso clássico de output verboso; rtk estima 80–90% via [`mvn-build.toml`](../../../../rtk/src/filters/mvn-build.toml). Doc Claudio: [`commands/mvn.md`](./commands/mvn.md).
3. **`ansible-playbook`** — ALTO. N×M linhas `ok: [host]` em playbooks reais; spec curta em [`ansible-playbook.toml`](../../../../rtk/src/filters/ansible-playbook.toml). Sem doc no Claudio.
4. **`gradle` / `gradlew`** — ALTO. `> Task :…UP-TO-DATE` repete por dezenas de tasks em monorepos; [`gradle.toml`](../../../../rtk/src/filters/gradle.toml) cobre todos os padrões. Doc Claudio: [`commands/gradle.md`](./commands/gradle.md).
5. **`biome` + `oxlint`** — MÉDIO (par). Wins independentes, baratos, estrutura idêntica a [`ruffCheck`](../../../src/outputFilter/Bash/filters/linters.ts). Refs: [`biome.toml`](../../../../rtk/src/filters/biome.toml), [`oxlint.toml`](../../../../rtk/src/filters/oxlint.toml). Sem doc no Claudio.
6. **`ping`** — MÉDIO. Per-packet flood é alto-volume em troubleshoot; `tail_lines=4` reduz drasticamente. Ref: [`ping.toml`](../../../../rtk/src/filters/ping.toml). Sem doc.
7. **`rsync`** — MÉDIO. `ok (synced)` short-circuit + per-file strip; padrão pronto em [`rsync.toml`](../../../../rtk/src/filters/rsync.toml). Sem doc.
8. **`turbo` + `nx`** — MÉDIO (par). `cache hit/miss, replaying logs <hash>` por package vira pure ruído em monorepos; specs prontas em [`turbo.toml`](../../../../rtk/src/filters/turbo.toml), [`nx.toml`](../../../../rtk/src/filters/nx.toml). Sem doc.
9. **`dotnet build`** — MÉDIO. Versão declarativa (sem binlog) já tem 80%+ do valor; ref: [`dotnet-build.toml`](../../../../rtk/src/filters/dotnet-build.toml). Sem doc no Claudio. Versão com parser binlog fica para v2.
10. **`shellcheck` + `hadolint` + `yamllint` + `markdownlint` + `basedpyright`** — MÉDIO (pacote único). Cinco filtros declarativos quase idênticos, implementáveis em uma única PR seguindo o template de [`filters/linters.ts`](../../../src/outputFilter/Bash/filters/linters.ts). Refs nos `.toml` correspondentes.
11. **`spring-boot` (`mvn spring-boot:run` / `java -jar …jar` / `bootRun`)** — MÉDIO. `keep_lines_matching` reduz boot log a 5–10 linhas relevantes; ref: [`spring-boot.toml`](../../../../rtk/src/filters/spring-boot.toml). Sem doc.
12. **`prisma generate` / `migrate dev`** — MÉDIO-BAIXO. ASCII art + decoração; alvo bonus se o usuário-base usa Prisma. Ref: [`prisma_cmd.rs`](../../../../rtk/src/cmds/js/prisma_cmd.rs) (handler — em TS daria spec declarativa simples). Sem doc.

Adiar para v2 ou descartar: `next build` (precisa de extração estruturada de bundle table), `dotnet test`/`dotnet format` (TRX/JSON parsers), `find`/`tree` (agrupamento por diretório — ROI medido baixo no Claudio), `xcodebuild` (público pequeno), `eslint` JSON-grouping (decisão command-rewrite, ver [`rtk-comparison.md`](./rtk-comparison.md)).

---

## Padrão de implementação

Todos os filtros priorizados acima cabem no mesmo molde declarativo já validado no Claudio. Como template, ver:

- [`src/outputFilter/Bash/filters/linters.ts`](../../../src/outputFilter/Bash/filters/linters.ts) — `rubocop`/`ruffCheck` exemplificam: regex `MATCH` ao topo, `stripLinesMatching` lista, `matchOutput` com `unless` para não engolir erros, `matchCommandReject` para passthrough quando o usuário pediu output estruturado.
- [`src/outputFilter/Bash/filters/network.ts`](../../../src/outputFilter/Bash/filters/network.ts) — `curlV`/`dig` exemplificam: regex modular, `matchCommandReject` para flags incompatíveis, `maxLines` como teto duro.

Regras obrigatórias (de [`.claudio/rules/typescript-patterns.md`](../../../.claudio/rules/typescript-patterns.md)):

- Regex sempre em nível de módulo (`const FOO_RE = /…/`), nunca dentro de função.
- Sem `any`; usar `FilterSpec` tipado de [`../types.js`](../../../src/outputFilter/Bash/types.ts).
- Fallback pattern obrigatório no pipeline: falha no filter retorna raw output, nunca bloqueia o usuário.
- Toda spec nova exige spec test colocada (Bun runner, snapshot ou expect direto). Modelo: snapshots ao redor de cada `filters/*.ts` no diretório.
- Registrar em [`filters/index.ts`](../../../src/outputFilter/Bash/filters/index.ts) respeitando ordem (mais específico antes do mais genérico onde houver risco de overlap de `matchCommand`).
- `matchCommandReject` é obrigatório para qualquer filter que possa colidir com flags machine-readable (`--json`, `--output-format=json`, `--quiet`, `--silent`).
