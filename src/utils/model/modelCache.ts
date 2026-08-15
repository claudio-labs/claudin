/**
 * Model Caching for Claudin
 * 
 * Caches model lists to disk for faster startup and offline access.
 * Uses async fs operations to avoid blocking the event loop.
 */

import { access, readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getAPIProvider } from 'src/utils/model/providers.js'

function getActiveBaseUrl(): string {
  return tryGetActiveProvider()?.baseUrl ?? ''
}

const CACHE_VERSION = '1'
const CACHE_TTL_HOURS = 24
const CACHE_DIR_NAME = 'model-cache'

interface ModelCache {
  version: string
  timestamp: number
  provider: string
  models: Array<{ value: string; label: string; description: string }>
}

function getCacheDir(): string {
  const cacheDir = join(getClaudinConfigHomeDir(), CACHE_DIR_NAME)
  if (!existsSync(cacheDir)) {
    mkdir(cacheDir, { recursive: true })
  }
  return cacheDir
}

function getCacheFilePath(provider: string): string {
  return join(getCacheDir(), `${provider}.json`)
}

function isOpenAICompatibleProvider(): boolean {
  const baseUrl = getActiveBaseUrl()
  return baseUrl.includes('localhost') || baseUrl.includes('nvidia') || baseUrl.includes('minimax') || getAPIProvider() === 'openai'
}

export async function isModelCacheValid(provider: string): Promise<boolean> {
  const cachePath = getCacheFilePath(provider)
  
  try {
    await access(cachePath)
  } catch {
    return false
  }

  try {
    const data = JSON.parse(await readFile(cachePath, 'utf-8')) as ModelCache
    if (data.version !== CACHE_VERSION) {
      return false
    }
    if (data.provider !== provider) {
      return false
    }

    const ageHours = (Date.now() - data.timestamp) / (1000 * 60 * 60)
    return ageHours < CACHE_TTL_HOURS
  } catch {
    return false
  }
}

export async function getCachedModelsFromDisk<T>(): Promise<T[] | null> {
  const provider = getAPIProvider()
  const baseUrl = getActiveBaseUrl()
  const isLocalOllama = baseUrl.includes('localhost:11434') || baseUrl.includes('localhost:11435')
  const isNvidia = baseUrl.includes('nvidia') || baseUrl.includes('integrate.api.nvidia')
  const isMiniMax = baseUrl.includes('minimax')
  
  if (!isLocalOllama && !isNvidia && !isMiniMax && provider !== 'openai') {
    return null
  }

  const cachePath = getCacheFilePath(provider)
  
  if (!(await isModelCacheValid(provider))) {
    return null
  }

  try {
    const data = JSON.parse(await readFile(cachePath, 'utf-8')) as ModelCache
    return data.models as T[]
  } catch {
    return null
  }
}

export async function saveModelsToCache(
  models: Array<{ value: string; label: string; description: string }>,
): Promise<void> {
  const provider = getAPIProvider()
  if (!provider) return

  const cachePath = getCacheFilePath(provider)
  const cacheData: ModelCache = {
    version: CACHE_VERSION,
    timestamp: Date.now(),
    provider,
    models,
  }
  
  try {
    await writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8')
  } catch (error) {
    console.warn('[ModelCache] Failed to save cache:', error)
  }
}


