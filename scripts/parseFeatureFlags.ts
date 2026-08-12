/**
 * Reads the `featureFlags` map out of `scripts/build.ts`.
 *
 * `build.ts` stays the single source of truth, and the three readers of that
 * map go through here: the two build-invariant guards
 * (feature-flags-source-guard, lazy-component-stub-guard) and
 * scripts/profile/dump-system-prompt.ts, which names the flags a source-side
 * render reads as false. Importing build.ts instead is not an option — its
 * module body reads package.json, reads the IDE extension manifest, and warns
 * about missing classifier prompts.
 *
 * Not a reader, deliberately: src/stubs/test-preload.ts. Its
 * `mock.module('bun:bundle', …)` is inert (Bun resolves that specifier
 * natively), so handing it the real map would change nothing.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const FLAGS_BLOCK_RE = /const featureFlags[^{]*\{([\s\S]*?)\n\}/
const FLAG_LINE_RE = /^\s*([A-Z0-9_]+)\s*:\s*(true|false)\b/

export const BUILD_SCRIPT_PATH = join(import.meta.dir, 'build.ts')

export function parseFeatureFlags(buildScript: string): Record<string, boolean> {
  const body = FLAGS_BLOCK_RE.exec(buildScript)
  if (!body) throw new Error('could not find featureFlags in scripts/build.ts')
  const flags: Record<string, boolean> = {}
  for (const line of body[1]!.split('\n')) {
    const m = FLAG_LINE_RE.exec(line)
    if (m) flags[m[1]!] = m[2] === 'true'
  }
  return flags
}

/** The flag map a `bun run build` bundle is folded against. */
export function loadShippedFeatureFlags(): Record<string, boolean> {
  return parseFeatureFlags(readFileSync(BUILD_SCRIPT_PATH, 'utf-8'))
}
