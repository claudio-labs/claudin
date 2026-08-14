import { randomUUID } from 'crypto'
import { LRUCache } from 'lru-cache'
import { logForDebugging } from 'src/utils/debug.js'
import { toError } from 'src/utils/errors.js'
import { logError } from 'src/utils/log.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { DiagnosticFile } from 'src/services/diagnosticTracking.js'

/**
 * Pending LSP diagnostic notification
 */
export type PendingLSPDiagnostic = {
  /** Server that sent the diagnostic */
  serverName: string
  /** Diagnostic files */
  files: DiagnosticFile[]
  /** When diagnostic was received */
  timestamp: number
  /** Whether attachment was already sent to conversation */
  attachmentSent: boolean
}

/**
 * LSP Diagnostic Registry
 *
 * Stores LSP diagnostics received asynchronously from LSP servers via
 * textDocument/publishDiagnostics notifications. Follows the same pattern
 * as AsyncHookRegistry for consistent async attachment delivery.
 *
 * Pattern:
 * 1. LSP server sends publishDiagnostics notification
 * 2. registerPendingLSPDiagnostic() stores diagnostic
 * 3. checkForLSPDiagnostics() retrieves pending diagnostics
 * 4. getLSPDiagnosticAttachments() converts to Attachment[]
 * 5. getAttachments() delivers to conversation automatically
 *
 * Similar to AsyncHookRegistry but simpler since diagnostics arrive
 * synchronously (no need to accumulate output over time).
 */

// Volume limiting constants
const MAX_DIAGNOSTICS_PER_FILE = 10
const MAX_TOTAL_DIAGNOSTICS = 30

// Max files to track for deduplication - prevents unbounded memory growth
const MAX_DELIVERED_FILES = 500

// Global registry state
const pendingDiagnostics = new Map<string, PendingLSPDiagnostic>()

// Cross-turn deduplication: tracks diagnostics that have been delivered
// Maps file URI to a set of diagnostic keys (hash of message+severity+range)
// Using LRUCache to prevent unbounded growth in long sessions
const deliveredDiagnostics = new LRUCache<string, Set<string>>({
  max: MAX_DELIVERED_FILES,
})

// Per-edit waiters: maps file URI -> set of resolve callbacks for awaitDiagnosticsForFile.
// Notified synchronously inside registerPendingLSPDiagnostic. Cleaned up on resolve/timeout.
const fileWaiters = new Map<string, Set<(files: DiagnosticFile[]) => void>>()

/**
 * Register LSP diagnostics received from a server.
 * These will be delivered as attachments in the next query.
 *
 * @param serverName - Name of LSP server that sent diagnostics
 * @param files - Diagnostic files to deliver
 */
export function registerPendingLSPDiagnostic({
  serverName,
  files,
}: {
  serverName: string
  files: DiagnosticFile[]
}): void {
  // Use UUID for guaranteed uniqueness (handles rapid registrations)
  const diagnosticId = randomUUID()

  logForDebugging(
    `LSP Diagnostics: Registering ${files.length} diagnostic file(s) from ${serverName} (ID: ${diagnosticId})`,
  )

  pendingDiagnostics.set(diagnosticId, {
    serverName,
    files,
    timestamp: Date.now(),
    attachmentSent: false,
  })

  // Notify any per-edit waiters watching for these file URIs. Notification is
  // synchronous so awaitDiagnosticsForFile resolves before the LSP handler
  // returns, but we copy + delete the waiter set first to avoid re-entry
  // hazards if a callback synchronously triggers another registration.
  for (const file of files) {
    const waiters = fileWaiters.get(file.uri)
    if (!waiters || waiters.size === 0) continue
    fileWaiters.delete(file.uri)
    for (const cb of waiters) {
      try {
        cb([file])
      } catch (error: unknown) {
        const err = toError(error)
        logError(
          new Error(
            `LSP Diagnostics: waiter callback for ${file.uri} threw: ${err.message}`,
          ),
        )
      }
    }
  }
}

