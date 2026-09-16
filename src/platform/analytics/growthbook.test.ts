import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * These used to run against a stub EXTRACTED from `no-telemetry-plugin.ts` with
 * a regex, written to a temp `.mjs` and imported — because the real module was
 * a GrowthBook client that the build replaced wholesale, so the shipped
 * resolution existed only as a string inside the build script.
 *
 * That stub is the source now, so this imports it directly. The assertions did
 * not change: the point of the collapse was that they would not have to.
 */
const testDir = join(tmpdir(), `growthbook-test-${process.pid}`)
const flagsFile = join(testDir, 'test-flags.json')

mkdirSync(testDir, { recursive: true })
// Read on first access, so it must be set before the import below.
process.env.CLAUDE_FEATURE_FLAGS_FILE = flagsFile

const stub = await import('src/platform/analytics/growthbook.js')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('feature flags — local overrides', () => {
  beforeEach(() => {
    stub.resetGrowthBook()
    try { unlinkSync(flagsFile) } catch { /* may not exist */ }
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    delete process.env.CLAUDE_FEATURE_FLAGS_FILE
  })

  // ── File absent ──────────────────────────────────────────────────

  test('returns defaultValue when flags file is absent', () => {
    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_foo', 42)).toBe(42)
  })

  test('getAllGrowthBookFeatures returns {} when file is absent', () => {
    expect(stub.getAllGrowthBookFeatures()).toEqual({})
  })

  // ── Open-build defaults (_openBuildDefaults) ────────────────────

  test('returns open-build default when flags file is absent', () => {
    // tengu_passport_quail is in _openBuildDefaults as true; without a
    // flags file the stub should return the open-build override, not
    // the call-site defaultValue.
    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', false)).toBe(true)
    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_coral_fern', false)).toBe(true)
  })

  test('flags file overrides open-build defaults', () => {
    // User-provided feature-flags.json takes priority over _openBuildDefaults.
    writeFileSync(flagsFile, JSON.stringify({ tengu_passport_quail: false }))

    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', true)).toBe(false)
  })

  // ── Security restrictions are not user-settable ─────────────────

  test('a security-restriction key ignores the flags file on EVERY accessor', async () => {
    // tengu_disable_bypass_permissions_mode is a remote killswitch upstream:
    // set it and --dangerously-skip-permissions stops working. There is no
    // remote here, so a user setting it would only lock themselves out of a
    // mode they asked for, with nothing explaining why.
    //
    // checkSecurityRestrictionGate was blanked for exactly that reason — but
    // src/permissions/permissionSetup.ts reads the SAME key through
    // checkStatsigFeatureGate at three sites, so blanking one accessor left
    // the other honouring the file. The refusal now lives in the shared
    // lookup, which is why this asserts on every door rather than one.
    writeFileSync(
      flagsFile,
      JSON.stringify({ tengu_disable_bypass_permissions_mode: true }),
    )

    expect(
      await stub.checkSecurityRestrictionGate(
        'tengu_disable_bypass_permissions_mode',
      ),
    ).toBe(false)
    expect(
      stub.checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'tengu_disable_bypass_permissions_mode',
      ),
    ).toBe(false)
    expect(
      stub.getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_disable_bypass_permissions_mode',
        false,
      ),
    ).toBe(false)
    expect(
      await stub.checkGate_CACHED_OR_BLOCKING(
        'tengu_disable_bypass_permissions_mode',
      ),
    ).toBe(false)
  })

  test('the refusal is scoped to that key, not to the whole file', () => {
    // A blanket "ignore the file" would be a worse bug than the one fixed.
    writeFileSync(
      flagsFile,
      JSON.stringify({
        tengu_disable_bypass_permissions_mode: true,
        tengu_foo: true,
      }),
    )

    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_foo', false)).toBe(true)
  })

  // ── Valid JSON object ────────────────────────────────────────────

  test('loads and returns values from a valid JSON file', () => {
    writeFileSync(flagsFile, JSON.stringify({ tengu_foo: true, tengu_bar: 'hello' }))

    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_foo', false)).toBe(true)
    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_bar', 'default')).toBe('hello')
  })

  test('returns defaultValue for keys not present in the file', () => {
    writeFileSync(flagsFile, JSON.stringify({ tengu_foo: true }))

    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_missing', 99)).toBe(99)
  })

  test('getAllGrowthBookFeatures returns the full flags object', () => {
    const flags = { tengu_a: true, tengu_b: false, tengu_c: 42 }
    writeFileSync(flagsFile, JSON.stringify(flags))

    expect(stub.getAllGrowthBookFeatures()).toEqual(flags)
  })

  // ── Malformed / non-object JSON ──────────────────────────────────

  test('falls back to defaults on malformed JSON', () => {
    writeFileSync(flagsFile, '{not valid json!!!')

    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_foo', 'fallback')).toBe('fallback')
  })

  test('falls back to defaults when JSON is a primitive (true)', () => {
    writeFileSync(flagsFile, 'true')

    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_foo', 'fallback')).toBe('fallback')
  })

  test('falls back to defaults when JSON is an array', () => {
    writeFileSync(flagsFile, '["a", "b"]')

    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_foo', 'fallback')).toBe('fallback')
  })

  // ── Cache invalidation ───────────────────────────────────────────

  test('resetGrowthBook clears cache so the file is re-read', () => {
    writeFileSync(flagsFile, JSON.stringify({ tengu_foo: 'first' }))
    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_foo', 'x')).toBe('first')

    // Update the file — cached value is still 'first'
    writeFileSync(flagsFile, JSON.stringify({ tengu_foo: 'second' }))
    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_foo', 'x')).toBe('first')

    // After reset, the new value is picked up
    stub.resetGrowthBook()
    expect(stub.getFeatureValue_CACHED_MAY_BE_STALE('tengu_foo', 'x')).toBe('second')
  })

  // ── Multiple getter variants ─────────────────────────────────────

  test('all getter functions read from local flags', async () => {
    writeFileSync(flagsFile, JSON.stringify({ tengu_gate: true, tengu_config: { a: 1 } }))

    expect(await stub.getFeatureValue_DEPRECATED('tengu_gate', false)).toBe(true)
    stub.resetGrowthBook()
    expect(stub.getFeatureValue_CACHED_WITH_REFRESH('tengu_gate', false)).toBe(true)
    stub.resetGrowthBook()
    expect(stub.checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_gate')).toBe(true)
    stub.resetGrowthBook()
    expect(await stub.checkGate_CACHED_OR_BLOCKING('tengu_gate')).toBe(true)
    stub.resetGrowthBook()
    expect(await stub.getDynamicConfig_BLOCKS_ON_INIT('tengu_config', {})).toEqual({ a: 1 })
    stub.resetGrowthBook()
    expect(stub.getDynamicConfig_CACHED_MAY_BE_STALE('tengu_config', {})).toEqual({ a: 1 })
  })

  // ── Security gate ────────────────────────────────────────────────

  test('checkSecurityRestrictionGate always returns false regardless of flags', async () => {
    writeFileSync(flagsFile, JSON.stringify({
      tengu_disable_bypass_permissions_mode: true,
    }))

    expect(await stub.checkSecurityRestrictionGate('tengu_x')).toBe(false)
  })
})
