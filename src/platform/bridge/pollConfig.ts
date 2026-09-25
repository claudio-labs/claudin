import {
  DEFAULT_POLL_CONFIG,
  type PollIntervalConfig,
} from 'src/platform/bridge/pollConfigDefaults.js'

/**
 * The bridge poll interval config. Shared by bridgeMain.ts (standalone) and
 * replBridge.ts (REPL); both run on the defaults.
 */
export function getPollIntervalConfig(): PollIntervalConfig {
  return DEFAULT_POLL_CONFIG
}
