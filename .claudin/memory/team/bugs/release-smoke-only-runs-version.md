---
name: release-smoke-only-runs-version
description: Release CI smoke-tested each compiled binary with --version/--help only, fast paths that exit 0 when module init crashes; #310's SDK 0.135 broke the binary unseen. FIXED 2026-10-19 by smoke:binary, a -p round trip against a mock
type: project
paths:
  - ".github/workflows/release-binaries.yml"
  - "scripts/build/build.ts"
  - "scripts/verify/smoke-binary.ts"
---

**Symptom:** a compiled binary that dies as soon as it loads its main code still passed CI. `--version` and `--help` are answered by the entry's fast path before the main chunk loads.

**Where it was:**
- `release-binaries.yml`, step "Smoke test (native)": ran `"$BIN" --version` and `--help` only. It is still skipped for `matrix.cross` legs, which cannot run on their host.
- `release-binaries.yml`, the arm64-musl job: same check.
- `bun run smoke` in `package.json`: does the same for the Node bundle, and still does. The Node bundle's round trip is covered by `src/agent/cache/wirePrefix.e2e.test.ts`.

The blind spot has bitten before: [[tool-importing-tools-registry-tdz]] (`--version` skips the tool registry), and [[aur-omarchy-packaging]] (missing vendor dirs degrade silently).

**Repro** (2026-10-19, #310 state):
1. Keep `@opentelemetry/api` in the `external` list of `scripts/build/build.ts`. SDK ≥0.134 imports it from `client.mjs`.
2. Build with `CLAUDIN_COMPILE=1 CLAUDIN_RELEASE_BUILD=1 bun run scripts/build/build.ts`.
3. `--version` exits 0.
4. `bun run smoke:binary dist/bin/linux-x64/claudin` exits 1 with `TypeError: undefined is not an object (evaluating 'getFsImplementation().existsSync')` in `enableConfigs`.

Running the binary in place, inside the checkout, crashes the same way, so `node_modules` does not mask it. `smoke:binary` runs a copy from a temp dir anyway, because that is where a user's binary runs.

**Fix (branch `fix/compile-binary-otel-bundle`):** `scripts/verify/smoke-binary.ts` starts a `Bun.serve` mock of `POST /v1/messages` that streams a random answer. It writes a config with an anthropic profile pointing at the mock, the shape `mockAnthropic.ts` gives the wire e2e. An env `ANTHROPIC_API_KEY` alone answers "Not logged in". It then runs `-p` and passes only if that answer comes back. Both native smoke steps call it after `--version` and `--help`.

**Evidence:** break-and-restore on the real binary on 2026-10-19. With the external entry put back, the step fails with the crash above. With it restored, it answers in 1 request. `scripts/verify/smoke-binary.test.ts` pins the pass/fail logic with fake binaries: a version-only fake, a crash at startup, a hang, and a guard that the copy runs outside the checkout.
