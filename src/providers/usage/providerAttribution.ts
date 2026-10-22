/**
 * Which registered provider a project's spend belongs to.
 *
 * The cost tracker records spend per provider profile (`providerUsage`), but
 * everything recorded before it did only knows its model. Whatever part of a
 * model's total no provider claims is attributed here by name and kept apart
 * as `estimated` — it never mixes into the exact figures.
 */
import type { APIProvider } from 'src/providers/model/providers.js'
import type {
  CostStateModelUsage,
  CostStateProviderUsage,
} from 'src/shared/types/logs.js'
import {
  addModelUsage,
  addModelUsageTo,
  emptyModelUsage,
  remainingModelUsage,
} from 'src/providers/usage/modelUsage.js'

/** A registered profile, as attribution needs to see it. */
export type AttributionProfile = {
  id: string
  name: string
  kind: APIProvider
  baseUrl: string
  /** The profile's configured models plus the ones discovered on its endpoint. */
  models: readonly string[]
}

type ProviderUsageGroupKind = 'profile' | 'removed' | 'env' | 'others'

export type ProviderUsageGroup = {
  key: string
  name: string
  kind: ProviderUsageGroupKind
  active: boolean
  exact: Record<string, CostStateModelUsage>
  estimated: Record<string, CostStateModelUsage>
  totalCostUSD: number
}

/** The bucket for estimated spend no profile can be named for. */
export const OTHERS_KEY = 'others'

/** The key a spend made without any provider profile is recorded under. */
export const ENV_KEY_PREFIX = 'env:'

const VENDOR_PREFIXED_RE = /^~?[\w.-]+\/.+/
const ANTHROPIC_FAMILY_RE = /^claude-/i
const OPENAI_FAMILY_RE = /^(?:gpt-|codex|o\d)/i
const OPENROUTER_HOST_RE = /openrouter\.ai/i

/**
 * A model family's own backend. It outranks a listing elsewhere: gateways
 * list models they resell (OpenCode GO lists `claude-haiku-5-5`), and before
 * per-provider tracking the family's own backend is the likelier spender.
 */
const FAMILY_OWNERS: ReadonlyArray<{ test: RegExp; kind: APIProvider }> = [
  { test: ANTHROPIC_FAMILY_RE, kind: 'firstParty' },
  { test: OPENAI_FAMILY_RE, kind: 'codex' },
]

function pick(
  candidates: readonly AttributionProfile[],
  model: string,
): AttributionProfile | undefined {
  return candidates.find(p => p.models.includes(model)) ?? candidates[0]
}

/**
 * The id of the profile a model's unrecorded spend is credited to, or
 * undefined when no profile can be named for it. In order: a vendor-prefixed
 * id (`openai/gpt-5-mini`) goes to the profile listing it, else to an
 * OpenRouter profile; a model family goes to its own backend; any other id
 * goes to the one profile listing it.
 */
export function attributeModel(
  model: string,
  profiles: readonly AttributionProfile[],
): string | undefined {
  const listing = profiles.filter(p => p.models.includes(model))

  if (VENDOR_PREFIXED_RE.test(model)) {
    if (listing.length > 0) return listing[0]!.id
    return profiles.find(p => OPENROUTER_HOST_RE.test(p.baseUrl))?.id
  }

  const family = FAMILY_OWNERS.find(f => f.test.test(model))
  if (family) {
    const owner = pick(
      profiles.filter(p => p.kind === family.kind),
      model,
    )
    if (owner) return owner.id
  }

  return listing.length === 1 ? listing[0]!.id : undefined
}

function sumCost(usage: Record<string, CostStateModelUsage>): number {
  let total = 0
  for (const u of Object.values(usage)) total += u.costUSD
  return total
}

/**
 * One group per registered profile (in config order, even with no spend),
 * then any recorded provider that is no longer registered, then the
 * estimated spend nobody can be named for — only when there is some.
 */
export function groupUsageByProvider(input: {
  modelUsage: Readonly<Record<string, CostStateModelUsage>>
  providerUsage: Readonly<Record<string, CostStateProviderUsage>>
  profiles: readonly AttributionProfile[]
  activeKey?: string
}): ProviderUsageGroup[] {
  const groups = new Map<string, ProviderUsageGroup>()
  const make = (
    key: string,
    name: string,
    kind: ProviderUsageGroupKind,
  ): ProviderUsageGroup => {
    const group: ProviderUsageGroup = {
      key,
      name,
      kind,
      active: key === input.activeKey,
      exact: {},
      estimated: {},
      totalCostUSD: 0,
    }
    groups.set(key, group)
    return group
  }
  for (const profile of input.profiles) make(profile.id, profile.name, 'profile')

  const claimed: Record<string, CostStateModelUsage> = {}
  for (const [key, bucket] of Object.entries(input.providerUsage)) {
    const group =
      groups.get(key) ??
      make(
        key,
        bucket.name,
        key.startsWith(ENV_KEY_PREFIX) ? 'env' : 'removed',
      )
    for (const [model, usage] of Object.entries(bucket.models)) {
      addModelUsageTo(group.exact, model, usage)
      addModelUsageTo(claimed, model, usage)
    }
  }

  let others: ProviderUsageGroup | undefined
  for (const [model, total] of Object.entries(input.modelUsage)) {
    const rest = remainingModelUsage(total, claimed[model] ?? emptyModelUsage())
    if (!rest) continue
    const id = attributeModel(model, input.profiles)
    const group =
      (id !== undefined ? groups.get(id) : undefined) ??
      (others ??= make(OTHERS_KEY, 'Others', 'others'))
    addModelUsage((group.estimated[model] ??= emptyModelUsage()), rest)
  }

  const ordered = [...groups.values()].filter(g => g.kind !== 'others')
  if (others) ordered.push(others)
  for (const group of ordered) {
    group.totalCostUSD = sumCost(group.exact) + sumCost(group.estimated)
  }
  return ordered
}