/**
 * Wait for diagnostics to be published for a specific file URI.
 *
 * Used by the per-edit injection path (FileEditTool/FileWriteTool): after a
 * write, the caller awaits up to `timeoutMs` for the LSP server to publish
 * diagnostics for that file. Returns the matching files immediately if they
 * were already in the pending registry (fast-path), otherwise registers a
 * one-shot waiter and races against a timeout.
 *
 * @param fileUri - File URI to watch (must match the URI the server publishes)
 * @param timeoutMs - Maximum time to wait before resolving with null
 * @returns Files for the URI on resolve, or null on timeout
 */
export function awaitDiagnosticsForFile(
  fileUri: string,
  timeoutMs: number,
): Promise<DiagnosticFile[] | null> {
  // Fast-path: if a publishDiagnostics for this URI is already pending, return
  // it immediately. We do NOT mutate pendingDiagnostics here — the turn-level
  // checkForLSPDiagnostics is the canonical drainer. Per-edit injection
  // populates the deliveredDiagnostics LRU instead, which dedups the next pull.
  for (const pending of pendingDiagnostics.values()) {
    const match = pending.files.filter(f => f.uri === fileUri)
    if (match.length > 0) {
      return Promise.resolve(match)
    }
  }

  // Slow-path: register a waiter, race against setTimeout. Cleanup is
  // idempotent — whichever side fires first wins, the other no-ops.
  return new Promise<DiagnosticFile[] | null>(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      const set = fileWaiters.get(fileUri)
      if (set) {
        set.delete(onPublish)
        if (set.size === 0) fileWaiters.delete(fileUri)
      }
    }

    const onPublish = (files: DiagnosticFile[]) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(files)
    }

    let waiters = fileWaiters.get(fileUri)
    if (!waiters) {
      waiters = new Set()
      fileWaiters.set(fileUri, waiters)
    }
    waiters.add(onPublish)

    timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve(null)
    }, timeoutMs)
  })
}

/**
 * Mark diagnostics as delivered in the cross-turn LRU dedup cache.
 *
 * Called by the per-edit injection path after `awaitDiagnosticsForFile`
 * returns matches: this populates `deliveredDiagnostics` with the same
 * content-hash keys that `checkForLSPDiagnostics` would generate, so the
 * next turn-level pull skips them automatically.
 *
 * @param files - Files whose diagnostics were just delivered per-edit
 */
export function markDiagnosticsAsDelivered(files: DiagnosticFile[]): void {
  for (const file of files) {
    if (!deliveredDiagnostics.has(file.uri)) {
      deliveredDiagnostics.set(file.uri, new Set())
    }
    const delivered = deliveredDiagnostics.get(file.uri)!
    for (const diag of file.diagnostics) {
      try {
        delivered.add(createDiagnosticKey(diag))
      } catch (error: unknown) {
        const err = toError(error)
        const truncatedMessage =
          diag.message?.substring(0, 100) || '<no message>'
        logError(
          new Error(
            `Failed to mark per-edit diagnostic delivered in ${file.uri}: ${err.message}. ` +
              `Diagnostic message: ${truncatedMessage}`,
          ),
        )
      }
    }
  }
}

/**
 * Filter out diagnostics already present in the cross-turn delivered LRU.
 *
 * Used by the late-injection tail-wait, which reads pending diagnostics
 * directly via `peekPendingDiagnosticsForFile` and therefore bypasses the
 * dedup baked into `checkForLSPDiagnostics`. Without this filter, a per-edit
 * injection inside the same turn would be re-surfaced by tail-wait.
 *
 * Returns a new array of DiagnosticFile with delivered entries removed; files
 * with no surviving diagnostics are dropped.
 */
export function filterUndeliveredDiagnostics(
  files: DiagnosticFile[],
): DiagnosticFile[] {
  const result: DiagnosticFile[] = []
  for (const file of files) {
    const delivered = deliveredDiagnostics.get(file.uri)
    if (!delivered || delivered.size === 0) {
      if (file.diagnostics.length > 0) result.push(file)
      continue
    }
    const surviving = []
    for (const diag of file.diagnostics) {
      try {
        if (!delivered.has(createDiagnosticKey(diag))) surviving.push(diag)
      } catch {
        // On key-gen failure, include the diagnostic — better to over-report
        // than to drop it silently. Mirrors deduplicateDiagnosticFiles.
        surviving.push(diag)
      }
    }
    if (surviving.length > 0) result.push({ uri: file.uri, diagnostics: surviving })
  }
  return result
}

