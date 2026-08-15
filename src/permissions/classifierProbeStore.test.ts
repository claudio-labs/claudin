import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __setClassifierProbeStoreDirForTests,
  classifierProbeKey,
  readClassifierProbe,
  writeClassifierProbe,
} from 'src/permissions/classifierProbeStore.js'

let fakeConfigDir: string

beforeEach(() => {
  fakeConfigDir = mkdtempSync(join(tmpdir(), 'classifier-probe-store-'))
  __setClassifierProbeStoreDirForTests(fakeConfigDir)
})

afterEach(() => {
  __setClassifierProbeStoreDirForTests(undefined)
  rmSync(fakeConfigDir, { recursive: true, force: true })
})

const KEY_A = classifierProbeKey({
  provider: 'openai_compat',
  baseUrl: 'https://api.example.com/v1',
  model: 'model-a',
})

describe('classifierProbeKey', () => {
  test('is stable for the same input', () => {
    expect(KEY_A).toBe(
      classifierProbeKey({
        provider: 'openai_compat',
        baseUrl: 'https://api.example.com/v1',
        model: 'model-a',
      }),
    )
  })

  test('changes when the model changes (auto-invalidation on model switch)', () => {
    const keyB = classifierProbeKey({
      provider: 'openai_compat',
      baseUrl: 'https://api.example.com/v1',
      model: 'model-b',
    })
    expect(keyB).not.toBe(KEY_A)
  })

  test('changes when the provider changes', () => {
    const keyB = classifierProbeKey({
      provider: 'gemini',
      baseUrl: 'https://api.example.com/v1',
      model: 'model-a',
    })
    expect(keyB).not.toBe(KEY_A)
  })
})

describe('readClassifierProbe / writeClassifierProbe', () => {
  test('returns undefined when never probed', () => {
    expect(readClassifierProbe(KEY_A)).toBeUndefined()
  })

  test('round-trips a passing entry', () => {
    writeClassifierProbe(KEY_A, { ok: true, at: '2026-07-18T00:00:00.000Z' })
    expect(readClassifierProbe(KEY_A)).toEqual({
      ok: true,
      at: '2026-07-18T00:00:00.000Z',
    })
  })

  test('round-trips a failing entry with detail', () => {
    writeClassifierProbe(KEY_A, {
      ok: false,
      at: '2026-07-18T00:00:00.000Z',
      detail: 'no tool_use block',
    })
    expect(readClassifierProbe(KEY_A)?.ok).toBe(false)
    expect(readClassifierProbe(KEY_A)?.detail).toBe('no tool_use block')
  })

  test('overwrites an existing entry (doctor re-probe)', () => {
    writeClassifierProbe(KEY_A, { ok: false, at: 't1' })
    writeClassifierProbe(KEY_A, { ok: true, at: 't2' })
    expect(readClassifierProbe(KEY_A)).toEqual({ ok: true, at: 't2' })
  })

  test('ignores a corrupt store file instead of throwing', () => {
    writeFileSync(
      join(fakeConfigDir, 'classifier-probes.json'),
      '{ not json',
      'utf8',
    )
    expect(readClassifierProbe(KEY_A)).toBeUndefined()
  })

  test('ignores a store that fails schema validation', () => {
    writeFileSync(
      join(fakeConfigDir, 'classifier-probes.json'),
      JSON.stringify({ [KEY_A]: { ok: 'yes' } }),
      'utf8',
    )
    expect(readClassifierProbe(KEY_A)).toBeUndefined()
  })
})
