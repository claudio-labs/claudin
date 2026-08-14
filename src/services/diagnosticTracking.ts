import figures from 'figures'
import { logError } from 'src/utils/log.js'
import { callIdeRpc } from 'src/services/mcp/client.js'
import type { MCPServerConnection } from 'src/services/mcp/types.js'
import { ClaudeError } from 'src/utils/errors.js'
import { normalizePathForComparison, pathsEqual } from 'src/utils/fs/file.js'
import { getConnectedIdeClient } from 'src/services/ide/ide.js'
import { jsonParse } from 'src/utils/slowOperations.js'

class DiagnosticsTrackingError extends ClaudeError {}

const MAX_DIAGNOSTICS_SUMMARY_CHARS = 4000

export interface Diagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}

export class DiagnosticTrackingService {
  private static instance: DiagnosticTrackingService | undefined
  private baseline: Map<string, Diagnostic[]> = new Map()

  private initialized = false
  private currentMcpClients: MCPServerConnection[] = []

  // Track when files were last processed/fetched
  private lastProcessedTimestamps: Map<string, number> = new Map()

  // Track which files have received right file diagnostics and if they've changed
  // Map<normalizedPath, lastClaudeFsRightDiagnostics>
  private rightFileDiagnosticsState: Map<string, Diagnostic[]> = new Map()

  static getInstance(): DiagnosticTrackingService {
    if (!DiagnosticTrackingService.instance) {
      DiagnosticTrackingService.instance = new DiagnosticTrackingService()
    }
    return DiagnosticTrackingService.instance
  }

  initialize() {
    if (this.initialized) {
      return
    }

    this.initialized = true
  }

  async shutdown(): Promise<void> {
    this.initialized = false
    this.currentMcpClients = []
    this.baseline.clear()
    this.rightFileDiagnosticsState.clear()
    this.lastProcessedTimestamps.clear()
  }

  /**
   * Reset tracking state while keeping the service initialized.
   * This clears all tracked files and diagnostics.
   */
  reset() {
    this.baseline.clear()
    this.rightFileDiagnosticsState.clear()
    this.lastProcessedTimestamps.clear()
  }

  /**
   * Get the current IDE client from stored MCP clients
   */
  private getCurrentIdeClient(): MCPServerConnection | undefined {
    return getConnectedIdeClient(this.currentMcpClients)
  }

  /**
   * Backward-compatible method that uses stored IDE client
   */
  async beforeFileEditedCompat(filePath: string): Promise<void> {
    const ideClient = this.getCurrentIdeClient()
    if (!ideClient) {
      return
    }
    return await this.beforeFileEdited(filePath, ideClient)
  }

  /**
   * Backward-compatible method that uses stored IDE client
   */
  async getNewDiagnosticsCompat(): Promise<DiagnosticFile[]> {
    const ideClient = this.getCurrentIdeClient()
    if (!ideClient) {
      return []
    }
    return await this.getNewDiagnostics(ideClient)
  }

  /**
   * Backward-compatible method that uses stored IDE client
   */
  async ensureFileOpenedCompat(fileUri: string): Promise<void> {
    const ideClient = this.getCurrentIdeClient()
    if (!ideClient) {
      return
    }
    return await this.ensureFileOpened(fileUri, ideClient)
  }

  private normalizeFileUri(fileUri: string): string {
    // Remove our protocol prefixes
    const protocolPrefixes = [
      'file://',
      '_claude_fs_right:',
      '_claude_fs_left:',
    ]

    let normalized = fileUri
    for (const prefix of protocolPrefixes) {
      if (fileUri.startsWith(prefix)) {
        normalized = fileUri.slice(prefix.length)
        break
      }
    }

    // Use shared utility for platform-aware path normalization
    // (handles Windows case-insensitivity and path separators)
    return normalizePathForComparison(normalized)
  }

  /**
   * Ensure a file is opened in the IDE before processing.
   * This is important for language services like diagnostics to work properly.
   */
  async ensureFileOpened(fileUri: string, mcpClient: MCPServerConnection): Promise<void> {
    if (
      !this.initialized ||
      !mcpClient ||
      mcpClient.type !== 'connected'
    ) {
      return
    }

    try {
      // Call the openFile tool to ensure the file is loaded
      await callIdeRpc(
        'openFile',
        {
          filePath: fileUri,
          preview: false,
          startText: '',
          endText: '',
          selectToEndOfLine: false,
          makeFrontmost: false,
        },
        mcpClient,
      )
    } catch (error) {
      logError(error as Error)
    }
  }

