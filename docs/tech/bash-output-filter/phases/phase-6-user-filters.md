# Phase 6 — User filters via JSON

> **Status:** ⏸ Not started
> **LoC estimado:** ~290
> **PR:** _(preencher)_
> **Parent spec:** [`../architecture.md` §8](../architecture.md)

Abre superfície de extensão: usuário cria `~/.claudin/filters.json` com filtros customizados. Schema validado por zod, hardening contra ReDoS, sem `rewriteCommand` permitido (segurança).

## Pré-requisitos

- [ ] Phase 1 done (zod stub em `userFilters.ts` existente)
- [ ] Phase 0 done (`bashOutputFilterUserEnabled` registrado em `GLOBAL_CONFIG_KEYS`)

## O que muda no codebase

### Arquivos modificados

| Arquivo | Mudança | LoC |
|---|---|---|
| `src/tools/shared/outputFilter/Bash/userFilters.ts` | Implementar `loadUserFilters`, `parseUserFilter`, ReDoS guards (length cap + denylist) | +150 |
| `src/tools/shared/outputFilter/Bash/registry.ts` | Confirmar que `userFilters()` é chamado depois dos `builtInFilters` (precedência) | +5 |
| `src/tools/shared/outputFilter/Bash/userFilters.test.ts` | Tests pra malformed JSON, denylisted regex, length cap, valid spec, regex compilation failure | +120 |
| `src/tools/shared/outputFilter/Bash/__fixtures__/user-filters/` (NEW) | Sample valid + 5 malformed JSON files pra testar load behavior | +5 files |

## Steps

