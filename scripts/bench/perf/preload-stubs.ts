/**
 * Preload for profile scripts that import from `src/`.
 *
 * `src/platform/analytics/growthbook.ts` imports `@growthbook/growthbook`,
 * which is NOT a dependency of this repo — `scripts/build/build.ts` replaces the
 * whole analytics surface with no-op stubs at bundle time (see
 * `scripts/build/no-telemetry-plugin.ts`). Running a script directly under `bun`
 * skips that build step, so anything that transitively reaches `utils/log.js`
 * dies on a missing module before it prints a line.
 *
 * This registers the same shape the build would have produced, so a harness can
 * import real product code without pulling a package that does not exist:
 *
 *   bun --preload ./scripts/bench/perf/preload-stubs.ts scripts/bench/<group>/<name>.ts
 */
import { mock } from 'bun:test'

mock.module('@growthbook/growthbook', () => ({
  GrowthBook: class {
    async init(): Promise<void> {}
    setAttributes(): void {}
    getFeatureValue<T>(_key: string, fallback: T): T {
      return fallback
    }
    isOn(): boolean {
      return false
    }
    destroy(): void {}
  },
}))
