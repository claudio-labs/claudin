import { logForDebugging } from 'src/shared/debug.js'
import { toError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import type { AttachmentMessage } from 'src/types/message.js'
import { createAttachmentMessage } from 'src/agent/attachments/attachments.js'
import type { DiagnosticFile } from 'src/platform/diagnosticTracking.js'
import {
  awaitDiagnosticsForFile,
  filterUndeliveredDiagnostics,
  markDiagnosticsAsDelivered,
  peekPendingDiagnosticsForFile,
} from 'src/platform/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from 'src/platform/lsp/manager.js'
import { isLspGloballyEnabled } from 'src/platform/lsp/userSettings.js'

const DEFAULT_TIMEOUT_MS = 1500
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 5000
const STABILITY_WINDOW_MS = 400

function resolveTimeoutMs(): number {
  try {
    const lsp = getInitialSettings().lsp as
      | { diagnosticsTimeoutMs?: number }
      | undefined
    const raw = lsp?.diagnosticsTimeoutMs
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return DEFAULT_TIMEOUT_MS
    }
    if (raw < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS
    if (raw > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS
    return raw
  } catch {
    return DEFAULT_TIMEOUT_MS
  }
}

/**
 * Build per-edit diagnostic AttachmentMessages for a freshly-written file.
 *
 * Called from FileEditTool/FileWriteTool right before they return their
 * ToolResult. Awaits up to `lsp.diagnosticsTimeoutMs` (default 1500ms) for
 * the LSP server to publish diagnostics for the file. If any arrive,
 * returns a single `<new-diagnostics>` AttachmentMessage so the model sees
 * errors in the same turn instead of waiting for the next-turn pull.
 *
 * Gates (silent skips, return []):
 *   - LSP globally disabled
 *   - No LSP server registered for the file's extension
 *   - Timeout elapsed before any diagnostics arrived
 *
 * Note: this path INTENTIONALLY does not apply the Bash-tool gate from
 * `getLSPDiagnosticAttachments`. The model has just engaged with an edit
 * tool — it is already in act-on-this-file mode, and the gate's rationale
 * ("no Bash means no way to act") does not apply here.
 *
 * Note: `clearDeliveredDiagnosticsForFile` is already called by FileEditTool
 * and FileWriteTool BEFORE the write to flush stale dedup entries — we do
 * NOT call it again here, that would re-arm the LRU and break dedup.
 */
export async function buildPostEditDiagnosticsMessages(
  absoluteFilePath: string,
): Promise<AttachmentMessage[]> {
  try {
    if (!isLspGloballyEnabled()) return []

    const lspManager = getLspServerManager()
    if (!lspManager) return []
    if (!lspManager.getServerForFile(absoluteFilePath)) return []

    const timeoutMs = resolveTimeoutMs()
    const fileUri = `file://${absoluteFilePath}`

    const files = await awaitDiagnosticsForFile(fileUri, timeoutMs)
    if (!files || files.length === 0) return []

    // Drop empty entries — a server may publish "all clear" with diagnostics:[].
    const nonEmpty = files.filter(f => f.diagnostics.length > 0)
    if (nonEmpty.length === 0) return []

    // Populate the cross-turn dedup LRU so the next turn-level pull skips
    // these. The format mirrors checkForLSPDiagnostics's marking loop.
    markDiagnosticsAsDelivered(nonEmpty)

    logForDebugging(
      `LSP Diagnostics: Per-edit injection delivered ${nonEmpty.reduce((n, f) => n + f.diagnostics.length, 0)} diagnostic(s) for ${fileUri}`,
    )

    return [
      createAttachmentMessage({
        type: 'diagnostics',
        files: nonEmpty,
        isNew: true,
      }),
    ]
  } catch (error: unknown) {
    const err = toError(error)
    logError(
      new Error(
        `buildPostEditDiagnosticsMessages failed for ${absoluteFilePath}: ${err.message}`,
      ),
    )
    return []
  }
}

// ---------------------------------------------------------------------------
// Late-injection tail-wait: closes the third diagnostic-window gap (assistant
// terminates with no tool_use → diagnostic publishes after the per-edit
// timeout but before the next user prompt).
//
// Lifecycle per turn (main thread only):
//   - FileEditTool/FileWriteTool call armFileForLateDiagnostics() after their
//     per-edit injection. Each path that was actually edited is registered.
//   - When the assistant turn ends without tool calls, query.ts calls
//     awaitLateDiagnosticsForTurn() before returning 'completed'. If anything
//     non-trivial survives the stability recheck, query.ts injects an
//     attachment and re-enters the loop ONCE.
//   - Both exits clear the armed set via clearArmedFiles().
//
// Why a registry instead of inspecting tool calls? Edit paths can come from
// custom tools / MCP / future sources. Single point-of-write keeps query.ts
// decoupled from tool shapes.
// ---------------------------------------------------------------------------

const armedFiles = new Set<string>()

function pathToFileUri(absoluteFilePath: string): string {
  return `file://${absoluteFilePath}`
}

/**
 * Register a path for late-diagnostics tail-wait. Called by edit tools after
 * their per-edit `buildPostEditDiagnosticsMessages` returns. No-op when:
 *   - LSP is globally disabled
 *   - Caller is a subagent (agentId !== undefined) — subagents have their own
 *     per-edit injection and re-engaging inside one fights the agent lifecycle
 *   - No LSP server handles the file's language
 */
export function armFileForLateDiagnostics(
  absoluteFilePath: string,
  agentId: string | undefined,
): void {
  try {
    if (agentId !== undefined) return
    if (!isLspGloballyEnabled()) return
    const lspManager = getLspServerManager()
    if (!lspManager) return
    if (!lspManager.getServerForFile(absoluteFilePath)) return
    armedFiles.add(pathToFileUri(absoluteFilePath))
  } catch (error: unknown) {
    logError(
      new Error(
        `armFileForLateDiagnostics failed for ${absoluteFilePath}: ${toError(error).message}`,
      ),
    )
  }
}

/**
 * Clear the armed set. Called by query.ts on both exits of the late-inject
 * branch (after re-engage and after completed).
 */
export function clearArmedFiles(): void {
  armedFiles.clear()
}

/**
 * Test-only: inspect the armed set.
 */
export function _getArmedFilesForTesting(): string[] {
  return [...armedFiles]
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Wait for late diagnostics across all armed file URIs for this turn.
 *
 * Algorithm:
 *   1. Snapshot armed set. Empty → return [] (zero cost when turn had no edits).
 *   2. Race ANY publish across all URIs vs. initialTimeoutMs vs. abort.
 *   3. If only timeout fired → return [].
 *   4. Stability window: sleep STABILITY_WINDOW_MS to let the LSP server
 *      replace a transient batch with its final state (TS incremental compile
 *      often publishes "broken" then "fixed" in tight succession — without
 *      this gap, per-edit injection has been observed to surface false
 *      positives).
 *   5. Peek the latest pending publish for each armed URI. Drop URIs whose
 *      latest publish has no diagnostics (LSP republished "all clear").
 *   6. Return the surviving DiagnosticFile[].
 *
 * Does NOT mark delivered — caller (query.ts) does that only if it decides to
 * inject the attachment, so an aborted/skipped late-inject does not break
 * cross-turn dedup for the next turn's pull.
 */
export async function awaitLateDiagnosticsForTurn(opts?: {
  signal?: AbortSignal
}): Promise<DiagnosticFile[]> {
  const signal = opts?.signal
  const uris = [...armedFiles]
  if (uris.length === 0) return []

  try {
    if (!isLspGloballyEnabled()) return []

    const initialTimeoutMs = resolveTimeoutMs()

    // Race ANY publish across all URIs vs. the abort signal. Sentinel
    // `'aborted'` lets us bail without throwing through the awaiter chain.
    const ABORTED = Symbol('aborted')
    let abortListener: (() => void) | undefined
    const abortPromise = new Promise<typeof ABORTED>(resolve => {
      if (signal?.aborted) {
        resolve(ABORTED)
        return
      }
      abortListener = () => resolve(ABORTED)
      signal?.addEventListener('abort', abortListener, { once: true })
    })
    const anyPublish = Promise.race(
      uris.map(uri => awaitDiagnosticsForFile(uri, initialTimeoutMs)),
    )
    // Resolves with `null` if all per-URI waiters timed out; with a
    // DiagnosticFile[] (possibly empty) if any publish landed; with the
    // ABORTED sentinel if the signal fires first.
    let winner: typeof ABORTED | DiagnosticFile[] | null
    try {
      winner = await Promise.race([anyPublish, abortPromise])
    } finally {
      if (abortListener) signal?.removeEventListener('abort', abortListener)
    }

    if (winner === ABORTED) return []
    if (winner === null) return []

    if (signal?.aborted) return []
    await sleep(STABILITY_WINDOW_MS, signal).catch(() => {})
    if (signal?.aborted) return []

    const peeked: DiagnosticFile[] = []
    for (const uri of uris) {
      const latest = peekPendingDiagnosticsForFile(uri)
      if (latest.length === 0) continue
      peeked.push({ uri, diagnostics: latest })
    }

    // Filter out diagnostics already delivered by per-edit in this same turn.
    // peekPendingDiagnosticsForFile bypasses the dedup LRU, so without this
    // the tail-wait would re-surface what the model already saw.
    const result = filterUndeliveredDiagnostics(peeked)

    if (result.length > 0) {
      logForDebugging(
        `LSP Diagnostics: tail-wait delivered ${result.reduce(
          (n, f) => n + f.diagnostics.length,
          0,
        )} diagnostic(s) across ${result.length} file(s)`,
      )
    }

    return result
  } catch (error: unknown) {
    logError(
      new Error(
        `awaitLateDiagnosticsForTurn failed: ${toError(error).message}`,
      ),
    )
    return []
  }
}
