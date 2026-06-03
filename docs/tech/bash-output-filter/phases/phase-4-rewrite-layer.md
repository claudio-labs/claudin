# Phase 4 — Rewrite layer + 5 rewrite filters

> **Status:** ⏸ Not started
> **LoC estimado:** ~150
> **PR:** _(preencher)_
> **Parent spec:** [`../architecture.md` §6, §17](../architecture.md)

Adiciona o rewrite layer — comandos podem ser **substituídos** antes da execução pra forçar formato compacto nativo. Maior win unitário do projeto: `git log` salta de 42% (P only) pra **92%** (R) em ROI medido.

## Pré-requisitos

- [ ] Phase 3 done (BashTool integration funcionando com pipeline only)
- [ ] Phase 0 done (config key `bashOutputFilterRewriteEnabled` registrada)

## Filters de rewrite incluídos (5)

| Filter | Comando reescrito | ROI |
|---|---|---|
| `git log` | `git log --oneline` (preserva user `-N`/`--grep`/etc) | **92% medido** |
| `git status` | `git status --porcelain --branch` | ~75% est. |
| `gh pr list` | `gh pr list --json number,title,author,state,baseRefName` | ~70% est. |
| `gh issue list` | `gh issue list --json number,title,state,labels` | ~70% est. |
| `gh run list` | `gh run list --json status,conclusion,name,branch,event,databaseId` | ~75% est. |

**Movidos pra v2 (precisam JSON parser):**
- `ruff check --output-format=json` + reformat
- `cargo build --message-format=json` + reformat
- `kubectl get -o json` + reformat

## O que muda no codebase

### Arquivos modificados

| Arquivo | Mudança | LoC |
|---|---|---|
| `src/outputFilter/Bash/index.ts` | Trocar `planFilter` stub por implementação real (chama `rewriteCommand` se filter tem; valida resultado) | +30 |
| `src/outputFilter/Bash/registry.ts` | Adicionar `hasCompound(command)` — detecta `\|`, `&&`, `;`, `\|\|`. Skip rewrite se compound. | +15 |
| `src/outputFilter/Bash/markers.ts` | Estender `wrapStdoutWithMarkers` pra prepend `<bash-output-rewritten>` quando `plan.rewrite != null` | +20 |
| `src/outputFilter/Bash/filters/git.ts` | Adicionar `rewriteCommand` em `gitLog` e `gitStatus` (specs já existentes em Phase 5 ou movem pra cá) | +40 |
| `src/outputFilter/Bash/filters/gh.ts` (NEW) | 3 specs: `ghPrList`, `ghIssueList`, `ghRunList` — todos com `rewriteCommand` | +60 |
| `src/outputFilter/Bash/filters/index.ts` | Re-exportar gh family | +3 |
| `src/tools/BashTool/BashTool.tsx` | Trocar plan stub por `const filterPlan = planFilter(input.command); const effectiveCommand = filterPlan.effectiveCommand` antes do `runShellCommand`. Permission check continua sobre `input.command` (original). | +5 |
| `src/outputFilter/Bash/bashFilter.test.ts` | Adicionar 5 rewrite tests + 1 compound bypass test | +60 |
| `src/outputFilter/Bash/__fixtures__/samples/` | Capturar samples reais dos 3 gh commands | +3 files |

## Steps

1. **Implementar `hasCompound` em `registry.ts`:**
   ```ts
   export function hasCompound(command: string): boolean {
     // Strip strings/quotes first to avoid false positives in literals
     // Simple version (good enough for v1):
     return /[|&;]|&&|\|\|/.test(command)
   }
   ```

