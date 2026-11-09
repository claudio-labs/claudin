import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SettingsSchema } from 'src/platform/settings/types.js'
import { getFallbackModelOverride, setFallbackModelOverride } from 'src/platform/bootstrap/state.js'
import {
  type FallbackModelDeps,
  getConfiguredFallbackModel,
  getFallbackModel,
} from 'src/providers/model/fallbackModel.js'

function deps(flag?: string, setting?: string, allowed: (model: string) => boolean = () => true): FallbackModelDeps {
  return {
    flag: () => flag,
    setting: () => setting,
    defaultModel: () => 'claude-opus-5-5',
    parse: model => (model === 'sonnet' ? 'claude-sonnet-5-5' : model),
    isAllowed: allowed,
  }
}

describe('getConfiguredFallbackModel', () => {
  test('none when neither the flag nor the setting names one', () => {
    expect(getConfiguredFallbackModel(deps())).toBeUndefined()
    expect(getConfiguredFallbackModel(deps('  ', ''))).toBeUndefined()
  })

  test('the flag wins over the setting', () => {
    expect(getConfiguredFallbackModel(deps('claude-haiku-5-5', 'sonnet'))).toBe('claude-haiku-5-5')
  })

  test('the setting applies without a flag, aliases resolved', () => {
    expect(getConfiguredFallbackModel(deps(undefined, 'sonnet'))).toBe('claude-sonnet-5-5')
  })

  test('"default" names the default main model', () => {
    expect(getConfiguredFallbackModel(deps('default'))).toBe('claude-opus-5-5')
    expect(getConfiguredFallbackModel(deps(undefined, ' default '))).toBe('claude-opus-5-5')
  })

  test('one outside the availableModels allowlist is ignored; "default" always passes', () => {
    const onlySonnet = (model: string) => model === 'sonnet'
    expect(getConfiguredFallbackModel(deps('opus', undefined, onlySonnet))).toBeUndefined()
    expect(getConfiguredFallbackModel(deps(undefined, 'sonnet', onlySonnet))).toBe('claude-sonnet-5-5')
    expect(getConfiguredFallbackModel(deps('default', undefined, () => false))).toBe('claude-opus-5-5')
  })
})

describe('getFallbackModel', () => {
  test('the fallback for a loop on another model', () => {
    expect(getFallbackModel('claude-opus-5-5', deps(undefined, 'sonnet'))).toBe('claude-sonnet-5-5')
  })

  test('no fallback onto the model already in use', () => {
    expect(getFallbackModel('claude-sonnet-5-5', deps(undefined, 'sonnet'))).toBeUndefined()
    expect(getFallbackModel('claude-opus-5-5', deps('default'))).toBeUndefined()
  })

  test('none configured, none returned', () => {
    expect(getFallbackModel('claude-opus-5-5', deps())).toBeUndefined()
  })
})

describe('the default deps', () => {
  const saved = getFallbackModelOverride()
  afterEach(() => setFallbackModelOverride(saved))

  test('read the --fallback-model flag from bootstrap state', () => {
    setFallbackModelOverride('some-model-id')
    expect(getConfiguredFallbackModel()).toBe('some-model-id')
    expect(getFallbackModel('some-model-id')).toBeUndefined()
  })
})

describe('wiring', () => {
  const src = (rel: string) => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8')

  test('the REPL turn and the backgrounded session pass the fallback for their model', () => {
    const line = '      fallbackModel: getFallbackModel(toolUseContext.options.mainLoopModel)\n'
    expect(src('agent/repl/controllers/useOnQuery.ts')).toContain(line)
    expect(src('agent/repl/controllers/useToolUseContext.ts')).toContain(`    ${line}`)
  })

  test('the flag reaches bootstrap state, and -p gets the resolved value', () => {
    const setup = src('platform/main/action/setupAgent.ts')
    expect(setup).toContain('  setFallbackModelOverride(fallbackModel);\n  const userSpecifiedFallbackModel = getConfiguredFallbackModel();\n')
  })

  test('sub-agents get no fallback', () => {
    expect(src('tools/AgentTool/runAgent.ts')).not.toContain('fallbackModel')
  })
})

describe('the fallbackModel setting', () => {
  test('survives settings parsing: a key the schema lacks would be stripped', () => {
    const parsed = SettingsSchema().safeParse({ fallbackModel: 'sonnet' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.fallbackModel).toBe('sonnet')
  })
})
