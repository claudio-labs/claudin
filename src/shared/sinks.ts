import { initializeErrorLogSink } from 'src/shared/errorLogSink.js'

/**
 * Attach the error log sink, draining any events queued before
 * attachment. The init is idempotent. Called from setup() for the default
 * command; other entrypoints (subcommands, daemon, bridge) call this directly
 * since they bypass setup().
 *
 * Leaf module — kept out of setup.ts to avoid the setup → commands → bridge
 * → setup import cycle.
 */
export function initSinks(): void {
  initializeErrorLogSink()
}