1. **Implementar zod schema** (já documentado em [`../architecture.md` §8](../architecture.md#8-user-defined-filters-via-json--yes-with-hard-guards)):
   ```ts
   const REGEX_MAX_LEN = 500

   const UserReplaceRule = z.object({
     pattern: z.string().min(1).max(REGEX_MAX_LEN),
     flags: z.string().regex(/^[gimsu]*$/).optional(),
     replacement: z.string().max(REGEX_MAX_LEN),
   }).strict()

   const UserFilterSpec = z.object({
     name: z.string().regex(/^[a-z0-9-]+$/).min(1).max(60),
     matchCommand: z.string().min(1).max(REGEX_MAX_LEN),
     matchCommandReject: z.string().max(REGEX_MAX_LEN).optional(),
     stripAnsi: z.boolean().optional(),
     replace: z.array(UserReplaceRule).max(20).optional(),
     collapseRuns: z.boolean().optional(),
     collapseDigitTemplates: z.boolean().optional(),
     dedupGlobal: z.boolean().optional(),
     stripLinesMatching: z.array(z.string().max(REGEX_MAX_LEN)).max(20).optional(),
     keepLinesMatching: z.array(z.string().max(REGEX_MAX_LEN)).max(20).optional(),
     truncateLineAt: z.number().int().positive().max(2000).optional(),
     headLines: z.number().int().positive().max(500).optional(),
     tailLines: z.number().int().positive().max(500).optional(),
     maxLines: z.number().int().positive().max(1000).optional(),
     onEmpty: z.string().max(200).optional(),
   }).strict()
   ```

   **Não inclui `rewriteCommand`.** Arbitrary code in JSON = security risk.

2. **Implementar `loadUserFilters`:**
   ```ts
   export function loadUserFilters(): FilterSpec[] {
     if (getGlobalConfig().bashOutputFilterUserEnabled === false) return []

     const path = join(getClaudinConfigHomeDir(), 'filters.json')
     if (!existsSync(path)) return []

     try {
       const raw = readFileSync(path, 'utf8')
       const parsed = JSON.parse(raw)
       const validated = UserFiltersFile.parse(parsed)

       const compiled: FilterSpec[] = []
       for (const userSpec of validated.filters) {
         const filter = compileUserFilter(userSpec)
         if (filter) compiled.push(filter)
         // else: already logged inside compileUserFilter
       }
       return compiled
     } catch (e) {
       logError(e)
       return []
     }
   }

   function compileUserFilter(spec: z.infer<typeof UserFilterSpec>): FilterSpec | null {
     try {
       // ReDoS denylist check
       if (isReDoSPattern(spec.matchCommand)) {
         logForDebugging(`Rejecting user filter "${spec.name}": matchCommand has ReDoS-prone pattern`, { level: 'warn' })
         return null
       }
       // ...same check for matchCommandReject and every other regex...

       const matchCommand = new RegExp(spec.matchCommand)
       const matchCommandReject = spec.matchCommandReject ? new RegExp(spec.matchCommandReject) : undefined
       const replace = spec.replace?.map(r => ({
         pattern: new RegExp(r.pattern, r.flags),
         replacement: r.replacement,
       }))
       const stripLinesMatching = spec.stripLinesMatching?.map(p => new RegExp(p))
       const keepLinesMatching = spec.keepLinesMatching?.map(p => new RegExp(p))

       return {
         name: spec.name,
         matchCommand,
         matchCommandReject,
         stripAnsi: spec.stripAnsi,
         replace,
         collapseRuns: spec.collapseRuns,
         collapseDigitTemplates: spec.collapseDigitTemplates,
         dedupGlobal: spec.dedupGlobal,
         stripLinesMatching,
         keepLinesMatching,
         truncateLineAt: spec.truncateLineAt,
         headLines: spec.headLines,
         tailLines: spec.tailLines,
         maxLines: spec.maxLines,
         onEmpty: spec.onEmpty,
       }
     } catch (e) {
       logError(e)
       return null
     }
   }
   ```

3. **Implementar `isReDoSPattern`** (vendored safe-regex heuristics, ~80 LoC):
   - Reject `(.+)+`, `(.*)*`, `(a+)+b` shapes (nested quantifiers)
   - Reject patterns with star + plus combination over same character class
   - Reject patterns with backreferences in repeated groups
   - Other heuristics from [`safe-regex`](https://github.com/davisjam/safe-regex) project (vendored, not added as dep)

4. **Cache `userFilters()`:**
   ```ts
   let cached: FilterSpec[] | null = null

   export function userFilters(): FilterSpec[] {
     if (cached === null) {
       cached = loadUserFilters()
     }
     return cached
   }

   export function invalidateUserFiltersCache(): void {
     cached = null
   }
   ```

   `invalidateUserFiltersCache` é chamado quando `getGlobalConfig` invalidate (via existing `globalConfigCache.invalidate`). Necessário pra que `bashOutputFilterUserEnabled` flip dispare reload.

5. **Tests em `userFilters.test.ts`:**
   - Valid filter loads + applies
   - Malformed JSON: graceful empty load + error logged
   - Bad regex (no compile): individual filter dropped, others kept
   - ReDoS denylisted pattern: filter dropped + warning
   - Length cap: 501-char regex → schema rejects
   - Schema strict: extra field → entire entry rejected
   - User filter with `rewriteCommand` field → schema rejects (strict mode catches)
   - `bashOutputFilterUserEnabled: false` → returns empty array

6. **Smoke manual:**
   ```bash
   # Create test config
   mkdir -p ~/.claudin
   cat > ~/.claudin/filters.json <<'EOF'
   {
     "filters": [
       {
         "name": "my-make",
         "matchCommand": "^make\\s+release\\b",
         "stripAnsi": true,
         "stripLinesMatching": ["^Building \\["],
         "matchOutput": [{
           "pattern": "Build OK",
           "message": "✓ release built",
           "unless": "(?i)\\berror\\b"
         }]
       }
     ]
   }
   EOF

   # Run claudin with filter enabled
   bun run dev
   # Run: make release
   # Expect: <bash-output-filtered name="my-make"> marker if filter activates
   ```

## Tests

```bash
bun test src/tools/shared/outputFilter/Bash/userFilters.test.ts
bun test src/tools/shared/outputFilter/Bash
bun run typecheck
bun run verify:privacy
```

## Acceptance criteria

- [ ] User filter at `~/.claudin/filters.json` loads, validates, compiles
- [ ] Built-in filters take precedence over user filters with same name
- [ ] Malformed JSON → empty load + error log; built-ins still work
- [ ] Bad regex in user filter → individual entry dropped; others load
- [ ] ReDoS-prone pattern → entry dropped + warning logged
- [ ] Length cap 500 chars enforced (zod schema)
- [ ] zod `.strict()` rejects unknown fields (e.g. `rewriteCommand` not allowed in JSON)
- [ ] `bashOutputFilterUserEnabled: false` disables user filters but built-ins still work
- [ ] Cache invalidates when config changes

## PR description template

```markdown
## feat(bash-filter): user-defined filters via JSON (Phase 6)

Adds `~/.claudin/filters.json` as the user-defined filter surface. Schema validated with zod, hardened against ReDoS via length cap + denylist.

### Format
```json
{
  "filters": [
    {
      "name": "my-custom-build",
      "matchCommand": "^make\\s+release\\b",
      "stripAnsi": true,
      "stripLinesMatching": ["^Building \\["],
      "matchOutput": [{
        "pattern": "Build OK",
        "message": "✓ release built",
        "unless": "(?i)\\berror\\b"
      }]
    }
  ]
}
```

### Hardening
- Regex max 500 chars
- Vendored `safe-regex`-style denylist for ReDoS-prone patterns
- zod `.strict()` rejects unknown fields
- **No `rewriteCommand`** allowed in JSON (security: arbitrary code shape)
- Per-entry validation: one bad filter does not break the file

### Precedence
- Built-ins win over user filters with same `name`
- User filter for verb without built-in match: user filter activates

### Tests
- Schema validation positive + 5 negative cases
- ReDoS denylist
- Cache invalidation on config flip

### Refs
- Spec: docs/tech/bash-output-filter/architecture.md §8
- Phase doc: docs/tech/bash-output-filter/phases/phase-6-user-filters.md
```

## Implementation notes

_(Preencher durante/após execução.)_
