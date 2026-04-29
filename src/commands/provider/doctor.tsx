import { tryGetActiveProvider } from '../../services/api/activeProvider.js'
import { resolveProviderRequest } from '../../services/api/providerConfig.js'
import {
  type OllamaGenerationReadiness,
  probeOllamaGenerationReadiness,
} from '../../utils/providerDiscovery.js'
import { resolveGeminiCredential } from '../../utils/geminiAuth.js'
import { redactUrlForDisplay } from '../../utils/urlRedaction.js'

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
    probeModel: model,
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

  lines.push(`Active profile transport: ${profile.transport}`)
  lines.push(`Base URL: ${redactUrlForDisplay(profile.baseUrl)}`)
  lines.push(`Model: ${profile.model}`)

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

  for (const result of results) {
    const marker = result.ok ? 'OK' : 'FAIL'
    lines.push(`[${marker}] ${result.label}${result.detail ? ` — ${result.detail}` : ''}`)
  }

  const failed = results.filter(r => !r.ok)
  lines.push('')
  lines.push(failed.length === 0 ? 'All checks passed.' : `${failed.length} check(s) failed.`)
  return lines.join('\n')
}
