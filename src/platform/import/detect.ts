/**
 * Which other AI coding agents are configured on this machine.
 *
 * Detection is deliberately nothing but `existsSync` over each adapter's
 * declared probe paths: it runs before the user has asked for anything, so it
 * must not parse a config, and an agent that is installed but empty is better
 * reported with zero artifacts than missed.
 */
import { existsSync } from 'fs'

import { ADAPTERS } from 'src/platform/import/registry.js'
import type {
  CollectContext,
  DetectedAgent,
} from 'src/platform/import/types.js'

export function detectForeignAgents(ctx: CollectContext): DetectedAgent[] {
  const detected: DetectedAgent[] = []
  for (const adapter of ADAPTERS) {
    const roots = adapter.probePaths(ctx).filter(probe =>
      existsSync(probe.path),
    )
    if (roots.length === 0) continue
    detected.push({ id: adapter.id, label: adapter.label, roots })
  }
  return detected
}
