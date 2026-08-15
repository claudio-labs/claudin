import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import {
  isKimiCodeBaseUrl,
  isXaiOAuthBaseUrl,
  resolveProviderRequest,
} from 'src/providers/presets/providerConfig.js'
import {
  readXaiCredentialsAsync,
  refreshXaiAccessTokenIfNeeded,
} from 'src/providers/oauth/xaiCredentials.js'
import { getXaiUserAgent } from 'src/providers/oauth/xaiUserAgent.js'
import {
  readKimiCredentialsAsync,
  refreshKimiAccessTokenIfNeeded,
} from 'src/providers/oauth/kimiCredentials.js'
import { getKimiUserAgent } from 'src/providers/oauth/kimiUserAgent.js'
import { getKimiDeviceHeaders } from 'src/providers/oauth/kimiDeviceHeaders.js'
import { getCurrentProjectConfig } from 'src/platform/config/config.js'
import { modelSupportsAutoMode } from 'src/providers/transport/betas.js'
import { getMainLoopModel } from 'src/utils/model/model.js'
import {
  getClassifierProbeKey,
  probeClassifierCapability,
} from 'src/services/permissions/classifierProbe.js'
import { parseModelList } from 'src/providers/presets/providerModels.js'
import {
  type OllamaGenerationReadiness,
  probeOllamaGenerationReadiness,
} from 'src/providers/presets/providerDiscovery.js'
import { resolveGeminiCredential } from 'src/providers/oauth/geminiAuth.js'
import {
  getActiveProviderProfile,
  getGlobalActiveProviderProfileId,
  getProjectActiveProviderProfileId,
  getProviderProfiles,
  getRawProjectActiveProviderProfileId,
  hasProjectProviderProfileOverride,
} from 'src/providers/presets/providerProfiles.js'
import { redactUrlForDisplay } from 'src/shared/urlRedaction.js'

type CheckResult = {
  ok: boolean
  label: string
  detail?: string
}

function pass(label: string, detail?: string): CheckResult {
  return { ok: true, label, detail }
}

function fail(label: string, detail?: string): CheckResult {
  return { ok: false, label, detail }
}

async function probeReachability(
  endpoint: string,
  options?: { method?: string; headers?: Record<string, string>; timeoutMs?: number },
): Promise<{ ok: boolean; status?: number; body?: string; error?: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 5000)
  try {
    const response = await fetch(endpoint, {
      method: options?.method ?? 'GET',
      headers: options?.headers,
      signal: controller.signal,
    })
    if (response.ok) return { ok: true, status: response.status }
    const body = await response.text().catch(() => '')
    return { ok: false, status: response.status, body }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeout)
  }
}

async function checkOllamaProfile(baseUrl: string, model: string): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const readiness: OllamaGenerationReadiness = await probeOllamaGenerationReadiness({
    baseUrl,
    model,
  })
  if (readiness.state === 'unreachable') {
    out.push(fail('Ollama reachability', `Could not reach ${redactUrlForDisplay(baseUrl)}.`))
  } else if (readiness.state === 'no_models') {
    out.push(fail('Ollama models', 'Ollama is running but no models are installed.'))
  } else if (readiness.state === 'generation_failed') {
    out.push(
      fail(
        'Ollama generation probe',
        `Probe for ${readiness.probeModel ?? model} failed. ${readiness.detail ?? ''}`.trim(),
      ),
    )
  } else {
    out.push(pass('Ollama generation', `${readiness.probeModel ?? model} responded.`))
  }
  return out
}

