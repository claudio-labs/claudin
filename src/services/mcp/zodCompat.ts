import type { z } from 'zod/v4'
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'

/**
 * The MCP SDK declares `peerDependencies: zod "^3.25 || ^4.0"` and its internal
 * `AnyObjectSchema` type is a union of v3 (`z3.AnyZodObject`) and v4
 * (`z4.$ZodObject`) shapes. Claudio is on zod v4, but TypeScript's generic
 * inference can't always reconcile our `z.ZodObject<...>` instances with the
 * SDK union — concrete object schemas have brand types (`$strip`, `$loose`)
 * that don't structurally match `z4.$ZodObject` in every position.
 *
 * Runtime compatibility is guaranteed by the SDK's peerDep range. This helper
 * isolates the single type-level coercion needed for `setNotificationHandler`
 * and similar APIs, so we never sprinkle `as any` casts across the codebase.
 *
 * Remove this helper once the MCP SDK ships types that infer zod v4 objects
 * directly without the union widening.
 */
export function asMcpSchema<T extends z.ZodTypeAny>(schema: T): AnyObjectSchema {
  return schema as unknown as AnyObjectSchema
}
