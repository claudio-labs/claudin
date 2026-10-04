import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'

export type PermissionQueueOps = {
  push(item: ToolUseConfirm): void
  remove(toolUseID: string): void
  update(toolUseID: string, patch: Partial<ToolUseConfirm>): void
}

type QueueSetter = React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>

export function createPermissionQueueOps(setQueue: QueueSetter): PermissionQueueOps {
  return {
    push: item => setQueue(items => [...items, item]),
    remove: toolUseID => setQueue(items => items.filter(item => item.toolUseID !== toolUseID)),
    update: (toolUseID, patch) =>
      setQueue(items => items.map(item => (item.toolUseID === toolUseID ? { ...item, ...patch } : item))),
  }
}
