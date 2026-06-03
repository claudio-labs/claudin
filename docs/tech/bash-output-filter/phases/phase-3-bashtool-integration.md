# Phase 3 — BashTool integration (pipeline only, no rewrite)

> **Status:** ⏸ Not started
> **LoC estimado:** ~30
> **PR:** _(preencher)_
> **Parent spec:** [`../architecture.md` §2, §6](../architecture.md)

Wire o pipeline (Phase 1+2) ao BashTool real. Pipeline only — rewrite vem em Phase 4. Default config: `bashOutputFilterEnabled: false`. Smoke test com env var.

## Pré-requisitos

- [ ] Phase 0 done (config keys registered, isAlreadyCompacted extended)
- [ ] Phase 1 done (skeleton + harness)
- [ ] Phase 2 done (filter registry populated com pelo menos 5 specs)

## O que muda no codebase

### Arquivos modificados

| Arquivo | Linha aprox. | Mudança | LoC |
|---|---|---|---|
| `src/tools/BashTool/BashTool.tsx` | ~line 720 (após `result = generatorResult.value`) | Inserir 1 chamada: `result.stdout = applyFilterToStdout(result.stdout, result.isError, plan)` onde `plan` foi capturado em scope (Phase 4 vai adicionar a captura; Phase 3 só usa um stub `plan: PreExecPlan = { effectiveCommand: input.command, filter: findFilterForCommand(input.command), rewrite: null }`) | +5 |
| `src/tools/BashTool/BashTool.tsx` | imports | Adicionar `import { planFilter, applyFilterToStdout } from 'src/outputFilter/Bash/index.js'` | +1 |
| `src/tools/BashTool/BashTool.test.ts` | (existing) | 3 novos casos: filter applied (default-off), filter applied (env var enabled), kill switch | +50 |

### Notas

- Em Phase 3, `planFilter` ainda não é usado (rewrite é Phase 4). Só `applyFilterToStdout` com plan stub. **Mas reservamos o nome `plan` aqui** pra Phase 4 só substituir o stub pelo `planFilter(input.command)` real.
- O env var `CLAUDIN_DISABLE_BASH_OUTPUT_FILTER` é checado dentro de `applyFilterToStdout` (centraliza no módulo) — BashTool não precisa fazer check.

## Steps

1. **Editar `BashTool.tsx` imports:**
   ```ts
   import {
     applyFilterToStdout,
     findFilterForCommand,
     type PreExecPlan,
   } from 'src/outputFilter/Bash/index.js'
   ```

2. **No `async call()`, após `result = generatorResult.value` (~line 720):**
   ```ts
   result = generatorResult.value

   // === NEW: bash output filter (Phase 3 — pipeline only, no rewrite yet) ===
   // Skip filter for background tasks (preview only) and structured-content paths
   const shouldFilter =
     !result.backgroundTaskId &&
     !(result.structuredContent && result.structuredContent.length > 0)

   if (shouldFilter) {
     const filterPlan: PreExecPlan = {
       effectiveCommand: input.command,
       filter: findFilterForCommand(input.command),
       rewrite: null,
     }
     result.stdout = applyFilterToStdout(result.stdout, result.isError ?? false, filterPlan)
   }
   // === END ===

   trackGitOperations(input.command, result.code, result.stdout)
   // ...rest unchanged...
   ```

   Nota: `applyFilterToStdout` retorna `result.stdout` unchanged se:
   - `bashOutputFilterEnabled: false` (default em Phase 3)
   - `CLAUDIN_DISABLE_BASH_OUTPUT_FILTER=1`
   - `filterPlan.filter === null` (no match)
   - **`rawStdout.trim() === ''`** (empty output — `mkdir`, `touch`, etc.)
   - Pipeline throws (fail-open)

   `_simulatedSedEdit` já é bypassed upstream (BashTool.call retorna em ~line 638).
   `isImage` resulta em mapToolResult ignorar `result.stdout` (line 585) — filter já rodou mas marker fica unused; sem regressão.