  /**
   * Capture baseline diagnostics for a specific file before editing.
   * This is called before editing a file to ensure we have a baseline to compare against.
   */
  async beforeFileEdited(filePath: string, mcpClient: MCPServerConnection): Promise<void> {
    if (
      !this.initialized ||
      !mcpClient ||
      mcpClient.type !== 'connected'
    ) {
      return
    }

    const timestamp = Date.now()

    try {
      const result = await callIdeRpc(
        'getDiagnostics',
        { uri: `file://${filePath}` },
        mcpClient,
      )
      const diagnosticFile = this.parseDiagnosticResult(result)[0]
      if (diagnosticFile) {
        // Compare normalized paths (handles protocol prefixes and Windows case-insensitivity)
        if (
          !pathsEqual(
            this.normalizeFileUri(filePath),
            this.normalizeFileUri(diagnosticFile.uri),
          )
        ) {
          logError(
            new DiagnosticsTrackingError(
              `Diagnostics file path mismatch: expected ${filePath}, got ${diagnosticFile.uri})`,
            ),
          )
          return
        }

        // Store with normalized path key for consistent lookups on Windows
        const normalizedPath = this.normalizeFileUri(filePath)
        this.baseline.set(normalizedPath, diagnosticFile.diagnostics)
        this.lastProcessedTimestamps.set(normalizedPath, timestamp)
      } else {
        // No diagnostic file returned, store an empty baseline
        const normalizedPath = this.normalizeFileUri(filePath)
        this.baseline.set(normalizedPath, [])
        this.lastProcessedTimestamps.set(normalizedPath, timestamp)
      }
    } catch (_error) {
      // Fail silently if IDE doesn't support diagnostics
    }
  }

  /**
   * Get new diagnostics from file://, _claude_fs_right, and _claude_fs_ URIs that aren't in the baseline.
   * Only processes diagnostics for files that have been edited.
   */
  async getNewDiagnostics(mcpClient: MCPServerConnection): Promise<DiagnosticFile[]> {
    if (
      !this.initialized ||
      !mcpClient ||
      mcpClient.type !== 'connected'
    ) {
      return []
    }

    // Check if we have any files with diagnostic changes
    let allDiagnosticFiles: DiagnosticFile[] = []
    try {
      const result = await callIdeRpc(
        'getDiagnostics',
        {}, // Empty params fetches all diagnostics
        mcpClient,
      )
      allDiagnosticFiles = this.parseDiagnosticResult(result)
    } catch (_error) {
      // If fetching all diagnostics fails, return empty
      return []
    }
    const diagnosticsForFileUrisWithBaselines = allDiagnosticFiles
      .filter(file => this.baseline.has(this.normalizeFileUri(file.uri)))
      .filter(file => file.uri.startsWith('file://'))

    const diagnosticsForClaudeFsRightUrisWithBaselinesMap = new Map<
      string,
      DiagnosticFile
    >()
    allDiagnosticFiles
      .filter(file => this.baseline.has(this.normalizeFileUri(file.uri)))
      .filter(file => file.uri.startsWith('_claude_fs_right:'))
      .forEach(file => {
        diagnosticsForClaudeFsRightUrisWithBaselinesMap.set(
          this.normalizeFileUri(file.uri),
          file,
        )
      })

    const newDiagnosticFiles: DiagnosticFile[] = []

    // Process file:// protocol diagnostics
    for (const file of diagnosticsForFileUrisWithBaselines) {
      const normalizedPath = this.normalizeFileUri(file.uri)
      const baselineDiagnostics = this.baseline.get(normalizedPath) || []

      // Get the _claude_fs_right file if it exists
      const claudeFsRightFile =
        diagnosticsForClaudeFsRightUrisWithBaselinesMap.get(normalizedPath)

      // Determine which file to use based on the state of right file diagnostics
      let fileToUse = file

      if (claudeFsRightFile) {
        const previousRightDiagnostics =
          this.rightFileDiagnosticsState.get(normalizedPath)

        // Use _claude_fs_right if:
        // 1. We've never gotten right file diagnostics for this file (previousRightDiagnostics === undefined)
        // 2. OR the right file diagnostics have just changed
        if (
          !previousRightDiagnostics ||
          !this.areDiagnosticArraysEqual(
            previousRightDiagnostics,
            claudeFsRightFile.diagnostics,
          )
        ) {
          fileToUse = claudeFsRightFile
        }

        // Update our tracking of right file diagnostics
        this.rightFileDiagnosticsState.set(
          normalizedPath,
          claudeFsRightFile.diagnostics,
        )
      }

      // Find new diagnostics that aren't in the baseline
      const newDiagnostics = fileToUse.diagnostics.filter(
        d => !baselineDiagnostics.some(b => this.areDiagnosticsEqual(d, b)),
      )

      if (newDiagnostics.length > 0) {
        newDiagnosticFiles.push({
          uri: file.uri,
          diagnostics: newDiagnostics,
        })
      }

      // Update baseline with current diagnostics
      this.baseline.set(normalizedPath, fileToUse.diagnostics)
    }

    return newDiagnosticFiles
  }

