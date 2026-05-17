import type { UUID } from 'crypto'

// Track message UUIDs received during the current session runtime.
// Set provides O(1) membership; the parallel FIFO array gives deterministic
// eviction of the oldest entries when the cap is reached.
const MAX_RECEIVED_UUIDS = 10_000
const receivedMessageUuids = new Set<UUID>()
const receivedMessageUuidsOrder: UUID[] = []

export function hasReceivedMessageUuid(uuid: UUID): boolean {
  return receivedMessageUuids.has(uuid)
}

export function trackReceivedMessageUuid(uuid: UUID): boolean {
  if (receivedMessageUuids.has(uuid)) {
    return false // duplicate
  }
  receivedMessageUuids.add(uuid)
  receivedMessageUuidsOrder.push(uuid)
  // Evict oldest entries when at capacity
  if (receivedMessageUuidsOrder.length > MAX_RECEIVED_UUIDS) {
    const toEvict = receivedMessageUuidsOrder.splice(
      0,
      receivedMessageUuidsOrder.length - MAX_RECEIVED_UUIDS,
    )
    for (const old of toEvict) {
      receivedMessageUuids.delete(old)
    }
  }
  return true // new UUID
}

/** @internal Exported for testing — wipes the dedupe set and FIFO. */
export function __resetForTests(): void {
  receivedMessageUuids.clear()
  receivedMessageUuidsOrder.length = 0
}
