---
name: OpenTelemetry is devDep-only and fully build-stubbed — don't remove for "security"
description: Why the @opentelemetry/* packages stay in the tree even though Claudin uses zero OTel at runtime; verdict on removing them
type: project
---

OpenTelemetry is NOT used at runtime in Claudin. Do not spend effort removing the `@opentelemetry/*` deps to "improve security" — it yields ~zero benefit.

- The 8 `@opentelemetry/*` packages are in **devDependencies**, not `dependencies` → npm consumers of `@claudiolabs/claudin` never install them; zero runtime/bundle footprint for end users.
- `noTelemetryPlugin` stubs every OTel-importing module (instrumentation, sessionTracing, perfettoTracing, firstPartyEventLogger, firstPartyEventLoggingExporter, bigqueryExporter, analytics/*) → the built `dist/cli.mjs` + chunks contain ZERO live `@opentelemetry` imports (verified by grep).
- `scripts/build.ts` marks `@opentelemetry/*` as `external` AND also provides noop OTel exports (`trace`/`context`/`SpanStatusCode`/etc.) in its inline stub module.
- The deps remain only so `bun run typecheck` (tsc) can resolve the surviving `import type {...} from '@opentelemetry/*'` references in ~10 source files (state.ts, telemetryAttributes.ts, init.ts, events.ts, logger.ts, betaSessionTracing.ts, etc.).

**Verdict (2026-07-08): keep them.** Removing requires replacing those `import type` refs across ~10 files with local minimal types, for near-zero security gain (devDeps don't ship). Only worth doing for a leaner dev tree / fewer Dependabot bumps.

**Why:** recurring "can we remove OTel to improve security" question; the runtime path is already neutralized by the build stubs + `verify:privacy`.

**How to apply:** If asked again, cite that OTel is devDep-only + fully build-stubbed. If the user still wants removal, do the `import type` cleanup first, then `bun run typecheck` + `build` + `verify:privacy` to confirm nothing breaks.
