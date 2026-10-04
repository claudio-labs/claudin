/**
 * What the permission routes can do in this build. Each build flag is read
 * here and nowhere else in the unit, so a flag-off build loses a route
 * whole instead of branch by branch.
 */
import { feature } from 'bun:bundle'

export type RouteCapabilities = {
  /** The Bash prompt-rule classifier (`BASH_CLASSIFIER`). */
  readonly bashClassifier: boolean
  /** The auto-mode transcript classifier (`TRANSCRIPT_CLASSIFIER`). */
  readonly autoMode: boolean
  /** The web app answering prompts over the bridge (`BRIDGE_MODE`). */
  readonly bridge: boolean
}

export function routeCapabilities(): RouteCapabilities {
  return {
    bashClassifier: feature('BASH_CLASSIFIER') ? true : false,
    autoMode: feature('TRANSCRIPT_CLASSIFIER') ? true : false,
    bridge: feature('BRIDGE_MODE') ? true : false,
  }
}
