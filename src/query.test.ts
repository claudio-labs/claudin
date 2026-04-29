import { describe, test, expect } from 'bun:test'

import {
  getDefaultMainLoopModelSetting,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'

/**
 * Regression tests for the alias-resolution chain that runs in
 * `query.ts` whenever `appState.mainLoopModel` / `mainLoopModelForSession`
 * is consumed (introduced after PR #903 caused literal aliases like
 * `'sonnet'` / `'sonnet[1m]'` to be sent to the API verbatim, producing
 * 404s).
 *
 * The resolution chain under test mirrors `query.ts`:
 *
 *   parseUserSpecifiedModel(
 *     mainLoopModelForSession
 *       ?? mainLoopModel
 *       ?? getDefaultMainLoopModelSetting(),
 *   )
 */

type AppStateLike = {
  mainLoopModel?: string | null
  mainLoopModelForSession?: string | null
}

function resolveAppStateMainLoopModel(appState: AppStateLike): string {
  return parseUserSpecifiedModel(
    appState.mainLoopModelForSession ??
      appState.mainLoopModel ??
      getDefaultMainLoopModelSetting(),
  )
}

describe('query.ts mainLoopModel alias resolution', () => {
  test('"sonnet" alias resolves to the concrete Sonnet model id', () => {
    const resolved = resolveAppStateMainLoopModel({ mainLoopModel: 'sonnet' })
    expect(resolved).toBe(getDefaultSonnetModel())
    expect(resolved).not.toBe('sonnet')
  })

  test('"sonnet[1m]" alias resolves and preserves the [1m] suffix', () => {
    const resolved = resolveAppStateMainLoopModel({
      mainLoopModel: 'sonnet[1m]',
    })
    expect(resolved).toBe(getDefaultSonnetModel() + '[1m]')
    expect(resolved.endsWith('[1m]')).toBe(true)
    expect(resolved).not.toBe('sonnet[1m]')
  })

  test('"opus" alias resolves to the concrete Opus model id', () => {
    const resolved = resolveAppStateMainLoopModel({ mainLoopModel: 'opus' })
    expect(resolved).toBe(getDefaultOpusModel())
    expect(resolved).not.toBe('opus')
  })

  test('"opus[1m]" alias resolves and preserves the [1m] suffix', () => {
    const resolved = resolveAppStateMainLoopModel({
      mainLoopModel: 'opus[1m]',
    })
    expect(resolved).toBe(getDefaultOpusModel() + '[1m]')
  })

  test('full model ID is passed through unchanged', () => {
    const fullId = 'claude-sonnet-4-6'
    const resolved = resolveAppStateMainLoopModel({ mainLoopModel: fullId })
    expect(resolved).toBe(fullId)
  })

  test('full model ID with [1m] suffix is passed through unchanged', () => {
    const fullId = 'claude-sonnet-4-6[1m]'
    const resolved = resolveAppStateMainLoopModel({ mainLoopModel: fullId })
    expect(resolved).toBe(fullId)
  })

  test('mainLoopModelForSession takes precedence over mainLoopModel', () => {
    const resolved = resolveAppStateMainLoopModel({
      mainLoopModel: 'opus',
      mainLoopModelForSession: 'sonnet',
    })
    expect(resolved).toBe(getDefaultSonnetModel())
  })

  test('mainLoopModelForSession alias is also resolved (not passed raw)', () => {
    const resolved = resolveAppStateMainLoopModel({
      mainLoopModelForSession: 'sonnet[1m]',
    })
    expect(resolved).toBe(getDefaultSonnetModel() + '[1m]')
    expect(resolved).not.toBe('sonnet[1m]')
  })

  test('falls back to default setting when nothing is set on appState', () => {
    const resolved = resolveAppStateMainLoopModel({})
    // Whatever the default is, it must already be a concrete model id —
    // never an alias literal like "sonnet" or "opus".
    expect(resolved).not.toBe('sonnet')
    expect(resolved).not.toBe('sonnet[1m]')
    expect(resolved).not.toBe('opus')
    expect(resolved).not.toBe('opus[1m]')
    expect(resolved).not.toBe('haiku')
    expect(typeof resolved).toBe('string')
    expect(resolved.length).toBeGreaterThan(0)
  })
})
