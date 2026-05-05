# Discovery: Bash Output Filter (command-aware)

> **Status:** discovery **fechado em 2026-05-05** com cobertura empírica considerada suficiente. Tier 1.5 (16 comandos sem dados reais) fica como "follow-up via Fase 0 telemetria ou installs futuros". Spec técnica da v1 em [`docs/tech/bash-output-filter/architecture.md`](../../tech/bash-output-filter/architecture.md). Implementação ainda não iniciada.
> **Última atualização:** 2026-05-05

## Contexto

Trazer para o claudio a ideia central do [rtk (Rust Token Killer)](https://github.com/rtk-ai/rtk): filtrar a saída de comandos shell **antes** de enviá-la ao modelo, usando regras específicas por comando, para economizar tokens.

Hoje o claudio tem um `toolResultSummarizer` (`src/utils/toolResultSummarizer.ts`) que comprime saídas grandes — mas é **reativo por threshold** e **agnóstico ao comando**. A proposta é adicionar um filtro **proativo** e **command-aware** que rode antes do summarizer.

## Por que vale o discovery (e não cair direto no código)

- Muitas decisões abertas que mudam o escopo em ordens de grandeza (TOML vs JSON, filtros de projeto vs só global, native filters vs pipeline declarativo).
- Risco real de regressão: filtro mal calibrado engole stack trace, mascara warning relevante, ou trunca JSON.
- Sem dado nenhum sobre quais comandos realmente dominam o uso de Bash em sessões claudio reais — pode ser que a long tail seja maior que os top-10 do rtk.

## Arquivos

| Arquivo | O que tem |
|---|---|
| [`analysis.md`](analysis.md) | O que já sabemos: problema, estado atual do claudio, prior art do rtk, pontos de integração concretos no código |
| [`open-questions.md`](open-questions.md) | Decisões abertas (formato, escopo, trust, default on/off) + plano de validação Fase 0 |
| [`commands/`](commands/README.md) | Catálogo de comandos compressíveis — um arquivo por comando candidato com sample output, sinal vs ruído, estratégia, edge cases |
| [`optimization-matrix.md`](optimization-matrix.md) | **Matriz consolidada P/R/M/D por comando** — tabela mestre com cada estratégia aplicável e seu ROI. Saída direta pra spec da v1. |
| [`rewrite-design.md`](rewrite-design.md) | **Design técnico do command rewrite** — onde plugar no BashTool, fluxo completo, edge cases, marker `<bash-output-rewritten>`, env vars/config. ~25 LoC no BashTool + ~250 LoC nos filter specs. |
| [`dedup-features.md`](dedup-features.md) | **Detecção dinâmica de redundância** — collapseRuns + collapseDigitTemplates + dedupGlobal. Para logs/errors com linhas duplicadas que regex predefinida não cobre. |
| [`rtk-comparison.md`](rtk-comparison.md) | **Auditoria item-por-item vs rtk's command list** — gaps identificados, regras compartilhadas vs divergentes (command rewrite), por que rtk reporta % maior em ruff/go test. |
| [`validation/`](validation/README.md) | **Harness de validação empírica** — pipeline.ts + validate.ts. Roda os filtros propostos contra samples reais e reporta delta de reduction esperada vs medida. **35/35 cases passing + 3/3 safety tests.** |

## Decisões fechadas até agora

_Nenhuma decisão de produto/escopo. Mas achados empíricos já refinaram a Tier 1 — ver `commands/README.md`._

## Próximos passos

**Discovery fechado.** Próximas ações:

1. **Usuário responder as 5 perguntas em [`open-questions.md`](open-questions.md)** — formato (TS+JSON vs TOML), escopo v1 (3 nativos + 7 declarativos?), filtros de projeto, default on/off, comando `/savings`.
2. **Spec detalhada em `docs/plans/bash-output-filter.md`** com base nas respostas + tier ranking medido + design do pipeline (já speccado em `validation/pipeline.ts`).
3. **Tier 1.5 vira backlog** — comandos sem dados reais ficam como follow-up:
   - Via Fase 0 telemetria (medir uso real em produção via `claudio_bash_command_first_verb` event)
   - Via installs locais conforme demanda
   - Via PRs de comunidade que tenham os tools instalados
4. **MVP da v1 implementa Tier 1 validado** (~20 comandos com ROI medido) — `validation/pipeline.ts` é literalmente a base.

## Cobertura final do discovery

- **46 cases pipeline** validados empiricamente (100% passing)
- **3 safety tests** (errors não engolidos por `match_output`)
- **30+ samples reais** capturados em `validation/samples/`
- **35 arquivos `commands/*.md`** com análise de cada comando candidato
- **3 estágios novos de dedup** prototipados (`collapseRuns`, `collapseDigitTemplates`, `dedupGlobal`)
- **Pipeline reference implementation** em TypeScript (~250 linhas) — seed do MVP

## Log de decisões

| Data | Decisão | Quem | Por quê |
|------|---------|------|---------|
| 2026-05-05 | `git diff` rebaixado pra Tier 2 | discovery | Medição: 6.677 bytes → ~6.400 (4% redução). Diff é puro sinal, só index hashes removíveis. |
| 2026-05-05 | `find` rebaixado pra Tier 2 | discovery | Medição: user-filtered já é puro sinal (0% redução). claudio tem `GlobTool` dedicado. |
| 2026-05-05 | `docker ps` rebaixado pra Tier 2 | discovery | Medição: 30% redução real vs 80% reportado por rtk. Nomes/imagens/portas incompressíveis. |
| 2026-05-05 | `bun install` excluído do conjunto built-in | discovery | Output já máximo compacto (96 bytes pra 505 packages). Filtro só adicionaria overhead. |
| 2026-05-05 | `git log` confirmado Tier 1 com Opção A (`--oneline`) | discovery | Medição: 9.220 bytes → 680 bytes = **92% redução**. ROI mais alto medido. |
| 2026-05-05 | `ls -la` confirmado Tier 1 com native parser | discovery | Medição: 1.985 bytes → ~250 bytes = **87% redução**. Validado em projeto real. |
| 2026-05-05 | `ps aux` adicionado Tier 1.5 com strip de kernel threads | discovery | Medição: 90.860 bytes → ~12.000 = **87% redução** com `maxLines: 50` + strip kthreads. |
| 2026-05-05 | `tsc --noEmit` flagged como caso especial | discovery | Medição: 590KB de output mas só ~15% comprimível. Recomendar como **strategy do summarizer**, não filtro Bash. |
| 2026-05-05 | `journalctl -u <svc>` adicionado Tier 1.5 | discovery | Medição: ~41% redução strippando hostname + service prefix. Não coberto pelo rtk — feature exclusiva. |
| 2026-05-05 | `du -h`, `df -h`, `bun install`, `git --version`, `pwd`, `whoami` movidos pra zero-ROI skiplist | discovery | Medição empírica: já compactos. Filtro só adicionaria overhead. Documentado em `commands/_zero-roi-skiplist.md`. |
| 2026-05-05 | Catálogo expandido com ~60 candidatos | discovery | Inclui agora: gh family, k8s, terraform, mvn/gradle, journalctl, todos linters JS, todos cloud CLIs. |
| 2026-05-05 | `mvn` candidato Tier 1 com ROI excepcional estimado | discovery | Padrão `[INFO]` + downloads + plugin headers + `match_output` BUILD SUCCESS = ~99% no caso comum. rtk filter copy-paste serve. |
| 2026-05-05 | `gradle` candidato Tier 1 com ROI alto estimado | discovery | UP-TO-DATE/NO-SOURCE/FROM-CACHE dominam build incremental + `match_output` BUILD SUCCESSFUL = ~99%. |
| 2026-05-05 | `terraform` candidato Tier 1 — ROI bimodal | discovery | "no changes" = 97%; com mudanças = 37-67%. State lock + Refreshing são noise puro. |
| 2026-05-05 | `kubectl` permanece Tier 1.5 — ROI moderado | discovery | `describe` reduz 60%; `get` 0-50% depende do tamanho; `logs` é caso de summarizer, não filter. rtk parser nativo de `-o json` é o ideal v2. |
| 2026-05-05 | `git commit` Tier 1 com `match_output` agressivo | discovery | rtk colapsa pra `ok HASH`. Adoção de Opção A: ~90-99% redução, ganho cumulativo (commits são frequentes). |
| 2026-05-05 | `git push` Tier 1 com Opção B (preserva PR URL) | discovery | rtk colapsa pra `ok branch -> branch`; preferimos preservar `remote:` warnings + PR creation URL. ~80% redução, mais segurança que rtk. |
| 2026-05-05 | `unless` clause é a feature crítica de segurança | discovery | Confirmado em git-commit (hooks failure), git-push (rejection), terraform (apply errors), mvn/gradle (build failed). Engolir error sem `unless` quebra workflow. |
| 2026-05-05 | `cat`/`head`/`tail`/`read` movidos pra zero-ROI skiplist | discovery | Output é file content puro. claudio tem FileReadTool. summarizer cobre big files via threshold. |
| 2026-05-05 | `git add` movido pra zero-ROI skiplist | discovery | Silent on success no caso normal. Cumulative win <1KB/sessão. |
| 2026-05-05 | `rg` (ripgrep) movido pra zero-ROI skiplist | discovery | Já compacto by design — 564 bytes pra 7 matches. Filter só faz sentido pra `grep` legacy com paths absolutos. |
| 2026-05-05 | `cargo test` Tier 1 com `match_output` all-passed | discovery | Compile lines + test ... ok lines = 95%+ noise. Same approach que pytest. Filter delega `--no-run` pro cargo-build. |
| 2026-05-05 | `npm test` precisa **encadeamento de filters** ou match-pattern de framework cobrindo wrappers | discovery | Wrapper strip sozinho dá ~10%; real win precisa filter framework rodar depois. Decisão de design importante pra v1. |
| 2026-05-05 | `bun test` confirmado zero-ROI (junto com `bun install`) | discovery | bun é compacto by design across the board. |
| 2026-05-05 | Validation harness implementado em TypeScript | discovery | `validation/pipeline.ts` (~150 linhas) + `validate.ts` com 23 cases + 3 safety tests. Pipeline é seed da implementação real da v1. |
| 2026-05-05 | Predições inicialmente erradas em 4 comandos — corrigidas pela validação | discovery | (1) tsc: 15% → 1% (sample tinha pouco hint); (2) cargo-test-norun: 60% → 0% (Compiling do main crate respeitada corretamente); (3) git-log Opção A: 92% só com command-rewrite (não testável em pipeline puro); (4) rg: predição assumiu paths relativos mas sample tinha absoluto. **Confirma valor da validação: ROI estimado intuitivamente é frequentemente errado.** |
| 2026-05-05 | Safety tests (3) passando | discovery | `unless` clause confirmada em cargo-build (warning preserved), cargo-build (error preserved), git-status (Unmerged paths preservado). |
| 2026-05-05 | +7 comandos (rodada 3): docker-logs/images/build, curl, make, top, mypy | discovery | docker-logs 19% medido (predição original 40% errada), curl 54%, top 52%. Confirma: `top` usa formato diferente de `ps aux` — strip de kernel threads precisa regex de zeros (VIRT/RES/SHR), não brackets. |
| 2026-05-05 | Validador agora cobre 29 cases — 100% passing | discovery | Cada nova rodada de descobertas é regenerada via `bun run validate.ts`. Pipeline.ts é seed do MVP da v1. |
| 2026-05-05 | Dedup features adicionadas ao pipeline (3 estágios) | discovery | `collapseRuns` (default-on), `collapseDigitTemplates` (opt-in, minRun=5), `dedupGlobal` (opt-in agressivo). Trazidas do `toolResultSummarizer.ts` existente; valor real medido em retry loops e progress bars (71-77% sozinho), modesto quando combinado com filter command-aware (+3pp em cargo). Cycle detection adiada pra v2. Validation: 37/37 cases passing. |
| 2026-05-05 | +9 comandos validados empiricamente (rodada 4) | discovery | dig 51%, git blame 25%, git show 3%, pytest clean **95%** (`match_output` "all passed"), ruff (clean ~0% / errors ~0% — já compacto by design), bun test 1%, git branch passthrough, jq passthrough. **Achado:** ruff é tão compacto que filter quase não tem o que cortar; pytest match_output funciona perfeitamente; git blame regex precisa contemplar boundary commits (`^abc1234` 7-char). |
| 2026-05-05 | Validador agora cobre 46 cases — 100% passing | discovery | Comandos com dados reais agora: 30+. Estimados only: ~10. Já cobrimos top frequência de workflows típicos de agente. |
| 2026-05-05 | **Discovery fechado** — Tier 1.5 (estimate-only) vira backlog | discovery | Decisão: parar de adicionar novos comandos sem dados reais. 16 comandos no `commands/*.md` ficam em Tier 1.5 (mvn, gradle, terraform, kubectl, helm, gh-pr-list, vitest, eslint, go-test, docker-build, make, mypy, npm-test, npm-install, tree, git-commit, git-push). Promover individualmente quando sample real for capturado (Fase 0 telemetria ou install local). MVP da v1 implementa só Tier 1 validado (~20 comandos com ROI medido). |
| 2026-05-05 | Família git completa cobertura: 17 subcommands validados | discovery | Adicionados ao validator: git tag, remote, worktree, config --list, reflog, show full, fetch --dry-run, clean -nd. Todos passthrough (0%) — confirma "git é compacto by design em informativos". 3 .md novos: git-blame.md (25% medido), git-show.md (2-3%), git-misc.md (agrupa os 9 passthrough). 54/54 cases passing. |
| 2026-05-05 | Auditoria vs lista completa do rtk + 5 comandos novos validados | discovery | wget 72%, pip list/outdated 0%, env 0%, jq 0%. Documento `rtk-comparison.md` lista todos gaps. Estratégias compartilhadas (pipeline) vs diferentes (rtk faz command-rewrite forçando -json/--format pra ganhos extras de 50-70pp em ruff/cargo). 59/59 cases passing. |
| 2026-05-05 | +7 comandos com install local (rodada 7) | discovery | Instalados: ruby gems (rubocop, rspec, bundler, erb), go (via mise), golangci-lint v1.64.8 (curl). Validados: cargo clippy 0% (warnings = sinal puro), prettier 7%, **rubocop 83%** (preamble "new cops" domina), **rspec 73%** (`match_output`), **bundle install 96%** (`match_output`), go test 82%, golangci-lint 0%. 66/66 cases passing. |
| 2026-05-05 | **Matriz de otimização consolidada** + git-pull adicionado | discovery | `optimization-matrix.md` lista cada comando com estratégias P/R/M/D aplicáveis e ROI por estratégia. Notação padronizada: P=Pipeline, R=Rewrite, M=Match-output, D=Dedup. Tabela é input direto pra spec v1. `git-pull.md` fecha único gap real de cobertura git (51% medido em sample sintético). 67/67 cases passing. |
| 2026-05-05 | **✅ Q2 decidida: aceita Rewrite (R) na v1** | user + discovery | Justificativa: gap de 50-90pp em git-log, git-status, ruff, gh, kubectl-get, cargo-build (JSON). Design técnico em `rewrite-design.md`: hook em `BashTool.call()` antes de `runShellCommand`, propaga `rewriteInfo` pro mapToolResult que injeta marker `<bash-output-rewritten filter="..." original="..." actual="...">`. ~25 LoC BashTool + ~250 LoC specs. Edge cases: skip rewrite em compound commands (`|`, `&&`, `;`); permission check sobre comando ORIGINAL; matchCommandReject preserva user intent quando flags conflitam. |
| 2026-05-05 | rewriteCommand adicionado ao pipeline + 1 rewrite test passing | discovery | `pipeline.ts` ganhou `rewriteCommand?: (ctx) => string \| null`, `parseBashCommand`, `hasCompound`, `maybeRewrite`. Validator agora roda rewrite tests separados. Primeiro teste: git-log default → --oneline = **92% redução** confirmada (9.220 → 696 bytes via samples reais). 67 pipeline + 3 safety + 1 rewrite = 71 cases passing. |

## Referências

- Projeto rtk: `/home/viudes/projects/rtk/` (clone local)
- rtk pipeline declarativo: `src/core/toml_filter.rs`
- rtk trust system: `src/hooks/trust.rs`
- claudio summarizer: `src/utils/toolResultSummarizer.ts`
- claudio chokepoint: `src/utils/toolResultStorage.ts:225` (`processToolResultBlock`)
- claudio Bash mapeamento: `src/tools/BashTool/BashTool.tsx:563`