async function checkXaiOAuthProfile(baseUrl: string): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  // Refresh first so the probe uses a non-stale Bearer; treat refresh
  // failure as a soft warning (the probe may still succeed if the cached
  // token is fresh enough) instead of a hard fail.
  let accessToken: string | undefined
  try {
    const refresh = await refreshXaiAccessTokenIfNeeded()
    accessToken = refresh.credentials?.accessToken
  } catch (e) {
    out.push(
      fail(
        'xAI OAuth refresh',
        `Refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
    const stored = await readXaiCredentialsAsync()
    accessToken = stored?.accessToken
  }
  if (!accessToken) {
    out.push(
      fail(
        'xAI OAuth credentials',
        'No access token stored. Re-run /provider and pick xAI / Grok (OAuth).',
      ),
    )
    return out
  }
  const trimmed = baseUrl.replace(/\/+$/, '')
  const probe = await probeReachability(`${trimmed}/models`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': getXaiUserAgent(),
    },
  })
  if (!probe.ok) {
    if (probe.status === 401 || probe.status === 403) {
      out.push(
        fail(
          'xAI /v1/models',
          `Got ${probe.status} — token may be revoked. Re-run /provider.`,
        ),
      )
    } else if (probe.status) {
      out.push(
        fail('xAI /v1/models', `Unexpected status ${probe.status}.`),
      )
    } else {
      out.push(
        fail('xAI /v1/models', `Could not reach api.x.ai: ${probe.error}`),
      )
    }
    return out
  }
  // probeReachability only returns status on success; do a second fetch to
  // count models (best-effort; failure here doesn't degrade the overall
  // pass result since /v1/models already responded 200).
  let modelCount: number | undefined
  try {
    const response = await fetch(`${trimmed}/models`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': getXaiUserAgent(),
      },
    })
    if (response.ok) {
      const body = (await response.json()) as { data?: unknown }
      if (Array.isArray(body.data)) modelCount = body.data.length
    }
  } catch {
    // best-effort — main check already passed
  }
  out.push(
    pass(
      'xAI /v1/models',
      modelCount !== undefined
        ? `OK (${modelCount} model${modelCount === 1 ? '' : 's'})`
        : 'OK',
    ),
  )
  return out
}

async function checkKimiOAuthProfile(baseUrl: string): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  let accessToken: string | undefined
  try {
    const refresh = await refreshKimiAccessTokenIfNeeded()
    accessToken = refresh.credentials?.accessToken
  } catch (e) {
    out.push(
      fail(
        'Kimi Code OAuth refresh',
        `Refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
    const stored = await readKimiCredentialsAsync()
    accessToken = stored?.accessToken
  }
  if (!accessToken) {
    out.push(
      fail(
        'Kimi Code OAuth credentials',
        'No access token stored. Re-run /provider and pick Moonshot AI (OAuth).',
      ),
    )
    return out
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': getKimiUserAgent(),
    ...(await getKimiDeviceHeaders()),
  }
  const trimmed = baseUrl.replace(/\/+$/, '')
  const probe = await probeReachability(`${trimmed}/models`, { headers })
  if (!probe.ok) {
    if (probe.status === 401 || probe.status === 403) {
      out.push(
        fail(
          'Kimi Code /v1/models',
          `Got ${probe.status} — token may be revoked. Re-run /provider.`,
        ),
      )
    } else if (probe.status) {
      out.push(fail('Kimi Code /v1/models', `Unexpected status ${probe.status}.`))
    } else {
      out.push(
        fail('Kimi Code /v1/models', `Could not reach api.kimi.com: ${probe.error}`),
      )
    }
    return out
  }
  let modelCount: number | undefined
  try {
    const response = await fetch(`${trimmed}/models`, { headers })
    if (response.ok) {
      const body = (await response.json()) as { data?: unknown }
      if (Array.isArray(body.data)) modelCount = body.data.length
    }
  } catch {
    // best-effort — main check already passed
  }
  out.push(
    pass(
      'Kimi Code /v1/models',
      modelCount !== undefined
        ? `OK (${modelCount} model${modelCount === 1 ? '' : 's'})`
        : 'OK',
    ),
  )
  return out
}

async function checkOpenAICompat(baseUrl: string, apiKey?: string): Promise<CheckResult[]> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const trimmed = baseUrl.replace(/\/+$/, '')
  const probe = await probeReachability(`${trimmed}/models`, { headers })
  if (probe.ok) {
    return [pass('Models endpoint', `${redactUrlForDisplay(trimmed)}/models reachable.`)]
  }
  if (probe.status === 401 || probe.status === 403) {
    return [fail('Auth', `${redactUrlForDisplay(trimmed)} returned ${probe.status}. Check API key.`)]
  }
  if (probe.status) {
    return [fail('Reachability', `Unexpected status ${probe.status} from ${redactUrlForDisplay(trimmed)}.`)]
  }
  return [fail('Reachability', `Could not reach ${redactUrlForDisplay(trimmed)}: ${probe.error}`)]
}

