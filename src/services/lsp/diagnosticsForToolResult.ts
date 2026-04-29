import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { AttachmentMessage } from 'src/types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import {
  awaitDiagnosticsForFile,
  markDiagnosticsAsDelivered,
} from './LSPDiagnosticRegistry.js'
import { getLspServerManager } from './manager.js'
import { isLspGloballyEnabled } from './userSettings.js'

const DEFAULT_TIMEOUT_MS = 1500
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 5000

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