  private parseDiagnosticResult(result: unknown): DiagnosticFile[] {
    if (Array.isArray(result)) {
      const textBlock = result.find(block => block.type === 'text')
      if (textBlock && 'text' in textBlock) {
        const parsed = jsonParse(textBlock.text)
        return parsed
      }
    }
    return []
  }

  private areDiagnosticsEqual(a: Diagnostic, b: Diagnostic): boolean {
    return (
      a.message === b.message &&
      a.severity === b.severity &&
      a.source === b.source &&
      a.code === b.code &&
      a.range.start.line === b.range.start.line &&
      a.range.start.character === b.range.start.character &&
      a.range.end.line === b.range.end.line &&
      a.range.end.character === b.range.end.character
    )
  }

  private areDiagnosticArraysEqual(a: Diagnostic[], b: Diagnostic[]): boolean {
    if (a.length !== b.length) return false

    // Check if every diagnostic in 'a' exists in 'b'
    return (
      a.every(diagA =>
        b.some(diagB => this.areDiagnosticsEqual(diagA, diagB)),
      ) &&
      b.every(diagB => a.some(diagA => this.areDiagnosticsEqual(diagA, diagB)))
    )
  }

  /**
   * Handle the start of a new query. This method:
   * - Initializes the diagnostic tracker if not already initialized
   * - Resets the tracker if already initialized (for new query loops)
   * - Automatically finds the IDE client from the provided clients list
   *
   * @param clients Array of MCP clients that may include an IDE client
   * @param shouldQuery Whether a query is actually being made (not just a command)
   */
  async handleQueryStart(clients: MCPServerConnection[]): Promise<void> {
    // Store the current MCP clients for later use
    this.currentMcpClients = clients

    // Only proceed if we should query and have clients
    if (!this.initialized) {
      // Find the connected IDE client
      const connectedIdeClient = getConnectedIdeClient(clients)

      if (connectedIdeClient) {
        this.initialize()
      }
    } else {
      // Reset diagnostic tracking for new query loops
      this.reset()
    }
  }

