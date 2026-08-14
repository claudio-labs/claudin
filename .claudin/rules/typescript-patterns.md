---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
---
# TypeScript Patterns — Claudin Development Rules

Claudin-specific TypeScript idioms and constraints. Applied to all code in this repository.

## Non-Negotiable Rules

These override general TypeScript conventions:

1. **No `any`** — Use explicit types or `unknown` + type guards. `any` disables the type system.
2. **No silent error swallowing** — Always log via `logError()` or re-throw. Never `catch (e) {}`.
3. **Regex at module level** — Never compile regex inside a function. Define as module-level `const`.
4. **Fallback pattern** — If a tool/filter fails, return the raw result unchanged. Never block the user.
5. **No hardcoded model names** — Always use `getPrimaryModel()` / `getSmallFastModel()` from `src/utils/model/`.
6. **No hardcoded provider logic** — Always use `tryGetActiveProvider()` from `src/services/api/activeProvider.ts`.
7. **Privacy enforcement** — Any analytics event name containing code/paths must use the `_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` suffix. Run `bun run verify:privacy` before every PR.
8. **Feature flags over conditionals** — New Anthropic-internal features go behind `feature('FLAG')` in `scripts/build.ts`. Never use runtime env vars for build-time feature gating.

## Error Handling

### Always subclass, always log context

```typescript
// ✅ Correct — typed, loggable, descriptive
import { logError } from 'src/utils/log.js'

async function readConfig(path: string): Promise<Config> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw) as Config
  } catch (e) {
    logError(`Failed to read config at ${path}`, e)
    throw e
  }
}

// ❌ Wrong — silent swallow, user gets nothing
async function readConfig(path: string): Promise<Config> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw) as Config
  } catch {
    return {} as Config
  }
}
```

### Custom error classes (use existing ones)

```typescript
// Existing classes in src/utils/errors.ts — prefer these over new Error()
import { ClaudeError, AbortError, isAbortError, isENOENT } from 'src/utils/errors.js'

// ✅ Check abort before logging — abort is not an error
try {
  await doWork()
} catch (e) {
  if (isAbortError(e)) return   // user cancelled, silent exit
  logError('doWork failed', e)
  throw e
}

// ✅ Check ENOENT before re-throwing
try {
  await fs.readFile(path)
} catch (e) {
  if (isENOENT(e)) return null  // expected, not an error
  throw e
}
```

### Fallback pattern (mandatory for tools that wrap external commands)

```typescript
// ✅ Correct — fails open, never blocks the user
async function filterOutput(raw: string): Promise<string> {
  try {
    return applyFilters(raw)
  } catch (e) {
    logError('filter failed, returning raw output', e)
    return raw  // passthrough on failure
  }
}
```

## Schema Validation — Always Zod

```typescript
import { z } from 'zod/v4'

// ✅ Correct — typed at boundary, validated at entry
const InputSchema = z.object({
  command: z.string().min(1),
  timeout: z.number().optional().default(30_000),
})

type Input = z.infer<typeof InputSchema>

// ❌ Wrong — no validation, any leaks through
function execute(input: any) { ... }
```

## Tool Structure — Always `buildTool`

Every tool in `src/tools/<Name>/` follows this pattern:

```typescript
import { buildTool, type ToolDef } from 'src/Tool.js'
import { z } from 'zod/v4'

// 1. Input schema (zod)
const inputSchema = z.object({ ... })

// 2. Tool definition
const def: ToolDef<typeof inputSchema> = {
  name: 'ToolName',
  description: '...',
  inputSchema,
  async execute(input, ctx) {
    // 3. Validate permissions via ctx
    // 4. Execute with fallback
    // 5. Return typed result
  },
}

export const MyTool = buildTool(def)
```

### `outputSchema` gates what the RESULT RENDERER sees

`UserToolSuccessMessage.tsx` runs `tool.outputSchema?.safeParse(toolUseResult)`
and passes the **parsed** value to `renderToolResultMessage` — a guard against
crashing on an old-format result from a resumed transcript. A `z.object` strips
every key it does not declare, so a field the renderer reads but the schema
omits arrives as `undefined`, silently and only in the TUI: the model-facing
string (`mapToolResultToToolResultBlockParam`) gets the raw result and looks
correct, and no test that calls the formatter can see it.

`BuildTool` shipped this way — `durationMs` and `stall` were absent from the
schema, so every build rendered a bare `✓ built` with no time, and a build
stopped by the idle watchdog could not reach its "stopped after …" arm at all.
**Rule:** when adding a field to a tool's UI, add it to `outputSchema` too, and
pin it with a `outputSchema.parse(fullResult)` test — a formatter test will not
catch it.

