/**
 * Persistent store for auto-mode classifier capability probes.
 *
 * Records, per provider+baseUrl+model key, whether the provider honors forced
 * tool-choice (the hard requirement of the auto-mode classifier — see
 * classifierProbe.ts). Read synchronously by the auto-mode gate
 * (permissionSetup.ts); written by probeClassifierCapability().
 *
 * Lives in `<configDir>/classifier-probes.json`. The key embeds the model, so
 * switching model/profile naturally misses the cache (no explicit invalidation
 * needed). No TTL — a provider that degrades after a passing probe stays
 * approved, with the iron-gate fail-closed path as the runtime safety net;
 * `/provider doctor` forces a re-probe.
 */

import { createHash } from 'crypto'
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { z } from 'zod/v4'
import { getClaudinConfigHomeDir } from '../envUtils.js'
import { isENOENT } from '../errors.js'
import { logError } from '../log.js'

const STORE_FILENAME = 'classifier-probes.json'

const ProbeEntrySchema = z.object({
  ok: z.boolean(),
  at: z.string(),
  detail: z.string().optional(),
})

const ProbeStoreSchema = z.record(z.string(), ProbeEntrySchema)

export type ClassifierProbeEntry = z.infer<typeof ProbeEntrySchema>

/** Stable cache key for a probe target. sha256 keeps provider/baseUrl/model out of the file in plaintext. */
export function classifierProbeKey(input: {
  provider: string
  baseUrl: string
  model: string
}): string {
  return createHash('sha256')
    .update(`${input.provider}\n${input.baseUrl}\n${input.model}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * @internal - test-only override. getClaudinConfigHomeDir is memoized at module
 * load and tests that mock model/activeProvider modules re-evaluate the import
 * graph before they can set CLAUDIN_CONFIG_DIR, so pointing the store at a
 * tmpdir via env is racy. Tests call this with a mkdtemp dir instead.
 */
let __testConfigDir: string | undefined

export function __setClassifierProbeStoreDirForTests(
  dir: string | undefined,
): void {
  __testConfigDir = dir
  memo = undefined
}

function storePath(): string {
  return join(__testConfigDir ?? getClaudinConfigHomeDir(), STORE_FILENAME)
}

// In-process memo of the parsed store, keyed by path + file mtime. The gate
// (autoModeAllowedForModel) reads the store on the shift-tab keystroke path for
// non-Claude providers — up to twice per press — so an uncached read+parse+zod
// each time is wasteful. Keying on mtimeMs (a cheap stat vs a full read) keeps
// us correct if another claudin process rewrites the file: a pure
// write-invalidated cache would go stale and could pin a {ok:false} for the
// whole session. writeClassifierProbe also clears it after writing.
let memo: { path: string; mtimeMs: number; data: Record<string, ClassifierProbeEntry> } | undefined

function readStore(): Record<string, ClassifierProbeEntry> {
  const path = storePath()
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch (e) {
    if (isENOENT(e)) return {}
    logError(new Error(`classifier-probe: failed to stat ${path}`, { cause: e }))
    return {}
  }
  if (memo && memo.path === path && memo.mtimeMs === mtimeMs) {
    return memo.data
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    logError(new Error(`classifier-probe: failed to read ${path}`, { cause: e }))
    return {}
  }
  const parsed = ProbeStoreSchema.safeParse(raw)
  if (!parsed.success) {
    // Corrupt/foreign file — ignore it rather than trusting partial data.
    logError(new Error(`classifier-probe: ${path} failed validation, ignoring`))
    return {}
  }
  memo = { path, mtimeMs, data: parsed.data }
  return parsed.data
}

/** Returns the recorded probe result for a key, or undefined if never probed (or the store is unreadable/corrupt). */
export function readClassifierProbe(key: string): ClassifierProbeEntry | undefined {
  return readStore()[key]
}

/** Persists a probe result, replacing any previous entry for the key. */
export function writeClassifierProbe(
  key: string,
  entry: ClassifierProbeEntry,
): void {
  const store = readStore()
  store[key] = entry
  const path = storePath()
  try {
    mkdirSync(__testConfigDir ?? getClaudinConfigHomeDir(), { recursive: true })
    writeFileSync(path, JSON.stringify(store, null, 2), 'utf8')
    // Drop the memo so the next read re-stats and re-parses the just-written
    // file (its mtime moved; the next readStore repopulates the memo).
    memo = undefined
  } catch (e) {
    // Non-fatal — worst case the probe re-runs next session.
    logError(new Error(`classifier-probe: failed to write ${path}`, { cause: e }))
  }
}
