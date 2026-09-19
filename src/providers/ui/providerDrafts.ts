import type { ProviderProfile } from 'src/platform/config/config.js'
import { parseModelList } from 'src/providers/presets/providerModels.js'
import {
  getProviderPresetDefaults,
  type ProviderPreset,
} from 'src/providers/presets/providerProfiles.js'
import type {
  CloudExtrasDraft,
  ProviderDraft,
} from 'src/providers/ui/ProviderManager.types.js'

export function toDraft(profile: ProviderProfile): ProviderDraft {
  return {
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey ?? '',
  }
}

export function presetToDraft(preset: ProviderPreset): ProviderDraft {
  const defaults = getProviderPresetDefaults(preset)
  return {
    name: defaults.name,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    apiKey: defaults.apiKey ?? '',
  }
}

export function parseCustomHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key && value) {
      out[key] = value
    }
  }
  return out
}

export function customHeadersToText(
  headers: Record<string, string> | undefined,
): string {
  if (!headers) return ''
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

export function buildExtrasFromDrafts(
  cloudExtras: CloudExtrasDraft,
  customHeadersText: string,
): ProviderProfile['extras'] | undefined {
  const extras: NonNullable<ProviderProfile['extras']> = {}
  const awsRegion = cloudExtras.awsRegion?.trim()
  if (awsRegion) extras.awsRegion = awsRegion
  const gcpProject = cloudExtras.gcpProject?.trim()
  if (gcpProject) extras.gcpProject = gcpProject
  const gcpRegion = cloudExtras.gcpRegion?.trim()
  if (gcpRegion) extras.gcpRegion = gcpRegion
  const azureResource = cloudExtras.azureResource?.trim()
  if (azureResource) extras.azureResource = azureResource
  const headers = parseCustomHeaders(customHeadersText)
  if (Object.keys(headers).length > 0) {
    extras.customHeaders = headers
  }
  return Object.keys(extras).length > 0 ? extras : undefined
}

export function profileSummary(profile: ProviderProfile, isActive: boolean): string {
  const activeSuffix = isActive ? ' (active)' : ''
  const keyInfo = profile.apiKey ? 'key set' : 'no key'
  const providerKind =
    profile.provider === 'anthropic' ? 'anthropic' : 'openai-compatible'
  const models = parseModelList(profile.model)
  const modelDisplay =
    models.length <= 3
      ? models.join(', ')
      : `${models[0]}, ${models[1]} + ${models.length - 2} more`
  return `${providerKind} · ${profile.baseUrl} · ${modelDisplay} · ${keyInfo}${activeSuffix}`
}
