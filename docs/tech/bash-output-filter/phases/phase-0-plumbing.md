# Phase 0 — Plumbing

> **Status:** ⏸ Not started
> **LoC estimado:** ~10
> **PR:** _(preencher)_
> **Parent spec:** [`../architecture.md` §10, §12, §17](../architecture.md)

Preparação trivial mas essencial. Sem essa fase, todas as outras esbarram em "summarizer engole nosso marker" ou "config key não reconhecida".

## Pré-requisitos

Nenhum — pode rodar em paralelo com Phase 1.

## O que muda no codebase

| Arquivo | Linha aprox. | Mudança | LoC |
|---|---|---|---|
| `src/services/tools/toolResultSummarizer.ts` | 242-248 (`isAlreadyCompacted`) | Adicionar 2 checks de `startsWith` para reconhecer markers do filter | +2 |
| `src/services/tools/toolResultSummarizer.ts` | 475-533 (collapse helpers) | Adicionar `export` em `collapseIdenticalRuns` e `collapseDigitTemplates` | +2 (modificadores) |
| `src/platform/config/config.ts` | 705+ (`GLOBAL_CONFIG_KEYS`) | Adicionar 3 entries: `'bashOutputFilterEnabled'`, `'bashOutputFilterRewriteEnabled'`, `'bashOutputFilterUserEnabled'` | +3 |
| `src/services/tools/toolResultSummarizer.test.ts` | (existing) | 1 test confirmando que `<bash-output-rewritten>` e `<bash-output-filtered>` agora retornam true em `isAlreadyCompacted` | +~10 |
| `src/platform/config/config.test.ts` (se existir) ou novo | n/a | Confirmar que os 3 keys aceitam boolean | +~5 |

## Steps

1. **Editar `toolResultSummarizer.ts:242`:**
   ```ts
   function isAlreadyCompacted(text: string): boolean {
     return (
       text.startsWith('<persisted-output>') ||
       text.startsWith(TOOL_RESULT_SUMMARY_TAG) ||
       text.startsWith('<bash-output-rewritten') ||  // NEW
       text.startsWith('<bash-output-filtered')      // NEW
     )
   }
   ```

2. **Editar `toolResultSummarizer.ts:475` e `:500`:** adicionar `export` antes de `function collapseIdenticalRuns(...)` e `function collapseDigitTemplates(...)`.

   Alternativa: criar `src/utils/textCompaction.ts` e mover ambos pra lá. Re-exportar de `toolResultSummarizer.ts` via `export { collapseIdenticalRuns, collapseDigitTemplates } from './textCompaction.js'` para backwards-compat. Decidir durante implementação — exportar in-place é mais simples.

3. **Editar `config.ts:705`:** adicionar ao array `GLOBAL_CONFIG_KEYS`:
   ```ts
   'bashOutputFilterEnabled',
   'bashOutputFilterRewriteEnabled',
   'bashOutputFilterUserEnabled',
   ```

4. **Adicionar test em `toolResultSummarizer.test.ts`:**
   ```ts
   test('isAlreadyCompacted recognizes bash-output-* markers', () => {
     // Use the integration helper that exposes isAlreadyCompacted indirectly,
     // OR export isAlreadyCompacted as testable. Decide during impl.
     const result = maybeSummarizeToolResult({
       type: 'tool_result',
       tool_use_id: 'x',
       content: '<bash-output-rewritten filter="..." original="..." actual="...">\n' + 'x'.repeat(20_000)
     }, BASH_TOOL_NAME)
     expect(result.content).toBe(/* unchanged — should not re-summarize */)
   })
   ```

## Tests

```bash
bun test src/services/tools/toolResultSummarizer.test.ts
bun test src/platform/config/config.test.ts   # se existir
bun run typecheck
```

## Acceptance criteria

- [ ] `isAlreadyCompacted` reconhece os 4 marker tags (existing 2 + 2 novos)
- [ ] Output >8 KB começando com `<bash-output-filtered` ou `<bash-output-rewritten` NÃO é re-summarizado
- [ ] `collapseIdenticalRuns` e `collapseDigitTemplates` são importáveis externamente
- [ ] `getGlobalConfig().bashOutputFilterEnabled` retorna `boolean | undefined` (default undefined → tratado como `false`)
- [ ] `bun run build` clean
- [ ] `bun run typecheck` zero errors
- [ ] Existing `toolResultSummarizer.test.ts` ainda passa 100%

## PR description template

```markdown
## chore(bash-filter): plumbing for bash-output-filter v1 (Phase 0)

Pure preparation step. No behavior change.

### Changes
- `toolResultSummarizer.ts:isAlreadyCompacted` now recognizes `<bash-output-rewritten` and `<bash-output-filtered` markers — prevents the threshold-based summarizer from re-wrapping output already compacted by the upcoming bash-output-filter module
- Export `collapseIdenticalRuns` and `collapseDigitTemplates` from `toolResultSummarizer.ts` so the new pipeline can reuse them (DRY: ~80 LoC saved vs. porting)
- Register `bashOutputFilterEnabled`, `bashOutputFilterRewriteEnabled`, `bashOutputFilterUserEnabled` in `GLOBAL_CONFIG_KEYS` so `/config` recognizes them once Phase 3+ wires them

### Why now
Unlocks Phase 1+ implementation. Without these, the filter module would either fight the summarizer or have no way to read its config flags.

### Tests
- New: `isAlreadyCompacted` recognizes bash-output-* tags; output with new markers is not re-summarized
- Pass: existing summarizer test suite

### Refs
- Spec: docs/tech/bash-output-filter/architecture.md §10 (Summarizer interaction), §12 (Configuration), §17 (Phase 0)
- Phase doc: docs/tech/bash-output-filter/phases/phase-0-plumbing.md
```

## Implementation notes

_(Preencher durante/após execução. Capturar: deviations from spec, learnings, runtime decisions, alternative approaches considered.)_