/**
 * Test-only: clear the per-edit waiter map. Production code never needs this —
 * waiters self-clean on resolve/timeout. Tests may want to assert post-state.
 */
export function _resetFileWaitersForTesting(): void {
  fileWaiters.clear()
}

/**
 * Test-only: inspect the deliveredDiagnostics LRU size. Used by
 * cacheBoundsInvariants.test.ts to assert the cap (MAX_DELIVERED_FILES)
 * is respected after many distinct file URIs.
 */
export function _getDeliveredDiagnosticsCountForTesting(): number {
  return deliveredDiagnostics.size
}

/** Test-only: clear the deliveredDiagnostics LRU. */
export function _resetDeliveredDiagnosticsForTesting(): void {
  deliveredDiagnostics.clear()
}

/**
 * Test-only: inspect waiter map size for a URI (or all). Returns 0 when empty.
 */
export function _getFileWaiterCountForTesting(fileUri?: string): number {
  if (fileUri === undefined) {
    let total = 0
    for (const set of fileWaiters.values()) total += set.size
    return total
  }
  return fileWaiters.get(fileUri)?.size ?? 0
}

/**
 * Maps severity string to numeric value for sorting.
 * Error=1, Warning=2, Info=3, Hint=4
 */
function severityToNumber(severity: string | undefined): number {
  switch (severity) {
    case 'Error':
      return 1
    case 'Warning':
      return 2
    case 'Info':
      return 3
    case 'Hint':
      return 4
    default:
      return 4
  }
}

/**
 * Creates a unique key for a diagnostic based on its content.
 * Used for both within-batch and cross-turn deduplication.
 */
function createDiagnosticKey(diag: {
  message: string
  severity?: string
  range?: unknown
  source?: string
  code?: unknown
}): string {
  return jsonStringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source || null,
    code: diag.code || null,
  })
}

/**
 * Deduplicates diagnostics by file URI and diagnostic content.
 * Also filters out diagnostics that were already delivered in previous turns.
 * Two diagnostics are considered duplicates if they have the same:
 * - File URI
 * - Range (start/end line and character)
 * - Message
 * - Severity
 * - Source and code (if present)
 */
function deduplicateDiagnosticFiles(
  allFiles: DiagnosticFile[],
): DiagnosticFile[] {
  // Group diagnostics by file URI
  const fileMap = new Map<string, Set<string>>()
  const dedupedFiles: DiagnosticFile[] = []

  for (const file of allFiles) {
    if (!fileMap.has(file.uri)) {
      fileMap.set(file.uri, new Set())
      dedupedFiles.push({ uri: file.uri, diagnostics: [] })
    }

    const seenDiagnostics = fileMap.get(file.uri)!
    const dedupedFile = dedupedFiles.find(f => f.uri === file.uri)!

    // Get previously delivered diagnostics for this file (for cross-turn dedup)
    const previouslyDelivered = deliveredDiagnostics.get(file.uri) || new Set()

    for (const diag of file.diagnostics) {
      try {
        const key = createDiagnosticKey(diag)

        // Skip if already seen in this batch OR already delivered in previous turns
        if (seenDiagnostics.has(key) || previouslyDelivered.has(key)) {
          continue
        }

        seenDiagnostics.add(key)
        dedupedFile.diagnostics.push(diag)
      } catch (error: unknown) {
        const err = toError(error)
        const truncatedMessage =
          diag.message?.substring(0, 100) || '<no message>'
        logError(
          new Error(
            `Failed to deduplicate diagnostic in ${file.uri}: ${err.message}. ` +
              `Diagnostic message: ${truncatedMessage}`,
          ),
        )
        // Include the diagnostic anyway to avoid losing information
        dedupedFile.diagnostics.push(diag)
      }
    }
  }

  // Filter out files with no diagnostics after deduplication
  return dedupedFiles.filter(f => f.diagnostics.length > 0)
}

