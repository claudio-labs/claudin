import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Spread the real activeProvider module so its other exports
// (ActiveProviderNotConfiguredError, getActiveProvider, etc.) survive the
// process-global mock. detectProvider goes through tryGetActiveProvider, so
// the test surface is the resolver, not env vars.
const realActiveProvider = { ...(await import('../services/api/activeProvider.js')) }
const realActiveProviderSnapshot = { ...realActiveProvider }

type ResolvedProvider = ReturnType<typeof realActiveProvider.getActiveProvider> | null

let resolvedOverride: ResolvedProvider = null

mock.module('../services/api/activeProvider.js', () => ({
  ...realActiveProviderSnapshot,
  tryGetActiveProvider: () => resolvedOverride,
}))

// Re-import after mock so detectProvider sees the patched module.
const { detectProvider } = await import('./StartupScreen.js')

afterAll(() => {
  mock.module('../services/api/activeProvider.js', () => realActiveProviderSnapshot)
})

beforeEach(() => {
  resolvedOverride = null
})

afterEach(() => {
  resolvedOverride = null
})

function setupOpenAIMode(baseUrl: string, model: string): void {
  resolvedOverride = {
    transport: 'openai_compat',
    baseUrl,
    model,
    apiKey: 'test-key',
  }
}

function setupGemini(model = 'gemini-2.0-flash'): void {
  resolvedOverride = {
    transport: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model,
  }
}

function setupMistral(model = 'mistral-large-latest'): void {
  resolvedOverride = {
    transport: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model,
  }
}

function setupGithub(model = 'github:copilot'): void {
  resolvedOverride = {
    transport: 'github_copilot',
    baseUrl: 'https://api.githubcopilot.com',
    model,
  }
}

// --- Issue #855: aggregator URL must win over vendor-prefixed model name ---

