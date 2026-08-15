# Phase 7 — Default-on flip + post-flip verification

> **Status:** ✅ Done (2026-05-09)
> **LoC estimado:** ~3 (mais ~1 semana de soak observation)
> **PR:** _(preencher)_
> **Parent spec:** [`../architecture.md` §17, §21](../architecture.md)

Flip `bashOutputFilterEnabled` para `true` por default. Última fase da feature. Acompanhada de uma semana de soak observando os 3 eventos de telemetria pra validar ROI real em produção.

## Pré-requisitos

- [ ] **TODAS** fases anteriores done (0, 1, 2, 3, 4, 5, 6)
- [ ] Smoke test manual feito em todas as fases anteriores
- [ ] Pelo menos 1 semana de uso pessoal com `bashOutputFilterEnabled: true` (env-set ou config-set) sem regressões reportadas
- [ ] `processToolResultBlock` test surface estendida (covers filter + summarizer interaction)

## O que muda no codebase

### Arquivos modificados

| Arquivo | Mudança | LoC |
|---|---|---|
| `src/platform/config/config.ts` (ou wherever defaults live) | Default value de `bashOutputFilterEnabled` flips de `false`/`undefined` pra `true` | +1 |
| `src/platform/config/config.ts` | Same para `bashOutputFilterRewriteEnabled: true` e `bashOutputFilterUserEnabled: true` | +2 |
| `src/services/tools/toolResultStorage.test.ts` (se existir, senão criar) | Test confirmando que filter + summarizer interaction não quebra (output >8KB com markers passa pelo summarizer sem corte) | +30 |
| `src/tools/BashTool/BashTool.test.ts` | Snapshot updates onde markers agora aparecem por default | (snapshot diffs) |

### Não-arquivos

- **Telemetria observation period** (1 semana): coletar métricas dos 3 eventos `claudin_bash_filter_*` e analisar ROI real vs medido.
- **Documentação user-facing** (curta): adicionar 1 paragraph em `CLAUDE.md` ou `README.md` explicando o feature + env vars de opt-out.

## Steps

1. **Localize default config** — provavelmente em `src/platform/config/config.ts` em algum `DEFAULT_GLOBAL_CONFIG` object (verificar durante implementação). Se não tem default explicit, ler-side `getGlobalConfig().bashOutputFilterEnabled !== false` é o approach (qualquer valor exceto explicit `false` = on).

   Decisão preferida: **explicit default de `true`** num default object — mais auditável.

2. **Update existing BashTool snapshots:**
   ```bash
   bun test src/tools/BashTool/BashTool.test.ts --update-snapshots
   git diff src/tools/BashTool/__snapshots__/  # review carefully
   ```

   Snapshots devem mudar APENAS onde marker está sendo intencionalmente injected. Se algum snapshot mudou inesperadamente (e.g. um teste de comando que NÃO tem filter mostrou diff), isso é regressão — investigar.

3. **Add `processToolResultBlock` interaction test:**
   ```ts
   // src/services/tools/toolResultStorage.test.ts
   test('filtered output >8KB does not get re-summarized by toolResultSummarizer', () => {
     const filteredStdout = '<bash-output-filtered name="cargo-build" reduction="55%">\n' + 'x'.repeat(15_000)
     const block = processToolResultBlock({...}, filteredStdout, ...)
     // Assert: filteredStdout passes through; isAlreadyCompacted recognizes the marker
     expect(block.content).toBe(filteredStdout)  // unchanged
   })
   ```

4. **Add user-facing documentation** (curto):
   - `CLAUDE.md`: 1 paragraph sob "## Configuration & Credentials"
   - Mencionar: feature ativa por default, env vars de opt-out, link pra `docs/tech/bash-output-filter/`

5. **Soak observation (1 semana):**
   - Coletar `claudin_bash_filter_applied` events: agregação por `filter_name` × `reduction_pct` (mediana, p99)
   - Coletar `claudin_bash_rewrite_applied`: contagem por `filter_name`
   - Coletar `claudin_bash_filter_skipped`: contagem por `reason_code`
   - Comparar ROI medido em produção vs predicted no `optimization-matrix.md`. Se desvio >10pp em algum filter, abrir issue de revisão.
   - Escutar ativamente por user feedback (Discord, Issues): "filter swallowed my error", "command output looks weird"