export async function runProviderDoctor(): Promise<string> {
  const profile = tryGetActiveProvider()
  if (!profile) {
    return 'No active /provider profile. Run /provider to set one.'
  }

  const lines: string[] = []
  const results: CheckResult[] = []

  const projectActiveId = getProjectActiveProviderProfileId()
  const rawProjectActiveId = getRawProjectActiveProviderProfileId()
  const globalActiveId = getGlobalActiveProviderProfileId()
  const activeId = getActiveProviderProfile()?.id
  // Two independent dimensions:
  //   1. how was the *active* profile resolved (override / global / fallback)
  //   2. what dangling pointers exist (override or global pointing to a
  //      missing profile), which we surface as warnings appended after.
  let resolutionSource: string
  if (projectActiveId && projectActiveId === activeId) {
    resolutionSource =
      globalActiveId === projectActiveId
        ? 'project override (same as global default)'
        : 'project override'
  } else if (globalActiveId && globalActiveId === activeId) {
    resolutionSource = 'global default'
  } else {
    resolutionSource = 'first available profile'
  }
  const danglingNotes: string[] = []
  if (rawProjectActiveId && !projectActiveId) {
    danglingNotes.push(
      `project override "${rawProjectActiveId}" missing, falling back`,
    )
  }
  // Only flag the global as dangling when it actually points to a non-existent
  // profile — a healthy global that's simply *shadowed* by a valid project
  // override is not dangling.
  if (globalActiveId) {
    const profileExists = getProviderProfiles().some(
      p => p.id === globalActiveId,
    )
    if (!profileExists) {
      danglingNotes.push(
        `global default "${globalActiveId}" missing, falling back`,
      )
    }
  }
  if (danglingNotes.length > 0) {
    resolutionSource += ` (${danglingNotes.join('; ')})`
  }

  lines.push(`Active profile transport: ${profile.transport}`)
  lines.push(`Base URL: ${redactUrlForDisplay(profile.baseUrl)}`)
  // When a project override has its own `/model` choice, surface it alongside
  // the profile's default so the user understands which one this session uses.
  const projectModel = hasProjectProviderProfileOverride()
    ? getCurrentProjectConfig().activeModelForProject
    : undefined
  // CSV-aware comparison: a profile's `model` field can be a list like
  // "glm-4.7, glm-4.7-flash". `projectModel === profile.model` would falsely
  // flag a project override that just picked one of the listed options.
  const profileModelOptions = parseModelList(profile.model)
  // Trim both sides — a stored override like " glm-4.7 " (legacy whitespace
  // from older versions) shouldn't false-flag against a profile listing
  // "glm-4.7" cleanly.
  const projectModelTrimmed = projectModel?.trim()
  const projectModelMatchesProfile =
    projectModelTrimmed !== undefined &&
    projectModelTrimmed !== '' &&
    (projectModelTrimmed === profile.model.trim() ||
      profileModelOptions.includes(projectModelTrimmed))
  if (projectModel && !projectModelMatchesProfile) {
    lines.push(`Model: ${projectModel} (project override; profile default ${profile.model})`)
  } else {
    lines.push(`Model: ${projectModel ?? profile.model}`)
  }
  lines.push(`Resolved from: ${resolutionSource}`)

  switch (profile.transport) {
    case 'anthropic': {
      const apiKey = profile.apiKey?.trim()
      results.push(
        apiKey
          ? pass('Anthropic API key', 'set via profile')
          : pass('Anthropic API key', 'not set — relying on OAuth/login'),
      )
      const probe = await probeReachability(`${profile.baseUrl.replace(/\/+$/, '')}/v1/models`, {
        headers: apiKey
          ? {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            }
          : undefined,
      })
      results.push(
        probe.ok
          ? pass('Reachability', 'Anthropic API responded.')
          : fail(
              'Reachability',
              probe.status
                ? `Unexpected status ${probe.status} from Anthropic API.`
                : `Could not reach Anthropic API: ${probe.error}`,
            ),
      )
      break
    }
    case 'gemini': {
      const credential = await resolveGeminiCredential(process.env)
      results.push(
        credential.kind === 'none'
          ? fail('Gemini auth', 'No API key, access token, or ADC credentials available.')
          : pass('Gemini auth', `kind=${credential.kind}`),
      )
      results.push(...(await checkOpenAICompat(profile.baseUrl, profile.apiKey)))
      break
    }
    case 'mistral': {
      results.push(...(await checkOpenAICompat(profile.baseUrl, profile.apiKey)))
      break
    }
    case 'github_copilot': {
      const token = profile.extras?.githubToken ?? profile.apiKey
      results.push(
        token
          ? pass('GitHub Copilot token', 'present in profile')
          : fail('GitHub Copilot token', 'missing — re-run /provider GitHub Copilot flow.'),
      )
      results.push(...(await checkOpenAICompat(profile.baseUrl, token)))
      break
    }
    case 'codex_responses': {
      const request = resolveProviderRequest({ model: profile.model, baseUrl: profile.baseUrl })
      results.push(
        pass(
          'Codex transport',
          `model=${request.requestedModel} resolved=${request.resolvedModel}`,
        ),
      )
      results.push(...(await checkOpenAICompat(profile.baseUrl, profile.apiKey)))
      break
    }
    case 'openai_compat': {
      const baseUrl = profile.baseUrl.toLowerCase()
      if (baseUrl.includes('localhost:11434') || baseUrl.includes('localhost:11435')) {
        results.push(...(await checkOllamaProfile(profile.baseUrl, profile.model)))
      } else if (isXaiOAuthBaseUrl(profile.baseUrl)) {
        results.push(...(await checkXaiOAuthProfile(profile.baseUrl)))
      } else if (isKimiCodeBaseUrl(profile.baseUrl)) {
        results.push(...(await checkKimiOAuthProfile(profile.baseUrl)))
      } else {
        results.push(...(await checkOpenAICompat(profile.baseUrl, profile.apiKey)))
      }
      break
    }
    case 'bedrock':
    case 'vertex':
    case 'foundry': {
      results.push(
        pass(
          'Cloud transport',
          'reachability is governed by AWS/GCP/Azure SDK chains. No probe attempted.',
        ),
      )
      break
    }
    default:
      results.push(fail('Transport', `Unknown transport "${profile.transport}".`))
  }

  // Auto-mode capability: Claude models pass by canonical name; anything else
  // needs the forced tool-choice probe (classifierProbe.ts). Doctor always
  // re-probes (overwrites the cache) so it's the manual refresh path.
  const mainModel = getMainLoopModel()
  if (modelSupportsAutoMode(mainModel)) {
    results.push(
      pass(
        'Auto mode classifier',
        `${mainModel} is gated by model name — no probe needed.`,
      ),
    )
  } else {
    const key = getClassifierProbeKey({
      provider: profile.transport,
      baseUrl: profile.baseUrl,
      model: mainModel,
    })
    const probe = await probeClassifierCapability({ key, model: mainModel })
    results.push(
      probe.ok
        ? pass(
            'Auto mode classifier probe',
            'forced tool-choice honored — auto mode enabled for this model.',
          )
        : fail(
            'Auto mode classifier probe',
            `${probe.detail ?? 'probe failed'} — auto mode stays unavailable for this model.`,
          ),
    )
  }

  for (const result of results) {
    const marker = result.ok ? 'OK' : 'FAIL'
    lines.push(`[${marker}] ${result.label}${result.detail ? ` — ${result.detail}` : ''}`)
  }

  const failed = results.filter(r => !r.ok)
  lines.push('')
  lines.push(failed.length === 0 ? 'All checks passed.' : `${failed.length} check(s) failed.`)
  return lines.join('\n')
}