## Regex — Always Module-Level

```typescript
// ✅ Correct — compiled once when module loads
const ERROR_LINE_RE = /^error:/i
const HASH_RE = /^[0-9a-f]{7,40}/

function isErrorLine(line: string): boolean {
  return ERROR_LINE_RE.test(line)
}

// ❌ Wrong — recompiles on every call
function isErrorLine(line: string): boolean {
  return /^error:/i.test(line)  // new RegExp on every invocation
}
```

## Provider — Never Hardcode

```typescript
import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import { getPrimaryModel, getSmallFastModel } from 'src/services/api/providerModels.js'

// ✅ Correct — respects user's active provider
const provider = tryGetActiveProvider()
const model = getPrimaryModel(provider)

// ❌ Wrong — breaks for non-Anthropic providers
const model = 'claude-opus-4-7-20251101'
```

## Imports — Use Path Aliases

```typescript
// ✅ Correct — tsconfig alias, works everywhere
import { logError } from 'src/utils/log.js'
import { buildTool } from 'src/Tool.js'

// ❌ Wrong — breaks when file moves, hard to read
import { logError } from '../../../utils/log.js'
```

## Privacy — No Phone-Home

```typescript
// ✅ Correct — suffix proves manual review
import { logEvent } from 'src/services/analytics/index.js'
logEvent('tool_executed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, {})

// ❌ Wrong — could leak user code/paths
logEvent('tool_executed', { command: userCommand })
```

Run `bun run verify:privacy` to catch violations before push.

## Build System

Full mechanics and rules live in **[build-system.md](build-system.md)** (auto-loads
when you edit `scripts/build.ts`). The two that bite while editing `src/`:

1. **Always `bun run build` after a change** — the launcher runs `dist/cli.mjs`, not source.
2. **Never commit a literal `true`/`false` where `feature('X')` should be** — the
   build folds it in place and a killed build can leave it dirty (`git diff` after).
3. **`feature('X')` must sit DIRECTLY in an `if` or ternary condition.** `&&`/`||`/
   assignment/`return feature('X')` forms throw *"can only be used directly in an if
   statement or ternary condition"* under `bun test` — and the build folds every
   form to a literal, so **only tests catch it**, never the build. Write
   `if (!feature('X')) return` / `const x = feature('X') ? a : b`. After gating a
   module any test imports (transitively), run that test file to confirm it loads.
4. **In `--compile`-reachable code, enumerate `require('pkg/x')` as static string
   literals.** A template/dynamic `require(`pkg/${name}`)` is not embedded in the
   compiled binary's VFS → `Cannot find module` at runtime in a dir without
   `node_modules`. The Node bundle (`dist/cli.mjs`) masks it via on-disk fallback;
   the standalone binary does not.
5. **Never name a local `jsx`/`jsxs`/`Fragment` in a `.tsx`.** The minifier renames
   locals to `$`-prefixed names, and a local `jsx` collides with the automatic
   JSX-runtime factory (`$jsx`). The first JSX in that scope then calls the shadowed
   local → `TypeError: $jsx is not a function` **at runtime only** — `bun run build`
   AND `typecheck` both pass, so it ships silently and fires when the code path runs
   (PR #18: a `jsx` local in `processBashCommand.tsx` crashed the entire `!command`
   render — it flashed then vanished). Name it anything else (`backgroundJsx`).

## Anti-Patterns (Claudin-Specific)

| Pattern | Problem | Fix |
|---------|---------|-----|
| `any` type | Disables safety checks | Use explicit type or `unknown` |
| `catch (e) {}` | Silent failure, user gets nothing | `logError()` + re-throw or fallback |
| `/regex/` inside function | Recompiles every call | Module-level `const RE = /pattern/` |
| Hardcoded model string | Breaks non-Anthropic providers | `getPrimaryModel(provider)` |
| `../../` relative imports | Breaks on file moves | `src/...` path aliases |
| `console.log` in production | Pollutes TUI output | `logError()` / `logForDebugging()` |
| Raw `new Error(msg)` | No typed catch | Subclass from `src/utils/errors.ts` |
| `process.exit(0)` without cleanup | Skips graceful shutdown | Use abort signals |
| local var named `jsx`/`jsxs` | minifier → `$jsx`, shadows JSX runtime factory → `$jsx is not a function` at runtime (build + typecheck pass) | rename (e.g. `backgroundJsx`) |