2. **Real `planFilter` em `index.ts`:**
   ```ts
   export function planFilter(command: string): PreExecPlan {
     const filter = findFilterForCommand(command)
     if (!filter) return { effectiveCommand: command, filter: null, rewrite: null }

     // No rewrite if compound
     if (hasCompound(command)) return { effectiveCommand: command, filter, rewrite: null }

     // No rewrite if filter doesn't have rewriteCommand
     if (!filter.rewriteCommand) return { effectiveCommand: command, filter, rewrite: null }

     // No rewrite if env var disables it
     if (isEnvTruthy(process.env.CLAUDIN_DISABLE_REWRITE)) return { effectiveCommand: command, filter, rewrite: null }
     if (getGlobalConfig().bashOutputFilterRewriteEnabled === false) return { effectiveCommand: command, filter, rewrite: null }

     try {
       const ctx = parseBashCommand(command)  // verb + args extraction
       const newCommand = filter.rewriteCommand(ctx)
       if (!newCommand || newCommand === command) return { effectiveCommand: command, filter, rewrite: null }

       // Validate post-rewrite: must be non-empty, must start with same verb
       const newVerb = newCommand.trim().split(/\s+/)[0]
       if (newVerb !== ctx.verb) {
         logForDebugging(`bash-filter: rewriteCommand changed verb (${ctx.verb} → ${newVerb}); rejecting rewrite`, { level: 'warn' })
         return { effectiveCommand: command, filter, rewrite: null }
       }

       return { effectiveCommand: newCommand, filter, rewrite: { from: command, to: newCommand } }
     } catch (e) {
       logError(e)
       return { effectiveCommand: command, filter, rewrite: null }
     }
   }
   ```

3. **Update BashTool integration em `BashTool.tsx`:**
   ```ts
   // Before runShellCommand:
   const filterPlan = planFilter(input.command)
   const effectiveCommand = filterPlan.effectiveCommand

   // ... permission check uses input.command (original) — unchanged ...

   const commandGenerator = runShellCommand({
     input: { ...input, command: effectiveCommand },  // ← USE REWRITTEN
     // ...rest
   })

   // After result capture:
   result.stdout = applyFilterToStdout(result.stdout, result.isError ?? false, filterPlan)
   ```

4. **Specs com rewrite:**

   **`filters/git.ts:gitLog`:**
   ```ts
   const LOG_MATCH = /^git(\s+-[^\s]+)*\s+log\b/
   const LOG_REJECT = /--oneline|--format=|--pretty=|-p\b|--patch|\s-[1-9]\b/

   export const gitLog: FilterSpec = {
     name: 'git-log',
     matchCommand: LOG_MATCH,
     matchCommandReject: LOG_REJECT,
     rewriteCommand: ({ args }) => {
       // args includes 'log' — preserve user flags except the rejected ones
       const rest = args.filter(a => a !== 'log').join(' ')
       return `git log --oneline ${rest}`.replace(/\s+/g, ' ').trim()
     },
   }
   ```

   **`filters/git.ts:gitStatus`:**
   ```ts
   const STATUS_MATCH = /^git(\s+-[^\s]+)*\s+status\b/
   const STATUS_REJECT = /--porcelain|--short|-s\b|--json|-z\b/

   export const gitStatus: FilterSpec = {
     name: 'git-status',
     matchCommand: STATUS_MATCH,
     matchCommandReject: STATUS_REJECT,
     rewriteCommand: ({ args }) => {
       const rest = args.filter(a => a !== 'status').join(' ')
       return `git status --porcelain --branch ${rest}`.replace(/\s+/g, ' ').trim()
     },
   }
   ```

   **`filters/gh.ts`** (3 specs com rewrite). Por exemplo:
   ```ts
   const PR_LIST_MATCH = /^gh\s+pr\s+list\b/
   const PR_LIST_REJECT = /--json\b/

   export const ghPrList: FilterSpec = {
     name: 'gh-pr-list',
     matchCommand: PR_LIST_MATCH,
     matchCommandReject: PR_LIST_REJECT,
     rewriteCommand: ({ args }) => {
       // Always inject --json with a fixed field set
       return `gh pr list --json number,title,author,state,baseRefName,headRefName ${args.slice(2).join(' ')}`.replace(/\s+/g, ' ').trim()
     },
   }
   ```

5. **Tests:**
   - 5 rewrite tests em `bashFilter.test.ts`: cada filter prova `effectiveCommand` matches expected
   - 1 compound bypass test: `git log -5 | wc -l` → no rewrite (no marker)
   - 1 determinism test: chamar `rewriteCommand` 2× com mesma input → mesma output

6. **Markers em `markers.ts`:**
   ```ts
   if (plan.rewrite) {
     out += `${REWRITE_TAG} filter="${escapeXmlAttr(plan.filter!.name)}" original="${escapeXmlAttr(truncate(plan.rewrite.from))}" actual="${escapeXmlAttr(truncate(plan.rewrite.to))}">\n`
   }
   if (pipelineResult && pipelineResult.reductionPct > 0) {
     out += `${FILTER_TAG} name="${escapeXmlAttr(plan.filter!.name)}" reduction="${pipelineResult.reductionPct}%">\n`
   }
   ```

