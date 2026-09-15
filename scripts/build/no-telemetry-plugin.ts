/**
 * No-Telemetry Build Plugin for Claudin
 *
 * Replaces all analytics, telemetry, and phone-home modules with no-op stubs
 * at compile time. Zero runtime cost, zero network calls to Anthropic.
 *
 * This file is NOT tracked upstream — merge conflicts are impossible.
 * Only build.ts needs a one-line import + one-line array entry.
 *
 * Kills:
 *   - GrowthBook remote feature flags (api.anthropic.com)
 *   - Internal employee logging
 *   - Prompt dumping / undercover mode
 *
 * The analytics and telemetry modules this plugin used to stub (the sink,
 * Datadog, 1P event logging, the BigQuery exporter, Perfetto/OTel session
 * tracing) were deleted from the tree outright, so they need no stub.
 */

import type { BunPlugin } from 'bun'

// Repo-relative module path, without extension → stub source.
//
// The `src/` prefix is load-bearing even though the regex below only needs a
// path SUFFIX: it is what `scripts/migrations/reorg/apply.ts` matches when a move rewrites
// module paths across the tree, so these keys follow the files instead of
// silently ceasing to match. A key that stops matching does not fail loudly —
// the real module gets bundled, and the build either dies on an un-installed
// package or, worse, ships a live phone-home path.
//
// Feature-flag resolution used to be the biggest entry here: a ~200-line stub
// that replaced `src/platform/analytics/growthbook.ts` wholesale. That stub is
// now the source itself, so the flags a user sets are resolved by the file
// under test rather than by a string in this one.
const stubs: Record<string, string> = {

	// ─── Internal employee logging (not needed in the external build) ─────
	//
	// Permanently inert: the module was deleted, and `src/services/` is one of
	// the buckets the 2026-08 reorg retired, so this key can never resolve
	// again. `no-telemetry-stubs-resolve.test.ts` reports it as dead rather
	// than disarmed. Same for `src/utils/undercover` below.

	'src/services/internalLogging': `
export async function logPermissionContextForAnts() {}
export const getContainerId = async () => null;
`,

	// ─── Deleted Anthropic-internal modules ───────────────────────────────

	// These keys are PATH-PINNED: `onLoad` matches the resolved file path, so
	// moving a stubbed module silently disarms its stub. Nothing errors, and the
	// count logged below still includes it — it counts registered stubs, not
	// applied ones. The reorg moved this one out of `src/services/api/` and the
	// stub sat dead until `stubs-resolve.test.ts` was written to catch it.
	'src/providers/transport/dumpPrompts': `
export function createDumpPromptsFetch() { return undefined; }
export function getDumpPromptsPath() { return ''; }
export function getLastApiRequests() { return []; }
export function clearApiRequestCache() {}
export function clearDumpState() {}
export function clearAllDumpState() {}
export function addApiRequestToCache() {}
`,

	'src/utils/undercover': `
export function isUndercover() { return false; }
export function getUndercoverInstructions() { return ''; }
export function shouldShowUndercoverAutoNotice() { return false; }
`,
}

function escapeForResolvedPathRegex(modulePath: string): string {
	return modulePath
		.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
		.replace(/\//g, '[/\\\\]')
}

export const noTelemetryPlugin: BunPlugin = {
	name: 'no-telemetry',
	setup(build) {
		for (const [modulePath, contents] of Object.entries(stubs)) {
			// Build regex that matches the resolved file path on any OS
			// e.g. "services/analytics/growthbook" → /services[/\\]analytics[/\\]growthbook\.(ts|js)$/
			const escaped = escapeForResolvedPathRegex(modulePath)
			const filter = new RegExp(`${escaped}\\.(ts|js)$`)

			build.onLoad({ filter }, () => ({
				contents,
				loader: 'js',
			}))
		}

		console.log(`  🔇 no-telemetry: stubbed ${Object.keys(stubs).length} modules`)
	},
}