/**
 * Get all pending LSP diagnostics that haven't been delivered yet.
 * Deduplicates diagnostics to prevent sending the same diagnostic multiple times.
 * Marks diagnostics as sent to prevent duplicate delivery.
 *
 * @returns Array of pending diagnostics ready for delivery (deduplicated)
 */
export function checkForLSPDiagnostics(): Array<{
  serverName: string
  files: DiagnosticFile[]
}> {
  logForDebugging(
    `LSP Diagnostics: Checking registry - ${pendingDiagnostics.size} pending`,
  )

  // Collect all diagnostic files from all pending notifications
  const allFiles: DiagnosticFile[] = []
  const serverNames = new Set<string>()
  const diagnosticsToMark: PendingLSPDiagnostic[] = []

  for (const diagnostic of pendingDiagnostics.values()) {
    if (!diagnostic.attachmentSent) {
      allFiles.push(...diagnostic.files)
      serverNames.add(diagnostic.serverName)
      diagnosticsToMark.push(diagnostic)
    }
  }

  if (allFiles.length === 0) {
    return []
  }

  // Deduplicate diagnostics across all files
  let dedupedFiles: DiagnosticFile[]
  try {
    dedupedFiles = deduplicateDiagnosticFiles(allFiles)
  } catch (error: unknown) {
    const err = toError(error)
    logError(new Error(`Failed to deduplicate LSP diagnostics: ${err.message}`))
    // Fall back to undedup'd files to avoid losing diagnostics
    dedupedFiles = allFiles
  }

  // Only mark as sent AFTER successful deduplication, then delete from map.
  // Entries are tracked in deliveredDiagnostics LRU for dedup, so we don't
  // need to keep them in pendingDiagnostics after delivery.
  for (const diagnostic of diagnosticsToMark) {
    diagnostic.attachmentSent = true
  }
  for (const [id, diagnostic] of pendingDiagnostics) {
    if (diagnostic.attachmentSent) {
      pendingDiagnostics.delete(id)
    }
  }

  const originalCount = allFiles.reduce(
    (sum, f) => sum + f.diagnostics.length,
    0,
  )
  const dedupedCount = dedupedFiles.reduce(
    (sum, f) => sum + f.diagnostics.length,
    0,
  )

  if (originalCount > dedupedCount) {
    logForDebugging(
      `LSP Diagnostics: Deduplication removed ${originalCount - dedupedCount} duplicate diagnostic(s)`,
    )
  }

  // Apply volume limiting: cap per file and total
  let totalDiagnostics = 0
  let truncatedCount = 0
  for (const file of dedupedFiles) {
    // Sort by severity (Error=1 < Warning=2 < Info=3 < Hint=4) to prioritize errors
    file.diagnostics.sort(
      (a, b) => severityToNumber(a.severity) - severityToNumber(b.severity),
    )

    // Cap per file
    if (file.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
      truncatedCount += file.diagnostics.length - MAX_DIAGNOSTICS_PER_FILE
      file.diagnostics = file.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE)
    }

    // Cap total
    const remainingCapacity = MAX_TOTAL_DIAGNOSTICS - totalDiagnostics
    if (file.diagnostics.length > remainingCapacity) {
      truncatedCount += file.diagnostics.length - remainingCapacity
      file.diagnostics = file.diagnostics.slice(0, remainingCapacity)
    }

    totalDiagnostics += file.diagnostics.length
  }

  // Filter out files that ended up with no diagnostics after limiting
  dedupedFiles = dedupedFiles.filter(f => f.diagnostics.length > 0)

  if (truncatedCount > 0) {
    logForDebugging(
      `LSP Diagnostics: Volume limiting removed ${truncatedCount} diagnostic(s) (max ${MAX_DIAGNOSTICS_PER_FILE}/file, ${MAX_TOTAL_DIAGNOSTICS} total)`,
    )
  }

  // Track delivered diagnostics for cross-turn deduplication
  for (const file of dedupedFiles) {
    if (!deliveredDiagnostics.has(file.uri)) {
      deliveredDiagnostics.set(file.uri, new Set())
    }
    const delivered = deliveredDiagnostics.get(file.uri)!
    for (const diag of file.diagnostics) {
      try {
        delivered.add(createDiagnosticKey(diag))
      } catch (error: unknown) {
        // Log but continue - failure to track shouldn't prevent delivery
        const err = toError(error)
        const truncatedMessage =
          diag.message?.substring(0, 100) || '<no message>'
        logError(
          new Error(
            `Failed to track delivered diagnostic in ${file.uri}: ${err.message}. ` +
              `Diagnostic message: ${truncatedMessage}`,
          ),
        )
      }
    }
  }

  const finalCount = dedupedFiles.reduce(
    (sum, f) => sum + f.diagnostics.length,
    0,
  )

  // Return empty if no diagnostics to deliver (all filtered by deduplication)
  if (finalCount === 0) {
    logForDebugging(
      `LSP Diagnostics: No new diagnostics to deliver (all filtered by deduplication)`,
    )
    return []
  }

  logForDebugging(
    `LSP Diagnostics: Delivering ${dedupedFiles.length} file(s) with ${finalCount} diagnostic(s) from ${serverNames.size} server(s)`,
  )

  // Return single result with all deduplicated diagnostics
  return [
    {
      serverName: Array.from(serverNames).join(', '),
      files: dedupedFiles,
    },
  ]
}