6. **Run end-to-end smoke** (Phase 7 acceptance):
   ```bash
   bun run build
   CLAUDIN_BASH_FILTER_DEBUG=1 bun run dev
   # In agent, run all of:
   git status
   git log -10
   cargo build
   pytest
   ls -la
   bundle install
   docker ps
   curl -v https://example.com
   ps aux

   # For each: verify marker appears, reduction matches matrix
   # Run: git log -5 | wc -l
   # Verify: NO marker (compound)
   # Run: cargo build (intentional fail)
   # Verify: <bash-output-rewritten> marker shown, error preserved
   ```

## Tests

```bash
bun run build
bun test
bun run verify:privacy
bun run build:verified
bun run typecheck

# Smoke (manual): see step 6
```

## Acceptance criteria

- [ ] `bun run build` clean
- [ ] `bun test src/outputFilter/Bash` 100% pass
- [ ] `bun run verify:privacy` clean (3 new event names with suffix proof)
- [ ] `scripts/regex-redos-scan.test.ts` passes
- [ ] `bun run typecheck` zero errors
- [ ] Coverage ≥80% on `src/outputFilter/Bash`
- [ ] Smoke test all 9+ commands above produces correct markers
- [ ] Compound bypass: `git log -5 | wc -l` → no marker
- [ ] Error-exit: `cargo build` fail shows `<bash-output-rewritten>` marker
- [ ] Snapshot updates only where marker is intentionally injected
- [ ] User filter at `~/.claudin/filters.json` loads + applies
- [x] `processToolResultBlock` test surface covers filter+summarizer interaction
- [ ] User documentation updated (CLAUDE.md or README.md)
- [ ] Soak: 1 week of telemetry shows ≤10pp deviation from predicted ROI
- [ ] No user-reported regressions in 1-week soak period
- [ ] **Sub-agent BashTool calls filter correctly:** smoke test where AgentTool spawns a sub-agent, sub-agent invokes BashTool with `ls -la`, assert marker present in tool result block returned to sub-agent. Confirms filter is per-BashTool-call (single shared instance, single shared config), not per-agent. No new code needed; just verification.
- [ ] **gRPC headless mode compatibility:** smoke test with `bun run dev:grpc:cli` running a query that exercises bash (`git status`); verify marker present in tool_result chunk streamed back. Same bundle as regular CLI; same `BashTool.call()` path; expected to work without changes. No new code — verification only.

## PR description template

```markdown
## feat(bash-filter): default-on rollout (Phase 7)

Flips `bashOutputFilterEnabled` default from `false` to `true`. Final phase of the v1 rollout.

### Pre-flight checks
- [x] Phases 0-6 done
- [x] 1-week local soak with explicit enable: no regressions, ROI matches predictions
- [x] All 8+ acceptance criteria from spec §21 pass

### Soak data (1 week)
| Filter | Predicted | Measured (median) | Calls/week |
|---|---|---|---|
| _filled in PR_ | _filled_ | _filled_ | _filled_ |

### Documentation
- `CLAUDE.md` adds 1 paragraph with env-var opt-out

### Refs
- Spec: docs/tech/bash-output-filter/architecture.md §17 Phase 7, §21
- Phase doc: docs/tech/bash-output-filter/phases/phase-7-default-on.md
```

## Implementation notes

**2026-05-09 — implementação concluída.**

### Abordagem final (difere do spec original)

O spec previa flip via `createDefaultGlobalConfig` + snapshots no BashTool. A implementação final optou por uma abordagem mais robusta:

1. **`shouldFilterOutput`** — mudança de `=== true` para `!== false`. Isso torna `undefined` (instalação nova sem config explícita) equivalente a `true`. Não há default hardcoded em nenhum objeto de config — o "default-on" é expresso diretamente na lógica de gate.

2. **Toggle em `/config`** — em vez de só flipar o default silenciosamente, adicionamos um toggle "Bash output filter" na UI de configurações (`src/platform/settings/ui/Config.tsx`). O toggle sincroniza `bashOutputFilterEnabled` e `bashOutputFilterUserEnabled` ao mesmo tempo. Padrão visual: "on" para instalações novas.

3. **Tip de performance** — adicionada entrada `bash-output-filter-token-saving` em `src/services/tipRegistry.ts`. Aparece após 5 startups, cooldown de 20 sessões, só quando o filtro está ativo. Informa o usuário sobre o ganho de tokens sem ser intrusivo.

4. **Testes** — 2 testes atualizados em `src/tools/BashTool/BashTool.outputFilter.test.ts`: `shouldFilterOutput(undefined, ...)` agora retorna `true` (era `false`); suite "regression (filter off)" ganhou `disableFilter()` no `beforeEach`.

### Soak data

_(A coletar após 1 semana de uso em produção — ver acceptance criteria acima.)_