3. **Adicionar 3 testes em `BashTool.test.ts`:**
   ```ts
   describe('bash output filter integration', () => {
     test('does NOT apply filter when bashOutputFilterEnabled is false (default)', async () => {
       // Mock getGlobalConfig to return { bashOutputFilterEnabled: false }
       // Run a command that would match a filter (e.g. ls -la)
       // Assert stdout has NO marker
     })

     test('applies filter when bashOutputFilterEnabled is true', async () => {
       // Mock config to enable
       // Run ls -la
       // Assert stdout starts with `<bash-output-filtered name="ls-la"`
     })

     test('CLAUDIN_DISABLE_BASH_OUTPUT_FILTER=1 overrides config', async () => {
       // process.env.CLAUDIN_DISABLE_BASH_OUTPUT_FILTER = '1'
       // Mock config enable
       // Run ls -la
       // Assert stdout has NO marker (env var wins)
       // Cleanup env var
     })
   })
   ```

4. **Adicionar test pra error path** (não-blocking; fica como TODO se difícil de mockar `interpretationResult.isError`):
   ```ts
   test('filter applies even when isError is true (error path)', async () => {
     // Run a command that fails (cargo build on broken code)
     // Mock filter enabled
     // Assert: stdout has marker, but pipeline did not collapse error content
   })
   ```

5. **Smoke test manual:**
   ```bash
   bun run build
   CLAUDIN_BASH_FILTER_DEBUG=1 bun run dev
   # In the agent, ask it to run `ls -la /tmp`
   # Verify debug log shows filter chosen + reduction
   # Verify model sees `<bash-output-filtered name="ls-la" reduction="...">` at start of output
   ```

## Tests

```bash
bun test src/tools/BashTool/BashTool.test.ts
bun test src/outputFilter/Bash
bun run typecheck
bun run build:verified  # confirma privacy verifier ainda passa
```

## Acceptance criteria

- [ ] BashTool.tsx mudou em exatamente 2 lugares: imports + call() body (~10 LoC total com guards)
- [ ] Default config (`enabled: false`): nenhum marker aparece em output normal
- [ ] Env var `CLAUDIN_DISABLE_BASH_OUTPUT_FILTER=1` desliga mesmo com config enabled
- [ ] Env var `CLAUDIN_BASH_FILTER_DEBUG=1` emite log lines para cada filter decision
- [ ] Smoke test manual: `ls -la /tmp` com filter enabled produz `<bash-output-filtered>` marker
- [ ] **Skip guards funcionando:**
  - [ ] `backgroundTaskId` set → no filter, no marker
  - [ ] `structuredContent` non-empty → no filter, no marker
  - [ ] Empty stdout (`mkdir foo` → ''): `applyFilterToStdout` early-return, no marker
- [ ] Existing BashTool tests passam (snapshot updates só onde marker é intencional)
- [ ] `bun run build:verified` clean

## PR description template

```markdown
## feat(bash-filter): wire pipeline to BashTool (Phase 3, pipeline only)

Connects the bash-output-filter module to `BashTool.call()`. Pipeline runs after `runShellCommand` and prepends `<bash-output-filtered>` markers to `result.stdout`. Rewrite layer comes in Phase 4.

### Default behavior
**`bashOutputFilterEnabled: false`** by default. Filter is dead in production until Phase 7 flips the default.

### How it works
- `BashTool.call()` calls `findFilterForCommand(input.command)` after stdout capture
- If a filter matches and config is enabled, runs `applyFilterToStdout` which: applies pipeline, prepends marker, returns the new stdout
- Markers travel with stdout through both success path (`mapToolResult`) and error path (`ShellError`) — no other touchpoints

### Tests
- 3 new BashTool tests: default-off, env-enabled, kill-switch
- Smoke: `CLAUDIN_BASH_FILTER_DEBUG=1` shows filter decisions
- Existing tests pass (no snapshot changes — filter is off by default)

### Refs
- Spec: docs/tech/bash-output-filter/architecture.md §2 (integration), §6 (pipeline coordination)
- Phase doc: docs/tech/bash-output-filter/phases/phase-3-bashtool-integration.md
```

## Implementation notes

_(Preencher durante/após execução.)_
