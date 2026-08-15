import { z } from 'zod/v4'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import type { SettingsJson } from 'src/platform/settings/types.js'

/**
 * Schema for the remotely managed settings response.
 * Note: Uses permissive z.record() instead of SettingsSchema to avoid circular dependency.
 * Full validation is performed in index.ts after parsing using SettingsSchema.safeParse().
 */
export const RemoteManagedSettingsResponseSchema = lazySchema(() =>
  z.object({
    uuid: z.string(), // Settings UUID
    checksum: z.string(),
    settings: z.record(z.string(), z.unknown()) as z.ZodType<SettingsJson>,
  }),
)


/**
 * Result of fetching remotely managed settings
 */
export type RemoteManagedSettingsFetchResult = {
  success: boolean
  settings?: SettingsJson | null // null means 304 Not Modified (cache is valid)
  checksum?: string
  error?: string
  skipRetry?: boolean // If true, don't retry on failure (e.g., auth errors)
}
