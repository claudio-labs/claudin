/**
 * What a provider's limits look like once read, the same shape for every
 * provider: the fetchers build it (codexUsage, minimaxUsage, providerLimits)
 * and /usage draws it. A leaf on purpose, so a fetcher can build rows
 * without importing the table that imports the fetchers.
 */

/** One line of a provider's limits. */
export type UsageLimitRow =
  | {
      kind: 'window'
      label: string
      usedPercent: number
      /** ISO 8601. */
      resetsAt?: string
      extraSubtext?: string
    }
  | {
      kind: 'text'
      label: string
      value: string
    }

export type ProviderLimits = {
  plan?: string
  rows: UsageLimitRow[]
  /** What to say instead of rows, when the provider explained their absence. */
  message?: string
}