describe('detectProvider — aggregator URL authoritative over model-name substring (#855)', () => {
  test('OpenRouter + deepseek/deepseek-chat labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'deepseek/deepseek-chat')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('OpenRouter + moonshotai/kimi-k2 labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'moonshotai/kimi-k2')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('OpenRouter + mistralai/mistral-large labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'mistralai/mistral-large')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('OpenRouter + meta-llama/llama-3.3 labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('Together + deepseek-ai/DeepSeek-V3 labels as Together AI', () => {
    setupOpenAIMode('https://api.together.xyz/v1', 'deepseek-ai/DeepSeek-V3')
    expect(detectProvider().name).toBe('Together AI')
  })

  test('Together + meta-llama/Llama-3.3 labels as Together AI', () => {
    setupOpenAIMode('https://api.together.xyz/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo')
    expect(detectProvider().name).toBe('Together AI')
  })

  test('Groq + deepseek-r1-distill-llama-70b labels as Groq', () => {
    setupOpenAIMode('https://api.groq.com/openai/v1', 'deepseek-r1-distill-llama-70b')
    expect(detectProvider().name).toBe('Groq')
  })

  test('Groq + llama-3.3-70b-versatile labels as Groq', () => {
    setupOpenAIMode('https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile')
    expect(detectProvider().name).toBe('Groq')
  })

  test('Azure + any deepseek deployment labels as Azure OpenAI', () => {
    setupOpenAIMode('https://my-resource.openai.azure.com/', 'deepseek-chat')
    expect(detectProvider().name).toBe('Azure OpenAI')
  })
})

// --- Direct vendor endpoints still label correctly (regression) ---

describe('detectProvider — direct vendor endpoints', () => {
  test('api.deepseek.com labels as DeepSeek', () => {
    setupOpenAIMode('https://api.deepseek.com/v1', 'deepseek-chat')
    expect(detectProvider().name).toBe('DeepSeek')
  })

  test('api.kimi.com labels as Moonshot AI - Kimi Code', () => {
    setupOpenAIMode('https://api.kimi.com/coding/v1', 'kimi-for-coding')
    expect(detectProvider().name).toBe('Moonshot AI - Kimi Code')
  })

  test('api.moonshot.cn labels as Moonshot AI - API', () => {
    setupOpenAIMode('https://api.moonshot.cn/v1', 'moonshot-v1-8k')
    expect(detectProvider().name).toBe('Moonshot AI - API')
  })

  test('api.mistral.ai labels as Mistral', () => {
    // Direct mistral endpoint via the openai_compat path still labels as
    // Mistral by URL — same path the user takes when they bring their own
    // mistral profile through the openai preset.
    setupOpenAIMode('https://api.mistral.ai/v1', 'mistral-large-latest')
    expect(detectProvider().name).toBe('Mistral')
  })

  test('default OpenAI URL + gpt-4o labels as OpenAI', () => {
    setupOpenAIMode('https://api.openai.com/v1', 'gpt-4o')
    expect(detectProvider().name).toBe('OpenAI')
  })
})

// --- rawModel fallback for generic/custom endpoints ---

describe('detectProvider — rawModel fallback when URL is generic', () => {
  test('custom proxy + deepseek-chat falls back to DeepSeek', () => {
    setupOpenAIMode('https://my-proxy.example/v1', 'deepseek-chat')
    expect(detectProvider().name).toBe('DeepSeek')
  })

  test('custom proxy + kimi-for-coding falls back to Moonshot AI - Kimi Code', () => {
    setupOpenAIMode('https://my-proxy.example/v1', 'kimi-for-coding')
    expect(detectProvider().name).toBe('Moonshot AI - Kimi Code')
  })

  test('custom proxy + kimi-k2 falls back to Moonshot AI - API', () => {
    setupOpenAIMode('https://my-proxy.example/v1', 'kimi-k2-instruct')
    expect(detectProvider().name).toBe('Moonshot AI - API')
  })

  test('custom proxy + llama-3.3 falls back to Meta Llama', () => {
    setupOpenAIMode('https://my-proxy.example/v1', 'llama-3.3-70b')
    expect(detectProvider().name).toBe('Meta Llama')
  })

  test('custom proxy + mistral-large falls back to Mistral', () => {
    setupOpenAIMode('https://my-proxy.example/v1', 'mistral-large-latest')
    expect(detectProvider().name).toBe('Mistral')
  })
})

// --- modelOverride from --model flag ---

describe('detectProvider — modelOverride from --model flag', () => {
  test('modelOverride still resolves the model when no provider is configured', () => {
    const result = detectProvider('claude-opus-4-6')
    expect(result.name).toBe('Not configured')
    expect(result.model).toContain('opus')
  })

  test('modelOverride alias is resolved without inventing a provider', () => {
    const result = detectProvider('opus')
    expect(result.name).toBe('Not configured')
    expect(result.model).toContain('opus')
  })

  test('modelOverride works for OpenAI provider', () => {
    setupOpenAIMode('https://api.openai.com/v1', 'gpt-4o')
    const result = detectProvider('gpt-4-turbo')
    expect(result.model).toContain('gpt-4-turbo')
  })

  test('modelOverride works for Gemini provider', () => {
    setupGemini()
    const result = detectProvider('gemini-2.5-pro')
    expect(result.model).toBe('gemini-2.5-pro')
  })

  test('modelOverride works for Mistral provider', () => {
    setupMistral()
    const result = detectProvider('mistral-large-latest')
    expect(result.model).toBe('mistral-large-latest')
  })

  test('modelOverride works for GitHub provider', () => {
    setupGithub()
    const result = detectProvider('gpt-4o')
    expect(result.model).toContain('gpt-4o')
  })
})

// --- resolveUpdateNotice: guards against stale/mismatched cache ---

describe('resolveUpdateNotice', () => {
  // The resolver is the gatekeeper between the on-disk cache and the
  // banner notice. Each guard clause gets a behavioral test so a
  // mutation (delete, invert, narrow) is caught.

  const tmpDirs: string[] = []
  let originalConfigDir: string | undefined
  let originalMacro: unknown

  const mkTmp = async (): Promise<string> => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'claudin-resolve-notice-'))
    tmpDirs.push(dir)
    return dir
  }

  const writeCacheFile = async (
    dir: string,
    contents: string,
  ): Promise<void> => {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await writeFile(join(dir, 'latest-version.json'), contents, 'utf8')
  }

  beforeEach(() => {
    originalConfigDir = process.env.CLAUDIN_CONFIG_DIR
    originalMacro = (globalThis as { MACRO?: unknown }).MACRO
    ;(globalThis as { MACRO?: { VERSION: string; DISPLAY_VERSION?: string } }).MACRO =
      { VERSION: '0.0.0', DISPLAY_VERSION: '1.0.0' }
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = originalConfigDir
    ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
    const { rm } = await import('node:fs/promises')
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true })
    }
    tmpDirs.length = 0
  })

  test('returns notice when latest > current and cache.current matches', async () => {
    const dir = await mkTmp()
    process.env.CLAUDIN_CONFIG_DIR = dir
    await writeCacheFile(
      dir,
      JSON.stringify({ latest: '1.2.3', current: '1.0.0', checkedAt: 1 }),
    )
    const { resolveUpdateNotice } = await import('./StartupScreen.js')
    expect(resolveUpdateNotice()).toEqual({ latest: '1.2.3' })
  })

  test('suppresses notice when cache.current !== current (user just updated)', async () => {
    // Critical guard: the cache may point at the *previous* running version
    // immediately after `claudin update`. Showing "v1.2.3 available" when
    // the running binary is already 1.2.3 (or higher) is a UX bug.
    const dir = await mkTmp()
    process.env.CLAUDIN_CONFIG_DIR = dir
    await writeCacheFile(
      dir,
      JSON.stringify({ latest: '1.2.3', current: '0.9.0', checkedAt: 1 }),
    )
    const { resolveUpdateNotice } = await import('./StartupScreen.js')
    expect(resolveUpdateNotice()).toBeUndefined()
  })

  test('suppresses notice when latest === current (no upgrade available)', async () => {
    const dir = await mkTmp()
    process.env.CLAUDIN_CONFIG_DIR = dir
    await writeCacheFile(
      dir,
      JSON.stringify({ latest: '1.0.0', current: '1.0.0', checkedAt: 1 }),
    )
    const { resolveUpdateNotice } = await import('./StartupScreen.js')
    expect(resolveUpdateNotice()).toBeUndefined()
  })

  test('suppresses notice when latest < current (downgrade — running ahead of npm)', async () => {
    const dir = await mkTmp()
    process.env.CLAUDIN_CONFIG_DIR = dir
    await writeCacheFile(
      dir,
      JSON.stringify({ latest: '0.9.0', current: '1.0.0', checkedAt: 1 }),
    )
    const { resolveUpdateNotice } = await import('./StartupScreen.js')
    expect(resolveUpdateNotice()).toBeUndefined()
  })

  test('suppresses notice when cache is missing', async () => {
    const dir = await mkTmp()
    process.env.CLAUDIN_CONFIG_DIR = dir
    const { resolveUpdateNotice } = await import('./StartupScreen.js')
    expect(resolveUpdateNotice()).toBeUndefined()
  })

  test('suppresses notice when cache.latest is non-semver garbage', async () => {
    // Defends the try/catch around gt(): isValidCache only checks string
    // shape, not semver validity. Non-Bun runtimes' semver throws on
    // garbage input — we must still fail closed (no notice).
    const dir = await mkTmp()
    process.env.CLAUDIN_CONFIG_DIR = dir
    await writeCacheFile(
      dir,
      JSON.stringify({ latest: 'not-a-version', current: '1.0.0', checkedAt: 1 }),
    )
    const { resolveUpdateNotice } = await import('./StartupScreen.js')
    expect(resolveUpdateNotice()).toBeUndefined()
  })
})

describe('detectProvider — no active profile', () => {
  test('reports "Not configured" instead of guessing Anthropic', () => {
    const result = detectProvider()
    expect(result.name).toBe('Not configured')
    expect(result.model).toBe('—')
    expect(result.baseUrl).toBe('—')
    expect(result.isLocal).toBe(false)
  })

  test('undefined modelOverride keeps the placeholder', () => {
    const result = detectProvider(undefined)
    expect(result.name).toBe('Not configured')
    expect(result.model).toBe('—')
  })
})