/**
 * Clear all pending diagnostics.
 * Used during cleanup/shutdown or for testing.
 * Note: Does NOT clear deliveredDiagnostics - that's for cross-turn deduplication
 * and should only be cleared when files are edited or on session reset.
 */
export function clearAllLSPDiagnostics(): void {
  logForDebugging(
    `LSP Diagnostics: Clearing ${pendingDiagnostics.size} pending diagnostic(s)`,
  )
  pendingDiagnostics.clear()
}

/**
 * Reset all diagnostic state including cross-turn tracking.
 * Used on session reset or for testing.
 */
export function resetAllLSPDiagnosticState(): void {
  logForDebugging(
    `LSP Diagnostics: Resetting all state (${pendingDiagnostics.size} pending, ${deliveredDiagnostics.size} files tracked)`,
  )
  pendingDiagnostics.clear()
  deliveredDiagnostics.clear()
  fileWaiters.clear()
}

/**
 * Clear delivered diagnostics for a specific file.
 * Should be called when a file is edited so that new diagnostics for that file
 * will be shown even if they match previously delivered ones.
 *
 * @param fileUri - URI of the file that was edited
 */
export function clearDeliveredDiagnosticsForFile(fileUri: string): void {
  if (deliveredDiagnostics.has(fileUri)) {
    logForDebugging(
      `LSP Diagnostics: Clearing delivered diagnostics for ${fileUri}`,
    )
    deliveredDiagnostics.delete(fileUri)
  }
}

/**
 * Get count of pending diagnostics (for monitoring)
 */
/**
 * Read the most recent pending diagnostics for a given file URI, without
 * marking them delivered or removing them from the registry.
 *
 * Returns [] if no pending entry references the URI. Note: this only
 * covers diagnostics that arrived since the last attachment sweep — if
 * checkForLSPDiagnostics already drained them, the registry is empty
 * until the next publishDiagnostics tick.
 */
export function peekPendingDiagnosticsForFile(
  fileUri: string,
): DiagnosticFile['diagnostics'] {
  let latest: PendingLSPDiagnostic | undefined
  for (const entry of pendingDiagnostics.values()) {
    const match = entry.files.find(f => f.uri === fileUri)
    if (!match) continue
    if (!latest || entry.timestamp > latest.timestamp) latest = entry
  }
  if (!latest) return []
  const file = latest.files.find(f => f.uri === fileUri)
  return file ? file.diagnostics : []
}

export function getPendingLSPDiagnosticCount(): number {
  return pendingDiagnostics.size
}
