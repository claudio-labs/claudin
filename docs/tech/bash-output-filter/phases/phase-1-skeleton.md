# Phase 1 — Skeleton + harness port

> **Status:** ⏸ Not started
> **LoC estimado:** ~700
> **PR:** _(preencher)_
> **Parent spec:** [`../architecture.md` §3, §4, §5, §6, §13, §14](../architecture.md)

Cria o módulo `src/utils/bashOutputFilter/` com toda a infraestrutura, mas **dead code** — não é chamado pelo BashTool ainda. Ports o validation harness do discovery (67 cases) como teste de integração. Adiciona o build-time ReDoS scan.

## Pré-requisitos

- Pode rodar em paralelo com Phase 0 (não depende dele).
- **NÃO depende** de mudanças no BashTool ainda.

## O que muda no codebase

### Arquivos novos

| Arquivo | LoC est. | Conteúdo |
|---|---|---|
| `src/utils/bashOutputFilter/index.ts` | ~120 | Public API: `planFilter`, `applyFilterToStdout`, types (`FilterSpec`, `RewriteContext`, `PreExecPlan`, `PipelineResult`), inline `safeApply` |
| `src/utils/bashOutputFilter/pipeline.ts` | ~200 | 11-stage pure pipeline (port direto de [`validation/pipeline.ts`](../../../discovery/bash-output-filter/validation/pipeline.ts)) |
| `src/utils/bashOutputFilter/registry.ts` | ~70 | `findFilterForCommand`, `canonicalizeForMatching` (strip `sudo`, env vars), `matchesCommand` |
| `src/utils/bashOutputFilter/markers.ts` | ~40 | `wrapStdoutWithMarkers` reusando `escapeXmlAttr` de `src/utils/xml.ts` |
| `src/utils/bashOutputFilter/userFilters.ts` | ~140 | Stub: zod schema + safe loader. Carregamento real em Phase 6. |
| `src/utils/bashOutputFilter/filters/index.ts` | ~10 | `export const builtInFilters: FilterSpec[] = []` (vazio, populado em Phase 2/5) |
| `src/utils/bashOutputFilter/bashOutputFilter.test.ts` | ~500 | Port direto de `validation/validate.ts` — 67 cases + 3 safety + 1 rewrite test, todos rodando contra `builtInFilters: []` (vão ficar como skipped até Phase 2) |
| `src/utils/bashOutputFilter/pipeline.test.ts` | ~150 | Unit tests para cada um dos 11 estágios (puros) |
| `src/utils/bashOutputFilter/registry.test.ts` | ~80 | Linear scan, sudo prefix, env prefix, compound bypass |
| `src/utils/bashOutputFilter/markers.test.ts` | ~80 | Idempotency (don't double-wrap), XML escaping, length cap em `original`/`actual` |
| `src/utils/bashOutputFilter/__fixtures__/samples/*.txt` | (copy) | ~30 fixture files copiados de `docs/discovery/bash-output-filter/validation/samples/` |
| `scripts/regex-redos-scan.test.ts` | ~80 | Scan static de toda regex em `src/utils/bashOutputFilter/filters/` contra denylist (`safe-regex` heurística inline) |

### Arquivos modificados

Nenhum. O módulo é dead code — não tem importer ainda.

## Steps

1. **Setup do módulo:** criar `src/utils/bashOutputFilter/` + sub-folders.

2. **Port `pipeline.ts`** de `docs/discovery/bash-output-filter/validation/pipeline.ts`:
   - Copiar literal os 11 estágios
   - Trocar `collapseIdenticalRuns` e `collapseDigitTemplates` para imports de `src/utils/toolResultSummarizer.js` (Phase 0 fez o export)
   - Adicionar `logForDebugging(msg, { level: 'info' })` calls condicionais em `isEnvTruthy(process.env.CLAUDIO_BASH_FILTER_DEBUG)` em cada stage que muta
   - **Não exportar** funções privadas de stage; só `applyPipeline` e `matchesCommand`.

3. **Implementar `registry.ts`:**
   ```ts
   export function findFilterForCommand(command: string): FilterSpec | null {
     const canonical = canonicalizeForMatching(command)
     if (canonical.length === 0) return null
     for (const f of builtInFilters) {
       if (matchesCommand(f, canonical)) return f
     }
     for (const f of userFilters()) {
       if (matchesCommand(f, canonical)) return f
     }
     return null
   }

   function canonicalizeForMatching(command: string): string {
     // Strip leading env (FOO=bar), sudo, time, nice
     let c = command.trimStart()
     while (true) {
       if (/^[A-Z_][A-Z0-9_]*=/.test(c)) {
         c = c.replace(/^\S+\s+/, '')
         continue
       }
       if (/^(sudo|time|nice)\s/.test(c)) {
         c = c.replace(/^\S+\s+/, '')
         continue
       }
       break
     }
     return c
   }

   export function matchesCommand(filter: FilterSpec, command: string): boolean {
     if (filter.matchCommandReject?.test(command)) return false
     return filter.matchCommand.test(command)
   }
   ```

4. **Implementar `markers.ts`:**
   - Importar `escapeXmlAttr` de `src/utils/xml.js`
   - `wrapStdoutWithMarkers(rawStdout, plan, pipelineResult)` retorna stdout com markers prepend
   - Idempotência: skip se starts with `<persisted-output>`, `<tool-result-summary`, `<bash-output-rewritten`, `<bash-output-filtered`
   - Truncar `original`/`actual` em 200 chars com ellipsis

5. **Stub `userFilters.ts`:**
   - Define schema zod (full, conforme architecture §8)
   - Export `userFilters(): FilterSpec[]` que retorna `[]` por enquanto (carregamento real Phase 6)
   - `loadUserFilters()` é função privada inicial — só estrutura, retorna `[]`

6. **Implementar `index.ts`:**
   - Re-exportar tipos
   - `planFilter(command: string): PreExecPlan` chama `findFilterForCommand` + se filter tem `rewriteCommand`, executa com validação (não-vazio, mesmo verbo)
   - `applyFilterToStdout(rawStdout, isError, plan): string` — se plan tem filter, aplica pipeline (skip se isError), wrap com markers
   - Inline `safeApply<T>(label, raw, run): T` (~10 LoC)

7. **Port harness `bashOutputFilter.test.ts`:**
   - Copy `validation/validate.ts` arrays `CASES`, `SAFETY_TESTS`, `REWRITE_TESTS`
   - Wrap em `describe('integration harness', ...)` e `test(...)` blocks
   - Cada case usa `applyPipeline(testCase.filter, raw)` e `expect(reductionPct).toBeGreaterThanOrEqual(predicted - 5)`
   - Os filters dentro de `CASES` ficam inline na test file (não importam de `filters/` — esses serão preenchidos Phase 2)
   - **Importante:** copiar as samples para `__fixtures__/samples/`; testes lêem de path relativo

8. **Adicionar `scripts/regex-redos-scan.test.ts`:**
   - Walk `src/utils/bashOutputFilter/filters/*.ts`
   - Extract regex literals via AST (use `bun:test` ou simples regex sobre source)
   - Run safe-regex heurística inline (~80 LoC vendored): rejeita `(.+)+`, `(.*)*`, `(a+)+b` shapes
   - Fail test se algum regex hit denylist
   - Como `filters/` está vazio em Phase 1, este test passa trivialmente (smoke)

## Tests

```bash
bun test src/utils/bashOutputFilter
bun test scripts/regex-redos-scan.test.ts
bun run typecheck
bun run build  # confirma que o módulo compila no bundle (mesmo dead)
```

Coverage check:
```bash
bun run test:coverage
# Verificar que src/utils/bashOutputFilter/ tem 80%+ coverage
```

## Acceptance criteria

- [ ] `bun test src/utils/bashOutputFilter` — 100% pass (67 harness cases + 3 safety + 1 rewrite + ~30 unit tests)
- [ ] `bun run build` clean (módulo é dead code mas compila)
- [ ] `bun run typecheck` zero errors
- [ ] Coverage ≥80% no novo módulo
- [ ] `scripts/regex-redos-scan.test.ts` passa (vacuously — sem filters ainda)
- [ ] Pipeline reusa `collapseIdenticalRuns`/`collapseDigitTemplates` de `toolResultSummarizer.ts` (Phase 0 done)
- [ ] `markers.ts` reusa `escapeXmlAttr` de `src/utils/xml.ts`
- [ ] Nenhum import de fora do módulo exceto: `escapeXmlAttr`, `collapseIdenticalRuns`, `collapseDigitTemplates`, `logForDebugging`, `logError`, `isEnvTruthy`, `getGlobalConfig`, `z` (zod)
- [ ] **Locale degrade graceful test** em `pipeline.test.ts`: filter cujo `matchCommand` regex não casa (simula non-EN locale) retorna raw stdout sem exception, sem marker. Confirma fail-open natural.
- [ ] **Empty stdout early-return test** em `pipeline.test.ts`: `applyFilterToStdout('', false, plan)` retorna `''` sem marker, mesmo com filter matched. Idem `applyFilterToStdout('   \n  \n', ...)` (whitespace-only).
- [ ] **Module init performance baseline** em `bashOutputFilter.test.ts`:
  ```ts
  test('module init + first filter lookup completes under 50ms', async () => {
    const start = performance.now()
    const { findFilterForCommand } = await import('./index.js')  // forces full module load
    findFilterForCommand('git status')  // first regex compilation
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(50)  // typical: <5ms; threshold conservative
  })
  ```
  Catches regression if filter set grows pathologically or if eager import surface bloats. Real cost expected: ~1-3 ms (object literals + ~40-60 lazy RegExp = sub-ms each).

## PR description template

```markdown
## feat(bash-filter): module skeleton + integration harness (Phase 1)

Creates `src/utils/bashOutputFilter/` with the full pipeline + registry + markers + zod-validated user-filter schema (stub) + ports the discovery validation harness as the integration test. **Module is dead code** — not yet wired to BashTool. That happens in Phase 3.

### Changes
- New module at `src/utils/bashOutputFilter/`: `index.ts`, `pipeline.ts` (port of validation/pipeline.ts), `registry.ts`, `markers.ts`, `userFilters.ts` (stub)
- New test files: `bashOutputFilter.test.ts` (the harness), `pipeline.test.ts`, `registry.test.ts`, `markers.test.ts`
- New `scripts/regex-redos-scan.test.ts` to gate built-in regex against ReDoS-prone shapes
- Reuses `escapeXmlAttr` from `src/utils/xml.ts`, `collapseIdenticalRuns`/`collapseDigitTemplates` from `toolResultSummarizer.ts` (Phase 0)

### Tests
- 67 cases of integration harness pass (ROI ≥ predicted-5pp for each filter+sample)
- 3 safety tests confirm `unless` clause prevents error swallowing
- Pipeline unit tests cover each stage in isolation
- Coverage ≥80%

### Refs
- Spec: docs/tech/bash-output-filter/architecture.md §3-§6, §13
- Phase doc: docs/tech/bash-output-filter/phases/phase-1-skeleton.md
```

## Implementation notes

_(Preencher durante/após execução.)_
