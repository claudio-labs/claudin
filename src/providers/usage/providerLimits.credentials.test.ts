/**
 * The Codex chip reads the limits with the Codex profile's own credentials,
 * whichever profile is active: a profile linked to its own auth.json
 * (`extras.codexAuthPath`) answers from that file even while Anthropic is.
 *
 * No real credential is reachable from here. Bare mode keeps secure storage
 * and the token refresh out of it, and CODEX_HOME points at an empty temp dir
 * so the resolver never falls back to ~/.codex/auth.json — os.homedir()
 * ignores a HOME override under Bun, so HOME alone would not keep it out.
 * fetch is stubbed, and anything but the fake token is redacted before it is
 * kept.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import {
  invalidateActiveProviderCache,
  resolveProviderProfile,
} from 'src/providers/presets/activeProvider.js'
import { getLimitsFetcher } from 'src/providers/usage/providerLimits.js'

const ENV_KEYS = [
  'CLAUDIN_SIMPLE',
  'CODEX_HOME',
  'CODEX_API_KEY',
  'CODEX_AUTH_JSON_PATH',
  'CODEX_ACCOUNT_ID',
  'CHATGPT_ACCOUNT_ID',
] as const
const savedEnv = new Map<string, string | undefined>()
const realFetch = globalThis.fetch
let dir: string
let savedProfiles: ReturnType<typeof getGlobalConfig>['providerProfiles']
let savedActiveId: string | undefined
const seen: Array<{ auth: string | null; account: string | null }> = []

const CODEX = {
  id: 'p-codex-linked',
  name: 'Codex OAuth',
  provider: 'openai' as const,
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'codexplan',
  extras: { codexAuthPath: '', codexAccountId: 'acct-linked' },
}
const ANTHROPIC = {
  id: 'p-anthropic',
  name: 'Anthropic',
  provider: 'anthropic' as const,
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  for (const key of ENV_KEYS) delete process.env[key]
  dir = mkdtempSync(join(tmpdir(), 'codex-linked-'))
  mkdirSync(join(dir, 'empty-codex-home'))
  process.env.CLAUDIN_SIMPLE = '1'
  process.env.CODEX_HOME = join(dir, 'empty-codex-home')
  CODEX.extras.codexAuthPath = join(dir, 'linked-auth.json')
  writeFileSync(CODEX.extras.codexAuthPath, JSON.stringify({ tokens: { access_token: 'linked-token' } }))
  const config = getGlobalConfig()
  savedProfiles = config.providerProfiles
  savedActiveId = config.activeProviderProfileId
  saveGlobalConfig(c => ({ ...c, providerProfiles: [CODEX, ANTHROPIC] }))
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const auth = headers.get('authorization')
    seen.push({
      auth: auth === 'Bearer linked-token' ? auth : auth ? '<another credential>' : null,
      account: headers.get('chatgpt-account-id'),
    })
    return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } })
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
  saveGlobalConfig(c => ({ ...c, providerProfiles: savedProfiles, activeProviderProfileId: savedActiveId }))
  invalidateActiveProviderCache()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

async function fetchCodexChip(activeId: string): Promise<string> {
  saveGlobalConfig(c => ({ ...c, activeProviderProfileId: activeId }))
  invalidateActiveProviderCache()
  seen.length = 0
  return getLimitsFetcher('codex')!(resolveProviderProfile(CODEX)).then(
    () => `asked with ${seen.at(-1)?.auth} for ${seen.at(-1)?.account}`,
    (err: Error) => err.message,
  )
}

test('with the Codex profile active, its linked auth.json answers', async () => {
  expect(await fetchCodexChip(CODEX.id)).toBe('asked with Bearer linked-token for acct-linked')
})

test('with Anthropic active, the Codex chip still asks with the Codex profile credentials', async () => {
  expect(await fetchCodexChip(ANTHROPIC.id)).toBe('asked with Bearer linked-token for acct-linked')
})