  /**
   * Format diagnostics into a human-readable summary string.
   * This is useful for displaying diagnostics in messages or logs.
   *
   * @param files Array of diagnostic files to format
   * @returns Formatted string representation of the diagnostics
   */
  static formatDiagnosticsSummary(files: DiagnosticFile[]): string {
    // Sort by severity so a budget-bound payload prioritizes Errors over
    // Warnings/Info/Hints. File-level rank is the highest (lowest-numbered)
    // severity within the file, then file URI for stability across turns.
    const severityRank: Record<Diagnostic['severity'], number> = {
      Error: 0,
      Warning: 1,
      Info: 2,
      Hint: 3,
    }
    // Drop files with no diagnostics — they would render as a noisy
    // "filename:\n" empty block.
    const sortedFiles = files
      .filter(f => f.diagnostics.length > 0)
      .map(file => {
        const sortedDiags = [...file.diagnostics].sort((a, b) => {
          const r = severityRank[a.severity] - severityRank[b.severity]
          if (r !== 0) return r
          return a.range.start.line - b.range.start.line
        })
        const fileRank = severityRank[sortedDiags[0]!.severity]
        return { file: { ...file, diagnostics: sortedDiags }, fileRank }
      })
      .sort((a, b) => {
        if (a.fileRank !== b.fileRank) return a.fileRank - b.fileRank
        return a.file.uri.localeCompare(b.file.uri)
      })
      .map(x => x.file)

    // Tally totals up-front so the truncation footer can be honest about
    // what got hidden.
    const totals = { Error: 0, Warning: 0, Info: 0, Hint: 0 }
    for (const file of sortedFiles) {
      for (const d of file.diagnostics) totals[d.severity] += 1
    }

    const formatBlock = (file: DiagnosticFile): string => {
      const filename = file.uri.split('/').pop() || file.uri
      const diags = file.diagnostics
        .map(d => {
          const sym = DiagnosticTrackingService.getSeveritySymbol(d.severity)
          return `  ${sym} [Line ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ''}${d.source ? ` (${d.source})` : ''}`
        })
        .join('\n')
      return `${filename}:\n${diags}`
    }

    // File-boundary-aware accumulation: append whole file blocks until the
    // next would overflow. Reserves room for an honest truncation footer
    // up-front so the cap is never exceeded.
    //
    // Worst-case footer (e.g. all 4 severities × 7-digit counts plus the
    // multi-byte ellipsis) lands around 130 chars. 192 leaves a comfortable
    // margin so the body never gets hard-clipped mid-multibyte char by the
    // safety net below.
    const FOOTER_RESERVE = 192
    const blocks = sortedFiles.map(formatBlock)
    const blockCount = blocks.length
    let acc = ''
    let included = 0
    let includedFiles = 0
    let truncated = false
    for (let i = 0; i < blockCount; i++) {
      const sep = acc.length === 0 ? '' : '\n\n'
      const candidate = acc + sep + blocks[i]
      const budget = MAX_DIAGNOSTICS_SUMMARY_CHARS - FOOTER_RESERVE
      if (candidate.length > budget) {
        truncated = true
        break
      }
      acc = candidate
      includedFiles += 1
      included += sortedFiles[i]!.diagnostics.length
    }

    if (!truncated) return acc

    // Build a footer that names the hidden severity counts so the model
    // knows there's more state and can ask for it explicitly if needed.
    const hiddenTotals = { ...totals }
    for (let i = 0; i < includedFiles; i++) {
      for (const d of sortedFiles[i]!.diagnostics) hiddenTotals[d.severity] -= 1
    }
    const totalDiags =
      totals.Error + totals.Warning + totals.Info + totals.Hint
    const hiddenDiags = totalDiags - included
    const parts: string[] = []
    if (hiddenTotals.Error > 0) parts.push(`${hiddenTotals.Error} errors`)
    if (hiddenTotals.Warning > 0) parts.push(`${hiddenTotals.Warning} warnings`)
    if (hiddenTotals.Info > 0) parts.push(`${hiddenTotals.Info} info`)
    if (hiddenTotals.Hint > 0) parts.push(`${hiddenTotals.Hint} hints`)
    const footer = `\n…[truncated: ${hiddenDiags} more diagnostics across ${blockCount - includedFiles} files — ${parts.join(', ')} hidden]`
    // Footer reserve is conservative; if the actual footer is somehow
    // larger, hard-clip the body so the total stays under the cap.
    let body = acc
    if (body.length + footer.length > MAX_DIAGNOSTICS_SUMMARY_CHARS) {
      body = body.slice(0, MAX_DIAGNOSTICS_SUMMARY_CHARS - footer.length)
    }
    return body + footer
  }

  /**
   * Get the severity symbol for a diagnostic
   */
  static getSeveritySymbol(severity: Diagnostic['severity']): string {
    return (
      {
        Error: figures.cross,
        Warning: figures.warning,
        Info: figures.info,
        Hint: figures.star,
      }[severity] || figures.bullet
    )
  }
}

export const diagnosticTracker = DiagnosticTrackingService.getInstance()
