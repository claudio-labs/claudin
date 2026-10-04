import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'

/** An answer given somewhere else: by the swarm leader, or by the web app over the bridge. */
export type RemoteAnswer =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions: PermissionUpdate[] }
  | { behavior: 'deny'; message?: string }