## Tests

```bash
bun test src/outputFilter/Bash
bun test src/tools/BashTool/BashTool.test.ts
bun run typecheck

# Smoke (manual)
CLAUDIN_BASH_FILTER_DEBUG=1 bun run dev
# Run: git log -10
# Expect: <bash-output-rewritten filter="git-log" original="git log -10" actual="git log --oneline -10"> + oneline output

# Run: git log -5 | wc -l
# Expect: NO marker (compound bypass)

# Run: git log -1
# Expect: NO rewrite (matchCommandReject — \s-[1-9]\b)
```

## Acceptance criteria

- [ ] 5 rewrite filters implemented and validated against samples
- [ ] `git log -10` → `git log --oneline -10` produces 92%+ reduction
- [ ] `git log -5 | wc -l` (compound) — no rewrite, no marker
- [ ] `git log -1` (rejected by matchCommandReject) — no rewrite
- [ ] `CLAUDIN_DISABLE_REWRITE=1` disables rewrite but keeps pipeline
- [ ] Permission check still uses original command
- [ ] Determinism: each rewrite filter has determinism test (2x same input → same output)
- [ ] All 5 rewrite tests pass in harness
- [ ] **Marker survives ShellError throw path** — concrete test via `formatError`:
  ```ts
  // src/outputFilter/Bash/rewrite.test.ts (or add to bashFilter.test.ts)
  test('rewrite marker survives error-exit path via ShellError.stderr', () => {
    // Simulate what BashTool does: filter result.stdout, then throw ShellError
    const filteredStdout = applyFilterToStdout(
      'error: build failed at line 42\n',
      true,  // isError
      { effectiveCommand: 'cargo build --message-format=json', filter: cargoBuild, rewrite: { from: 'cargo build', to: 'cargo build --message-format=json' } }
    )
    expect(filteredStdout).toMatch(/^<bash-output-rewritten filter="cargo-build"/)

    // BashTool constructs: throw new ShellError('', annotatedStdout, code, false)
    // Where annotatedStdout = SandboxManager.annotate(cmd, filteredStdout) — markers preserved
    const err = new ShellError('', filteredStdout, 1, false)

    // toolExecution.ts:1636 → formatError(error) → getErrorParts joins parts
    const rendered = formatError(err)
    expect(rendered).toContain('<bash-output-rewritten filter="cargo-build"')
    expect(rendered).toContain('Exit code 1')
    expect(rendered).toContain('error: build failed at line 42')  // raw error preserved
  })
  ```
  Confirms the path: `result.stdout` → ShellError.stderr → formatError → model-visible string with marker intact.

## PR description template

```markdown
## feat(bash-filter): rewrite layer + 5 rewrite filters (Phase 4)

Adds command rewriting — `BashTool.call` substitutes `input.command` before `runShellCommand` when a filter has `rewriteCommand`. Biggest unit win in the project: `git log` jumps from 42% (P only) to **92%** (R+P).

### Filters added (with rewrite)
- `git log` → `git log --oneline` (92% measured)
- `git status` → `git status --porcelain --branch` (~75% est)
- `gh pr list`, `gh issue list`, `gh run list` → forced `--json` mode (~70-75% est)

### Safety guarantees
- **Permission check** runs on ORIGINAL command (user/agent intent preserved at the auth boundary)
- **Compound commands** (`|`, `&&`, `;`) bypass rewrite (preserves pipe semantics like `git log | wc -l`)
- **Post-rewrite validation**: rewritten command must be non-empty + start with same verb. Failure → no rewrite.
- **Env opt-out**: `CLAUDIN_DISABLE_REWRITE=1` disables rewrite while keeping pipeline
- **Marker shown**: `<bash-output-rewritten filter="..." original="..." actual="...">` so model sees the substitution

### Tests
- 5 rewrite end-to-end (filter applied, expected effectiveCommand)
- Determinism (2x same input → same output) per filter
- Compound bypass: `git log -5 | wc -l` → no rewrite
- matchCommandReject: `git log -1` (small N) → no rewrite

### Refs
- Spec: docs/tech/bash-output-filter/architecture.md §6, §17 Phase 4
- Phase doc: docs/tech/bash-output-filter/phases/phase-4-rewrite-layer.md
```

## Implementation notes

_(Preencher durante/após execução.)_
