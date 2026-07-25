import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/index.mjs'
import { feature } from 'bun:bundle'
import { readdir, readFile as readFileAsync } from 'fs/promises'
import * as path from 'path'
import { posix, win32 } from 'path'
import { z } from 'zod/v4'
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_EXTRACT_SIZE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from '../../constants/apiLimits.js'
import { hasBinaryExtension } from '../../constants/files.js'
import { memoryFreshnessNote } from '../../memdir/memoryAge.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  getFileExtensionForAnalytics,
} from '../../services/analytics/metadata.js'
import {
  countTokensWithAPI,
  roughTokenCountEstimationForFileType,
} from '../../services/tokenEstimation.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { getClaudinConfigHomeDir, isEnvTruthy } from '../../utils/envUtils.js'
import { getErrnoCode, isAbortError, isENOENT } from '../../utils/errors.js'
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTimeAsync,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  compressImageBufferWithTokenLimit,
  createImageMetadataText,
  detectImageFormatFromBuffer,
  type ImageDimensions,
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from '../../utils/imageResizer.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { isAutoMemFile } from '../../utils/memoryFileDetection.js'
import { createUserMessage } from '../../utils/messages.js'
import { getCanonicalName, getMainLoopModel } from '../../utils/model/model.js'
import {
  mapNotebookCellsToToolResult,
  readNotebook,
} from '../../utils/notebook.js'
import { expandPath } from '../../utils/path.js'
import { extractPDFPages, getPDFPageCount, readPDF } from '../../utils/pdf.js'
import {
  isPDFExtension,
  isPDFSupported,
  parsePDFPageRange,
} from '../../utils/pdfUtils.js'
import {
  checkReadPermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import {
  FileTooLargeError,
  type ReadFileRangeResult,
  readFileInRange,
} from '../../utils/readFileInRange.js'
import {
  detectSerialReadPattern,
  markFiredAndCheck,
  SERIAL_READ_NUDGE_REMINDER,
} from './serialReadNudge.js'
import { isPriorReadClippedOrMissing } from './clientClippingDetection.js'
import { hasServerClearedToolUses } from './serverClearingDetection.js'
import {
  exceedsPinnedResultCeiling,
  getStandDownEpoch,
  isPinRegistered,
  isPinShielding,
  pinToolResult,
  retirePinAfterUse,
} from '../../services/compact/stableStubState.js'
import { renderOutline } from '../shared/codeOutline/renderOutline.js'
import {
  detectOutlineLangFromPath,
  SCAN_MAX_BYTES,
  scanSymbols,
  type OutlineLang,
  type SymbolEntry,
} from '../shared/codeOutline/scanSymbols.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { getDefaultFileReadingLimits } from './limits.js'
import {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
  LINE_FORMAT_INSTRUCTION,
  OFFSET_INSTRUCTION_DEFAULT,
  OFFSET_INSTRUCTION_TARGETED,
  renderPromptTemplate,
  renderClipPinFallbackFooter,
  renderClipPinFallbackStub,
} from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './UI.js'

// Device files that would hang the process: infinite output or blocking input.
// Checked by path only (no I/O). Safe devices like /dev/null are intentionally omitted.
const BLOCKED_DEVICE_PATHS = new Set([
  // Infinite output — never reach EOF
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  // Blocks waiting for input
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  // Nonsensical to read
  '/dev/stdout',
  '/dev/stderr',
  // fd aliases for stdin/stdout/stderr
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  // /proc/self/fd/0-2 and /proc/<pid>/fd/0-2 are Linux aliases for stdio
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') ||
      filePath.endsWith('/fd/1') ||
      filePath.endsWith('/fd/2'))
  )
    return true
  return false
}

// Narrow no-break space (U+202F) used by some macOS versions in screenshot filenames
const THIN_SPACE = String.fromCharCode(8239)

/**
 * Resolves macOS screenshot paths that may have different space characters.
 * macOS uses either regular space or thin space (U+202F) before AM/PM in screenshot
 * filenames depending on the macOS version. This function tries the alternate space
 * character if the file doesn't exist with the given path.
 *
 * @param filePath - The normalized file path to resolve
 * @returns The path to the actual file on disk (may differ in space character)
 */
/**
 * For macOS screenshot paths with AM/PM, the space before AM/PM may be a
 * regular space or a thin space depending on the macOS version.  Returns
 * the alternate path to try if the original doesn't exist, or undefined.
 */
function getAlternateScreenshotPath(filePath: string): string | undefined {
  const filename = path.basename(filePath)
  const amPmPattern = /^(.+)([ \u202F])(AM|PM)(\.png)$/
  const match = filename.match(amPmPattern)
  if (!match) return undefined

  const currentSpace = match[2]
  const alternateSpace = currentSpace === ' ' ? THIN_SPACE : ' '
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  )
}

// File read listeners - allows other services to be notified when files are read
type FileReadListener = (filePath: string, content: string) => void
const fileReadListeners: FileReadListener[] = []

export function registerFileReadListener(
  listener: FileReadListener,
): () => void {
  fileReadListeners.push(listener)
  return () => {
    const i = fileReadListeners.indexOf(listener)
    if (i >= 0) fileReadListeners.splice(i, 1)
  }
}

export class MaxFileReadTokenExceededError extends Error {
  constructor(
    public tokenCount: number,
    public maxTokens: number,
  ) {
    super(
      `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
    this.name = 'MaxFileReadTokenExceededError'
  }
}

// Common image extensions
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/**
 * Detects if a file path is a session-related file for analytics logging.
 * Only matches files within the Claudin config directory (e.g., ~/.claudin).
 * Returns the type of session file or null if not a session file.
 */
function detectSessionFileType(
  filePath: string,
): 'session_memory' | 'session_transcript' | null {
  const configDir = getClaudinConfigHomeDir()

  // Only match files within the Claudin config directory
  if (!filePath.startsWith(configDir)) {
    return null
  }

  // Normalize path to use forward slashes for consistent matching across platforms
  const normalizedPath = filePath.split(win32.sep).join(posix.sep)

  // Session memory files: ~/.claudin/session-memory/*.md (including summary.md)
  if (
    normalizedPath.includes('/session-memory/') &&
    normalizedPath.endsWith('.md')
  ) {
    return 'session_memory'
  }

  // Session JSONL transcript files: ~/.claudin/projects/*/*.jsonl
  if (
    normalizedPath.includes('/projects/') &&
    normalizedPath.endsWith('.jsonl')
  ) {
    return 'session_transcript'
  }

  return null
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to read'),
    offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
      'The line number to start reading from. Only provide if the file is too large to read at once',
    ),
    limit: semanticNumber(z.number().int().positive().optional()).describe(
      'The number of lines to read. Only provide if the file is too large to read at once.',
    ),
    pages: z
      .string()
      .optional()
      .describe(
        `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      ),
    view: z
      .enum(['outline', 'full'])
      .optional()
      .describe(
        "Set to 'outline' to read only the structural skeleton of a code file — every function/class signature with its line range — instead of the full contents. Set to 'full' to force a full-body read even on large files that would otherwise auto-pivot to an outline. Cheap way to navigate a large file before expanding one part.",
      ),
    symbol: z
      .string()
      .optional()
      .describe(
        "Expand exactly one symbol by name: returns just that function/class/type body with its real line numbers. Use after an outline to read one part of a large file. Takes precedence over offset/limit and view.",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() => {
  // Define the media types supported for images
  const imageMediaTypes = z.enum([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ])

  return z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      file: z.object({
        filePath: z.string().describe('The path to the file that was read'),
        content: z.string().describe('The content of the file'),
        numLines: z
          .number()
          .describe('Number of lines in the returned content'),
        startLine: z.number().describe('The starting line number'),
        totalLines: z.number().describe('Total number of lines in the file'),
      }),
    }),
    z.object({
      type: z.literal('image'),
      file: z.object({
        base64: z.string().describe('Base64-encoded image data'),
        type: imageMediaTypes.describe('The MIME type of the image'),
        originalSize: z.number().describe('Original file size in bytes'),
        dimensions: z
          .object({
            originalWidth: z
              .number()
              .optional()
              .describe('Original image width in pixels'),
            originalHeight: z
              .number()
              .optional()
              .describe('Original image height in pixels'),
            displayWidth: z
              .number()
              .optional()
              .describe('Displayed image width in pixels (after resizing)'),
            displayHeight: z
              .number()
              .optional()
              .describe('Displayed image height in pixels (after resizing)'),
          })
          .optional()
          .describe('Image dimension info for coordinate mapping'),
      }),
    }),
    z.object({
      type: z.literal('notebook'),
      file: z.object({
        filePath: z.string().describe('The path to the notebook file'),
        cells: z.array(z.any()).describe('Array of notebook cells'),
      }),
    }),
    z.object({
      type: z.literal('pdf'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        base64: z.string().describe('Base64-encoded PDF data'),
        originalSize: z.number().describe('Original file size in bytes'),
      }),
    }),
    z.object({
      type: z.literal('parts'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        originalSize: z.number().describe('Original file size in bytes'),
        count: z.number().describe('Number of pages extracted'),
        outputDir: z
          .string()
          .describe('Directory containing extracted page images'),
      }),
    }),
    z.object({
      type: z.literal('file_unchanged'),
      file: z.object({
        filePath: z.string().describe('The path to the file'),
      }),
    }),
    z.object({
      type: z.literal('outline'),
      file: z.object({
        filePath: z.string().describe('The path to the file'),
        content: z
          .string()
          .describe('The pre-rendered structural outline text'),
        totalLines: z.number().describe('Total number of lines in the file'),
        symbolCount: z
          .number()
          .describe('Number of symbols in the outline'),
        autoPivot: z
          .boolean()
          .optional()
          .describe(
            'True when this outline was produced by AUTO_OUTLINE_ON_ELISION because the vanilla full-body Read crossed the size threshold that induces slice-walk re-reads. Triggers an extra footer hint in the tool_result.',
          ),
      }),
    }),
    z.object({
      type: z.literal('clip_pin_fallback'),
      file: z.object({
        filePath: z.string().describe('The path to the file'),
        message: z
          .string()
          .describe(
            'The full tool_result content the clip-pin fallback serves — a structural outline plus redirect footer for code, or a plain redirect stub otherwise.',
          ),
        servedOutline: z
          .boolean()
          .describe(
            'True when `message` carries a structural outline (code file); false when it is the plain textual redirect stub.',
          ),
      }),
    }),
  ])
})
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  searchHint: 'read files, images, PDFs, notebooks',
  // Output is bounded by maxTokens (validateContentTokens). Persisting to a
  // file the model reads back with Read is circular — never persist.
  maxResultSizeChars: Infinity,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    const limits = getDefaultFileReadingLimits()
    const maxSizeInstruction = limits.includeMaxSizeInPrompt
      ? `. Files larger than ${formatFileSize(limits.maxSizeBytes)} will return an error; use offset and limit for larger files`
      : ''
    const offsetInstruction = limits.targetedRangeNudge
      ? OFFSET_INSTRUCTION_TARGETED
      : OFFSET_INSTRUCTION_DEFAULT
    return renderPromptTemplate(
      pickLineFormatInstruction(),
      maxSizeInstruction,
      offsetInstruction,
    )
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Reading ${summary}` : 'Reading file'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.file_path
  },
  isSearchOrReadCommand() {
    return { isSearch: false, isRead: true }
  },
  getPath({ file_path }): string {
    return file_path || getCwd()
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      FileReadTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolUseTag,
  renderToolResultMessage,
  // UI.tsx:140 — ALL types render summary chrome only: "Read N lines",
  // "Read image (42KB)". Never the content itself. The model-facing
  // serialization (below) sends content + CYBER_RISK_MITIGATION_REMINDER
  // + line prefixes; UI shows none of it. Nothing to index. Caught by
  // the render-fidelity test when this initially claimed file.content.
  extractSearchText() {
    return ''
  },
  renderToolUseErrorMessage,
  async validateInput({ file_path, pages }, toolUseContext: ToolUseContext) {
    // Validate pages parameter (pure string parsing, no I/O)
    if (pages !== undefined) {
      const parsed = parsePDFPageRange(pages)
      if (!parsed) {
        return {
          result: false,
          message: `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
          errorCode: 7,
        }
      }
      const rangeSize =
        parsed.lastPage === Infinity
          ? PDF_MAX_PAGES_PER_READ + 1
          : parsed.lastPage - parsed.firstPage + 1
      if (rangeSize > PDF_MAX_PAGES_PER_READ) {
        return {
          result: false,
          message: `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
          errorCode: 8,
        }
      }
    }

    // Path expansion + deny rule check (no I/O)
    const fullFilePath = expandPath(file_path)

    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
      }
    }

    // SECURITY: UNC path check (no I/O) — defer filesystem operations
    // until after user grants permission to prevent NTLM credential leaks
    const isUncPath =
      fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')
    if (isUncPath) {
      return { result: true }
    }

    // Binary extension check (string check on extension only, no I/O).
    // PDF, images, and SVG are excluded - this tool renders them natively.
    const ext = path.extname(fullFilePath).toLowerCase()
    if (
      hasBinaryExtension(fullFilePath) &&
      !isPDFExtension(ext) &&
      !IMAGE_EXTENSIONS.has(ext.slice(1))
    ) {
      return {
        result: false,
        message: `This tool cannot read binary files. The file appears to be a binary ${ext} file. Please use appropriate tools for binary file analysis.`,
        errorCode: 4,
      }
    }

    // Block specific device files that would hang (infinite output or blocking input).
    // This is a path-based check with no I/O — safe special files like /dev/null are allowed.
    if (isBlockedDevicePath(fullFilePath)) {
      return {
        result: false,
        message: `Cannot read '${file_path}': this device file would block or produce infinite output.`,
        errorCode: 9,
      }
    }

    return { result: true }
  },
  /**
   * A re-read whose STAND-DOWN COULD FIRE must reach call(). The dedup and the
   * clip-pin stand-down are transcript-dependent decisions taken INSIDE call(),
   * and a cache hit short-circuits call() for the whole Read TTL (60s). The
   * entry that does the damage is the FIRST, ordinary read's: it is a pure
   * function of input + disk, so it is stored normally, and replaying it during
   * a clip → re-read loop hands the model a fresh UNPINNED copy, never
   * refreshes readFileState, and freezes the stand-down state machine — the
   * loop then spins invisibly instead of terminating. `noResultCache` on the
   * re-send cannot reach that earlier entry; only a pre-lookup bypass can.
   *
   * Scoped to the transcript evidence rather than to "have I read this path",
   * which sounds equivalent and is not: readFileState is session-lifetime with
   * no TTL and has at least eight non-Read writers (Bash, Edit, Write,
   * NotebookEdit, staged writes, the memory attachment pipeline…), so keying on
   * mere presence made the bypass permanent and path-wide — it would delete
   * essentially every in-context Read cache hit while its dead entries kept
   * evicting live Glob/Grep results from the shared LRU. Nor would a sub-agent
   * escape it: fork is the default spawn mode and forks clone readFileState
   * (AgentTool/runAgent.ts).
   *
   * The checks below are the same ones call() would make, in increasing cost,
   * and all of them are cheap: hasServerClearedToolUses is WeakSet-latched
   * after its first positive, and isPriorReadClippedOrMissing early-exits at
   * the matching tool_result (re-reads cluster near their original Read).
   */
  bypassResultCache({ file_path }, context) {
    try {
      const prior = context.readFileState?.get(expandPath(file_path))
      // First read of this path in this context: nothing to stand down from,
      // so let it cache and be served from cache like any other tool. Note this
      // also covers a path whose entry was LRU-evicted (readFileState holds 100,
      // 10 in queryHelpers) — indistinguishable from a first read, and equally
      // harmless: the replay still hands the model the real body, it just skips
      // a dedup that had no state to dedup against anyway.
      if (!prior) return false
      // Sticky stand-down state: call() owns this, either by replaying the
      // recorded outline or by expiring it. A cached full body replayed here
      // would hand back precisely the content the fallback already concluded
      // cannot survive, and the marker would never be consulted — the loop
      // would keep spinning invisibly for the whole cache TTL. Checked before
      // the pin because a sticky entry carries no toolUseId to ask about.
      if (prior.standDownOutline !== undefined) return true
      // A stand-down cycle is OPEN — call() owns the decision from here.
      // isPinShielding, not isPinRegistered: the wide predicate also answers
      // true for a SPENT id, and the intact branch retires ids into spent while
      // leaving readFileState pointing at them. Keying on it would make this
      // path bypass the cache permanently after one cycle — the same
      // "stays true forever" failure the path-presence version had.
      if (prior.toolUseId !== undefined && isPinShielding(prior.toolUseId)) {
        return true
      }
      const messages = context.messages
      if (!Array.isArray(messages)) return false
      if (hasServerClearedToolUses(messages)) return true
      return (
        prior.toolUseId !== undefined &&
        isPriorReadClippedOrMissing(messages, prior.toolUseId)
      )
    } catch (e) {
      // Fail open: keep the ordinary cache behavior rather than blocking.
      logError(e)
      return false
    }
  },
  async call(
    { file_path, offset = 1, limit = undefined, pages, view, symbol },
    context,
    _canUseTool?,
    parentMessage?,
  ) {
    const { readFileState, fileReadingLimits } = context

    // offset is 1-indexed but the schema accepts 0 (nonnegative). Both read
    // from the first line, so normalize early — otherwise startLine: 0 would
    // make the line-number prefixes start at 0 (off by one vs the real file)
    // and dedup would treat offset 0 and 1 as different ranges.
    if (offset === 0) offset = 1

    const defaults = getDefaultFileReadingLimits()
    const maxSizeBytes =
      fileReadingLimits?.maxSizeBytes ?? defaults.maxSizeBytes
    const maxTokens = fileReadingLimits?.maxTokens ?? defaults.maxTokens

    // Telemetry: track when callers override default read limits.
    // Only fires on override (low volume) — event count = override frequency.
    if (fileReadingLimits !== undefined) {
      logEvent('tengu_file_read_limits_override', {
        hasMaxTokens: fileReadingLimits.maxTokens !== undefined,
        hasMaxSizeBytes: fileReadingLimits.maxSizeBytes !== undefined,
      })
    }

    const ext = path.extname(file_path).toLowerCase().slice(1)
    // Use expandPath for consistent path normalization with FileEditTool/FileWriteTool
    // (especially handles whitespace trimming and Windows path separators)
    const fullFilePath = expandPath(file_path)

    // Dedup: if we've already read this exact range and the file hasn't
    // changed on disk, return a stub instead of re-sending the full content.
    // The earlier Read tool_result is still in context — two full copies
    // waste cache_creation tokens on every subsequent turn. BQ proxy shows
    // ~18% of Read calls are same-file collisions (up to 2.64% of fleet
    // cache_creation). Only applies to text/notebook reads — images/PDFs
    // aren't cached in readFileState so won't match here.
    //
    // Ant soak: 1,734 dedup hits in 2h, no Read error regression.
    // Killswitch pattern: GB can disable if the stub message confuses
    // the model externally.
    // 3P default: killswitch off = dedup enabled. Client-side only — no
    // server support needed, safe for Bedrock/Vertex/Foundry.
    const dedupKillswitch = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_read_dedup_killswitch',
      false,
    )
    // `let`, not `const`: the sticky branch below can spend its budget and
    // delete the entry, and everything downstream must then see a genuine
    // first read rather than a stale local.
    //
    // Note the killswitch reach: `tengu_read_dedup_killswitch` nulls this out,
    // which disables the sticky branch too. That is documented in AGENTS.md
    // alongside CLAUDIN_DISABLE_READ_CLIP_PIN, because the two killswitches
    // have different scopes and only this one can restore unbounded re-sends.
    let existingState = dedupKillswitch
      ? undefined
      : readFileState.get(fullFilePath)

    // STICKY STAND-DOWN. This exact (path, offset, limit) already exhausted
    // the re-send lanes and was answered with a structural outline. Serve that
    // same answer again instead of starting the cycle over.
    //
    // This is what makes the fallback TERMINATE. The version before it deleted
    // the entry to re-arm, so the next read was a first read and paid another
    // full body; the pin is temporary by construction (it expires, loses its
    // slot to the FIFO, or exceeds the ceiling) while the file is permanent,
    // so the two together settled into an oscillation: two full bodies every
    // THREE reads when the pin cannot protect a round (over the 8k ceiling,
    // evicted by the FIFO, or no toolUseId to pin), and every four when it can
    // — the protected round adds one cheap dedup stub before the fallback.
    // Forever, either way. Bounded, but never finished.
    //
    // Placed BEFORE the dedup gate below, and deliberately not part of it: the
    // gate excludes isPartialView entries and the sticky entry is one (so
    // Edit/Write still demand a real Read). It also carries no toolUseId, so
    // unlike the dedup stub it can never point the model at a tool_result that
    // is no longer there — the blind-pointer bug this whole mechanism exists
    // to avoid cannot be reached from here.
    //
    // Sticky is not permanent, which was the failure mode of an earlier
    // "return the outline and don't touch readFileState" attempt. Five ways
    // out, four of them checked right here and one structural:
    //   1. the file changed on disk — the outline describes bytes that no
    //      longer exist, so fall through and read it;
    //   2. a main-thread compaction advanced the epoch — the pressure that
    //      clipped the body is gone and the transcript was rewritten, so the
    //      model deserves the real thing;
    //   3. the replay budget is spent (see STICKY_REPLAY_BUDGET);
    //   4. a different offset/limit/view/symbol fails the checks below;
    //   5. LRU eviction drops the entry — the only structural one.
    //
    // Exit 3 is the one that does not depend on anything external happening,
    // and it is load-bearing rather than belt-and-braces. Note what is NOT on
    // the list: an Edit/Write replacing the entry. That reads like the obvious
    // escape hatch and cannot open by itself, because this marker sets
    // isPartialView, so those tools are REFUSED while it stands ("read it
    // first") — they can never be what replaces the entry. Exit 2 does not
    // cover it either: the marker is created by microCompact, whose whole job
    // is to keep the session BELOW the autocompact threshold, so a session
    // that clips this way may never reach a main-thread compaction at all.
    // Without the budget the model is left unable to read its way to a body
    // and unable to edit, which is the permanent-refusal bug wearing a hat.
    //
    // Outside clipPinEnabled() on purpose, like the strike counter: the
    // killswitch turns off the PIN, not the bound. Handing a frustrated user
    // back an unbounded re-send loop is not an opt-out.
    const stickyOutline = existingState?.standDownOutline
    if (
      existingState !== undefined &&
      stickyOutline !== undefined &&
      view === undefined &&
      symbol === undefined &&
      existingState.offset === offset &&
      existingState.limit === limit &&
      stickyOutline.epoch === getStandDownEpoch()
    ) {
      let stickyMtimeMs: number | undefined
      try {
        stickyMtimeMs = await getFileModificationTimeAsync(fullFilePath)
      } catch {
        // stat failed — fall through to a full read, same policy as the dedup
        // arm below: fail toward giving the model content.
      }
      if (stickyMtimeMs === existingState.timestamp) {
        // Charge before deciding, so the read that exhausts the budget is the
        // one that gets a body. Charging after would make the last refusal the
        // final answer for this marker, which is the deadlock again by one.
        if (
          readFileState.chargeStandDownReplay(fullFilePath) <=
          STICKY_REPLAY_BUDGET
        ) {
          return {
            data: {
              type: 'clip_pin_fallback' as const,
              file: {
                filePath: file_path,
                message: stickyOutline.message,
                servedOutline: stickyOutline.servedOutline,
              },
            },
            // Same reason as the fallback that wrote this marker: the decision
            // depends on the entry and the epoch, not on the tool input, and a
            // cache hit short-circuits before call().
            noResultCache: true,
          }
        }
        // Budget spent: drop the marker and fall through as a first read. This
        // IS the delete-and-re-arm the marker replaced — the point was never
        // that re-arming is wrong, only that re-arming on every fallback is
        // too often. Now it happens once per STICKY_REPLAY_BUDGET outlines.
        readFileState.delete(fullFilePath)
        existingState = undefined
      }
    }

    // Only dedup entries that came from a prior Read (offset is always set
    // by Read). Edit/Write store offset=undefined — their readFileState
    // entry reflects post-edit mtime, so deduping against it would wrongly
    // point the model at the pre-edit Read content.
    // Skip dedup for outline/unfold requests: they share the default
    // offset/limit with a prior full Read, so they would wrongly dedup-match
    // and return a file_unchanged stub instead of the requested view.
    // Set when this Read is a slice-walk candidate (see the else-if below);
    // consumed after callInner succeeds.
    let sliceWalkPrior:
      | { timestamp: number; priorWasFullRead: boolean }
      | undefined
    // Set when this Read is the re-send half of a clip-pin stand-down;
    // consumed after callInner succeeds.
    let standDownResend = false
    // Strike count to carry onto the entry the re-send is about to write.
    let standDownStrikes = 0
    if (
      existingState &&
      !existingState.isPartialView &&
      existingState.offset !== undefined &&
      view === undefined &&
      symbol === undefined
    ) {
      const rangeMatch =
        existingState.offset === offset && existingState.limit === limit
      if (rangeMatch) {
        // Server-side clear_tool_uses may have wiped the earlier Read's
        // tool_result the stub would point at (the API reports only counts,
        // not which tool uses were cleared) — and an unchanged-file re-Read
        // is exactly the move a model makes after losing the content. Once
        // clearing has been applied in this session, stand down and re-send;
        // the fresh Read becomes a recent (kept) tool_result again. See
        // serverClearingDetection.ts.
        const serverCleared =
          Array.isArray(context.messages) &&
          hasServerClearedToolUses(context.messages)
        // The client-side clip paths (age prune, RSS byte-guard, time-based
        // clear, microcompact stable stubs) rewrite old tool_results to clip
        // stubs without touching readFileState — same blind-pointer bug,
        // deterministic under the aggressive profile. Here the stand-down is
        // per-file: the entry records which tool_use carried the content, so
        // dedup only disarms when THAT tool_result is clipped or gone. See
        // clientClippingDetection.ts.
        const clientClipped =
          !serverCleared &&
          existingState.toolUseId !== undefined &&
          Array.isArray(context.messages) &&
          isPriorReadClippedOrMissing(
            context.messages,
            existingState.toolUseId,
          )
        const standDown = serverCleared || clientClipped
        // DO NOT try to "rescue" the serverCleared arm by checking whether the
        // prior block still looks intact in `context.messages`. It always does:
        // clear_tool_uses is applied API-side and our local copy is never
        // rewritten (the response carries counts only), so
        // isPriorReadClippedOrMissing is structurally blind to it. Treating a
        // still-visible pinned copy as evidence that the latch is stale — the
        // obvious-looking optimisation — makes standDown permanently false
        // under a latched clear and hands the model a dedup stub pointing at
        // content the API removed, forever. A client-side pin cannot stop
        // server-side clearing either (prompt.ts says so). Measured cost of
        // getting this wrong: an infinite blind-pointer loop replacing a
        // working outline fallback.
        //
        // The accepted cost of getting it RIGHT: once any clear lands, every
        // file re-read at the same range costs an extra round through the
        // fallback, even if that particular block was never cleared. With
        // counts-only reporting there is no evidence that could distinguish
        // them, and an outline is real content — the failure mode on the other
        // side is not.
        //
        // What this must NOT become is permanent. An earlier version keyed the
        // fallback purely on the pin and returned without touching
        // readFileState, so under a latched clear the entry kept pointing at a
        // spent id and EVERY later read of that range was an outline — for the
        // rest of the session, for a file sitting readable on disk. The sticky
        // marker is the successor to that attempt and carries its own defence
        // against it: STICKY_REPLAY_BUDGET (see the branch near the top of
        // call()). Two properties have to hold together, and every version so
        // far has traded one for the other — never two futile re-sends in a
        // row, and never an indefinite refusal.
        if (!standDown) {
          // Prior tool_result is intact in context (not clipped/cleared), so
          // whatever the model is doing it is NOT the clipped-reread loop. Any
          // pin we placed on that result has done its job; release it so the
          // normal clip policy applies again.
          //
          // Only this arm may release: under a latched server clear the
          // client-side view proves nothing about what the API still shows the
          // model. Pins abandoned by a range switch or an Edit/Write are
          // released structurally instead, when readFileState drops the entry
          // that owns them (fileStateCache's dispose hook).
          //
          // retirePinAfterUse, NOT unpinToolResult: free the shielding slot but
          // keep the memory that this copy already had its protected re-send.
          // A full release here re-arms the loop — the block is still intact,
          // so this ordinary Read forgets the id, the next clip pass stubs it,
          // and the stand-down starts over with another full body, once per
          // rotation, forever. unpinToolResult is for when the id stops being
          // ours at all (dispose hook, orphan sweeps).
          if (existingState.toolUseId !== undefined) {
            retirePinAfterUse(existingState.toolUseId)
          }
          // The copy survived, so whatever streak was running is over. Leaving
          // stale strikes here would let three unrelated clip events months
          // apart in one session add up to an outline on a file that has been
          // fine every time in between.
          if (existingState.standDownStrikes) {
            readFileState.setStandDownStrikes(fullFilePath, 0)
          }
          try {
            const mtimeMs = await getFileModificationTimeAsync(fullFilePath)
            if (mtimeMs === existingState.timestamp) {
              const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
              logEvent('tengu_file_read_dedup', {
                ...(analyticsExt !== undefined && { ext: analyticsExt }),
              })
              return {
                data: {
                  type: 'file_unchanged' as const,
                  file: { filePath: file_path },
                },
                // The stub's validity depends on the transcript (the earlier
                // tool_result must still be intact), not on the tool input.
                // Cached replay would bypass the stand-down checks above for
                // the cache TTL — exactly the window right after a clip or
                // server clearing, when the model re-reads to recover.
                noResultCache: true,
              }
            }
          } catch {
            // stat failed — fall through to full read
          }
        } else if (serverCleared) {
          logEvent('tengu_file_read_dedup_skip_server_clearing', {})
        } else {
          logEvent('tengu_file_read_dedup_skip_client_clipping', {})
        }
        // Clip-pin stand-down. A clipped/cleared stand-down re-sends the full
        // body — and whatever clipped the first copy (the age prune under the
        // aggressive profile, microcompact/byte-guard under retain) clips the
        // re-sent one too, so the model re-reads and we re-send forever.
        //
        // So pin the re-delivered copy instead: every clip path skips a pinned
        // tool_result (stableStubState.pinToolResult), so the content stays put
        // and the loop ends after ONE re-send. The pin doubles as the state
        // machine: if the prior copy was ALREADY pinned and is gone from the
        // transcript anyway (clipped despite the pin, or cleared API-side),
        // re-sending would just refill a slot something already emptied once.
        // Serve a stable form instead: the file's structural outline (the
        // model picks a symbol=), or the head of the file when there is
        // nothing to outline.
        //
        // TWO LANES REACH THAT FALLBACK, and the split is the whole design:
        //
        // Lane 1 — the pin. We have an id, it was pinned, and the copy is gone
        // anyway: one protected re-send already happened and failed, so the
        // next one would too. Exits after exactly ONE wasted body.
        //
        // Lane 2 — the strike counter, for every case a pin structurally
        // cannot cover. Contexts with no toolUseId to pin (Tool.ts's field is
        // optional: @-mentions via attachments/file-pipeline.ts, MagicDocs,
        // SessionMemory, the MCP entrypoint) and the killswitch path, which is
        // why this lane sits OUTSIDE clipPinEnabled(). Without it those paths
        // either loop forever (re-send every time, nothing remembers) or —
        // the version this replaces — get an outline on the FIRST stand-down,
        // so a user re-@-mentioning a file is told to stop re-reading it. The
        // counter lives on the FileState entry, so it resets for free on a
        // range switch, an Edit/Write or an eviction, all of which replace or
        // drop the entry.
        //
        // The branch message once claimed "no counter, no streak bookkeeping".
        // That was wrong, and this is the correction: the pin bounds the case
        // it can see, and the counter bounds the rest.
        if (standDown) {
          const priorToolUseId = existingState.toolUseId
          const pinnedAndGone =
            clipPinEnabled() &&
            priorToolUseId !== undefined &&
            isPinRegistered(priorToolUseId)
          // A re-send is only worth paying for if the copy it produces can
          // actually be shielded. Above MAX_PINNED_RESULT_TOKENS
          // pinShieldsBlock retires the id on sight, so the body is clipped in
          // the same pass that first examines it and the id lands in the spent
          // registry — which sends the NEXT read straight to this fallback
          // anyway. That cost one full futile body per cycle to reach a
          // decision that was already made. Ask first instead.
          //
          // existingState.content is what the prior read of this exact range
          // stored, i.e. the bytes the re-send would carry.
          //
          // Gated on clipPinEnabled() because the ceiling is a property of the
          // pin: with the pin off nothing shields anything, and the strike
          // counter is the documented bound for that path.
          const overPinCeiling =
            clipPinEnabled() && exceedsPinnedResultCeiling(existingState.content)
          const strikes = (existingState.standDownStrikes ?? 0) + 1
          if (pinnedAndGone || overPinCeiling || strikes >= STAND_DOWN_STRIKES) {
            const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
            const outlineLang = detectOutlineLangFromPath(fullFilePath)
            const outline = outlineLang
              ? await scanFile(
                  fullFilePath,
                  outlineLang,
                  context.abortController.signal,
                )
              : null
            // Same floor the auto-outline pivot applies. scanFile only returns
            // null at ZERO symbols, so without this a 2000-line file whose
            // parser found a single top-level symbol gets "answered" with a
            // one-line outline — technically an outline, useless as a view of
            // the file. Below the floor the head slice is the better content.
            const scanned =
              outline && outline.entries.length >= READ_AUTO_OUTLINE_MIN_SYMBOLS
                ? outline
                : null
            // Event name predates the rename from the re-read breaker; kept
            // for dashboard continuity. The arm separates the two stand-downs:
            // 'clipped' has positive evidence the pinned copy was removed,
            // 'cleared' only knows the API cleared something, sometime. Sent
            // as a boolean because LogEventMetadata takes no free-form strings
            // (they leak code/filepaths) — see analytics/index.ts:128.
            const arm = serverCleared ? 'cleared' : 'clipped'
            logEvent('tengu_file_read_rerun_breaker', {
              ...(analyticsExt !== undefined && { ext: analyticsExt }),
              servedOutline: scanned !== null,
              armCleared: serverCleared,
            })
            const message = scanned
              ? renderOutline(scanned.entries, file_path, scanned.lines.length, {
                  overCap: false,
                }) + renderClipPinFallbackFooter(offset, limit, arm)
              : (await renderClipPinHeadSlice(
                  fullFilePath,
                  context.abortController.signal,
                )) + renderClipPinFallbackStub(offset, limit, arm)
            // REMEMBER the decision instead of re-arming into another body.
            //
            // The previous version deleted the entry here, which made the next
            // read of this range a genuine first read — a full body — and the
            // one after it another stand-down re-send. Two bodies per cycle,
            // forever: bounded, but never finished. Leaving the entry with its
            // spent toolUseId was not the alternative either; that falls into
            // the always-armed dedup below and answers with a file_unchanged
            // stub pointing at the very content we just failed to deliver.
            //
            // So: keep an entry, drop the id, and record the answer. The
            // sticky branch at the top of call() replays this exact message
            // until the file changes, a compaction advances the epoch, or the
            // replay budget runs out. No toolUseId means no blind pointer is
            // even representable; the dispose hook releases the old pin on the
            // way through set().
            //
            // isPartialView: true because the model has NOT seen the body, so
            // an Edit before the next Read must still say "read it first"
            // (FileEditTool, FileWriteTool, applyPatch and NotebookEditTool
            // all check this field). It also keeps this entry out of the dedup
            // gate below.
            //
            // This is NOT the same cost the delete already paid, and an
            // earlier version of this comment claimed it was. Under delete,
            // the refusal lifted on the next read, which returned a body.
            // Under a marker that replays, Read stops rewriting the entry, so
            // the refusal has nothing to lift it — hence STICKY_REPLAY_BUDGET,
            // which is what restores the ending the delete used to provide.
            //
            // Only go sticky when the bytes on disk still match what the
            // outline describes. A file that changed since the prior read gets
            // the old delete-and-re-arm behavior, which is self-correcting:
            // the next read is a real body of the NEW content, which is what
            // the model should get. Same policy as everywhere else here — when
            // the evidence runs out, fail toward giving the model content.
            let stickyMtimeMs: number | undefined
            try {
              stickyMtimeMs = await getFileModificationTimeAsync(fullFilePath)
            } catch {
              // stat failed — fall through to the delete below.
            }
            if (stickyMtimeMs === existingState.timestamp) {
              readFileState.set(fullFilePath, {
                content: existingState.content,
                timestamp: existingState.timestamp,
                offset,
                limit,
                isPartialView: true,
                standDownOutline: {
                  message,
                  servedOutline: scanned !== null,
                  epoch: getStandDownEpoch(),
                  replays: 0,
                },
              })
            } else {
              readFileState.delete(fullFilePath)
            }
            return {
              data: {
                type: 'clip_pin_fallback' as const,
                file: {
                  filePath: file_path,
                  message,
                  servedOutline: scanned !== null,
                },
              },
              // Transcript-dependent like the dedup stub — never replay from
              // the tool-result cache (would bypass the stand-down/fallback).
              noResultCache: true,
            }
          }
          // Under both lanes' thresholds: re-send the body below and, if we
          // have an id, pin the copy that carries it so the next clip pass
          // leaves it alone. Reaching this line means the prior id was not
          // pinned (lane 1 returned above if it was), so there is nothing to
          // unpin here.
          //
          // Deferred to after callInner on purpose: pinning right here would
          // protect whatever that id ends up carrying rather than the body
          // this stand-down promised. A throw is the reachable case: it leaves
          // readFileState pointing at the OLD id, so the state machine would
          // never look at the pinned one again while it sat on a slot.
          standDownResend = true
          standDownStrikes = strikes
        }
      } else if (offset > 1 || limit !== undefined) {
        // Slice-walk telemetry candidate (diagnostic only, no behavior
        // change): an explicit-range Read of a file whose previous Read used
        // a DIFFERENT range — the windowing pattern auto-outline cannot
        // intercept (it only fires on vanilla full-file reads of code files)
        // and the exact-range dedup cannot see. Measures how often the
        // bypass happens in the field before designing any mitigation.
        // The event is logged after callInner succeeds by comparing the
        // fresh entry's mtime against this snapshot: no extra stat (the read
        // fetches mtime anyway) and the unchanged-on-disk judgment spans the
        // read itself. priorWasFullRead distinguishes re-slicing content the
        // model already saw in full from walking a file window by window.
        sliceWalkPrior = {
          timestamp: existingState.timestamp,
          priorWasFullRead:
            existingState.offset === 1 && existingState.limit === undefined,
        }
      }
    }

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
      if (newSkillDirs.length > 0) {
        // Store discovered dirs for attachment display
        for (const dir of newSkillDirs) {
          context.dynamicSkillDirTriggers?.add(dir)
        }
        // Don't await - let skill loading happen in the background
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // Activate conditional skills whose path patterns match this file
      activateConditionalSkillsForPaths([fullFilePath], cwd)
    }

    try {
      const result = await callInner(
        file_path,
        fullFilePath,
        fullFilePath,
        ext,
        offset,
        limit,
        pages,
        view,
        symbol,
        maxSizeBytes,
        maxTokens,
        readFileState,
        context,
        parentMessage?.message.id,
      )
      if (sliceWalkPrior) {
        // The read above refreshed the readFileState entry with the mtime it
        // fetched; equal timestamps mean the file was unchanged across the
        // prior read, this read, and everything in between.
        const fresh = readFileState.get(fullFilePath)
        if (fresh && fresh.timestamp === sliceWalkPrior.timestamp) {
          const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
          logEvent('tengu_file_read_slice_walk', {
            ...(analyticsExt !== undefined && { ext: analyticsExt }),
            isCode: detectOutlineLangFromPath(fullFilePath) != null,
            priorWasFullRead: sliceWalkPrior.priorWasFullRead,
          })
        }
      }
      maybeFlagSerialReadNudge(result?.data, context)
      if (standDownResend) {
        const resendToolUseId = context.toolUseId
        // callInner just overwrote the entry with a fresh FileState, which has
        // no strike count. Carry it across BEFORE the pin: mutated in place, so
        // no dispose fires and the pin ownership about to be claimed below is
        // not churned. Lane 2 is only a bound if the count survives the very
        // read it is counting.
        readFileState.setStandDownStrikes(fullFilePath, standDownStrikes)
        // Pin only when the entry that owns the release actually points at
        // this result. These arms skip the mtime check on purpose, so the file
        // may have crossed the auto-outline threshold since the clipped read:
        // that pivot rewrites the entry as a partial view with no toolUseId,
        // which both disarms the state machine and leaves nobody to release
        // the pin — the leak the dispose hook exists to prevent.
        //
        // clipPinEnabled() is re-checked here because lane 2 sets
        // standDownResend from OUTSIDE the gate: the strike bound applies to
        // the killswitch path, but the killswitch must still mean "nothing
        // gets pinned".
        if (
          clipPinEnabled() &&
          resendToolUseId !== undefined &&
          readFileState.get(fullFilePath)?.toolUseId === resendToolUseId
        ) {
          pinToolResult(resendToolUseId)
        }
        // Independent of whether anything got pinned: the DECISION to re-send
        // was transcript-dependent, and a cache hit short-circuits BEFORE
        // call() (Tool.ts wrapCallWithCache). Replaying this body for the Read
        // TTL would hand the model an unpinned copy and freeze the stand-down
        // state machine, so the loop would keep spinning invisibly instead of
        // reaching the fallback — including in contexts that carry no
        // toolUseId to pin.
        return { ...result, noResultCache: true }
      }
      return result
    } catch (error) {
      // Handle file-not-found: suggest similar files
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        // macOS screenshots may use a thin space or regular space before
        // AM/PM — try the alternate before giving up.
        const altPath = getAlternateScreenshotPath(fullFilePath)
        if (altPath) {
          try {
            const altResult = await callInner(
              file_path,
              fullFilePath,
              altPath,
              ext,
              offset,
              limit,
              pages,
              view,
              symbol,
              maxSizeBytes,
              maxTokens,
              readFileState,
              context,
              parentMessage?.message.id,
            )
            maybeFlagSerialReadNudge(altResult?.data, context)
            // No stand-down bookkeeping here, on purpose: the alt arm only
            // fires for `AM/PM.png` names, and image reads never write
            // readFileState (dedup is text/notebook-only, per the comment at
            // the top of call), so standDownResend cannot be armed when the
            // alt path succeeds — there are no strikes to carry and nothing
            // to pin. The clip → re-read loop the stand-down closes does not
            // exist for images.
            return altResult
          } catch (altError) {
            if (!isENOENT(altError)) {
              throw altError
            }
            // Alt path also missing — fall through to friendly error
          }
        }

        const similarFilename = findSimilarFile(fullFilePath)
        const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
        let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
        if (cwdSuggestion) {
          message += ` Did you mean ${cwdSuggestion}?`
        } else if (similarFilename) {
          message += ` Did you mean ${similarFilename}?`
        }
        throw new Error(message)
      }
      throw error
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    switch (data.type) {
      case 'image': {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                data: data.file.base64,
                media_type: data.file.type,
              },
            },
          ],
        }
      }
      case 'notebook':
        return mapNotebookCellsToToolResult(data.file.cells, toolUseID)
      case 'pdf':
        // Return PDF metadata only - the actual content is sent as a supplemental DocumentBlockParam
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `PDF file read: ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
        }
      case 'parts':
        // Extracted page images are read and sent as image blocks in mapToolResultToAPIMessage
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `PDF pages extracted: ${data.file.count} page(s) from ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
        }
      case 'file_unchanged':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: FILE_UNCHANGED_STUB,
        }
      case 'outline':
        // Pre-rendered skeleton — no cat -n line prefixes, no mitigation
        // reminder. Sent verbatim. AUTO_OUTLINE_ON_ELISION pivots append a
        // one-line footer so the model knows the body was withheld
        // intentionally and how to opt in to the full content.
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: data.file.autoPivot
            ? data.file.content + AUTO_OUTLINE_PIVOT_FOOTER
            : data.file.content,
        }
      case 'clip_pin_fallback':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: data.file.message,
        }
      case 'text': {
        let content: string

        // Branch on numLines, not content truthiness: a file containing only
        // '\n' has one (empty) line — content is '' but it is NOT empty.
        if (data.file.numLines > 0) {
          content =
            memoryFileFreshnessPrefix(data) +
            formatFileLines(data.file) +
            (shouldIncludeFileReadMitigation()
              ? CYBER_RISK_MITIGATION_REMINDER
              : '') +
            (serialReadNudgeFlagged.has(data) ? SERIAL_READ_NUDGE_REMINDER : '')
        } else {
          // Determine the appropriate warning message
          content =
            data.file.totalLines === 0
              ? '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
              : `<system-reminder>Warning: the file exists but is shorter than the provided offset (${data.file.startLine}). The file has ${data.file.totalLines} ${data.file.totalLines === 1 ? 'line' : 'lines'}.</system-reminder>`
        }

        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content,
        }
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function pickLineFormatInstruction(): string {
  return LINE_FORMAT_INSTRUCTION
}

/** Format file content with line numbers. */
function formatFileLines(file: {
  content: string
  startLine: number
  numLines: number
}): string {
  if (file.content === '' && file.numLines > 0) {
    // A single empty line (file containing only '\n'). addLineNumbers
    // returns '' for empty content, so derive the bare prefix from it —
    // format a one-space line and trim, which works for both the compact
    // and the padded prefix format.
    return addLineNumbers({ content: ' ', startLine: file.startLine }).trimEnd()
  }
  return addLineNumbers(file)
}

/**
 * Footer appended to outline tool_results produced by AUTO_OUTLINE_ON_ELISION
 * — kept as a single declarative line so it survives any downstream text
 * normalisation and shows up identically in transcripts. Exported for tests
 * and for the optional UI badge that mirrors the same wording.
 */
export const AUTO_OUTLINE_PIVOT_FOOTER =
  "\n\n<system-reminder>File is large; returned outline instead of full body. Use view='outline' explicitly to map further, or pass offset/limit/symbol to load a specific range.</system-reminder>"

/**
 * Body size at which a vanilla full-file Read pivots to an outline. ~10 KB is
 * the empirical floor where Opus starts narrating about needing "the middle"
 * of a large literal tool_result and re-Reads in slices; below it the full
 * body fits in working context without inducing the slice-walk loop.
 */
const READ_AUTO_OUTLINE_THRESHOLD_CHARS = 10_000

/**
 * Line-count companion to the char threshold: a long code file with many
 * short lines can stay under 10 KB while still being tiring to read whole
 * ("more than 2 functions and more than 250 lines → bring only what
 * matters"). Only pivots when the scan also finds at least
 * READ_AUTO_OUTLINE_MIN_SYMBOLS symbols, so a long single-function file still
 * returns its body.
 */
const READ_AUTO_OUTLINE_THRESHOLD_LINES = 250
const READ_AUTO_OUTLINE_MIN_SYMBOLS = 3

/**
 * Single source of truth for the AUTO_OUTLINE_ON_ELISION gate. Tests can
 * force-enable via `CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION=1` because the
 * test-preload (src/stubs/test-preload.ts) stubs every `feature()` call to
 * `false` and a local `mock.module('bun:bundle', …)` runs too late to win
 * against it. Production behavior is unchanged: the build-time preprocessor
 * folds `feature('AUTO_OUTLINE_ON_ELISION')` to its flag value.
 */
function autoOutlineOnElisionEnabled(): boolean {
  if (process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION === '1') return true
  if (process.env.CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION === '1') return false
  if (feature('AUTO_OUTLINE_ON_ELISION')) return true
  return false
}

/**
 * Gate for the clip-pin stand-down (READ_CLIP_PIN). Same shape as
 * autoOutlineOnElisionEnabled: the test-preload stubs every `feature()` to
 * `false`, so tests force-enable via `CLAUDIN_FORCE_READ_CLIP_PIN=1`;
 * production folds `feature('READ_CLIP_PIN')` at build time.
 */
function clipPinEnabled(): boolean {
  // DISABLE is an authoritative runtime killswitch — it wins even over the
  // test-only force flag, so a user can always turn the pin off.
  if (process.env.CLAUDIN_DISABLE_READ_CLIP_PIN === '1') return false
  // Accepted alias: this mechanism shipped as READ_RERUN_BREAKER, and the
  // rename would otherwise take a working killswitch away from anyone who had
  // already set it. Keep honoring it — it costs one env lookup.
  if (process.env.CLAUDIN_DISABLE_READ_RERUN_BREAKER === '1') return false
  if (process.env.CLAUDIN_FORCE_READ_CLIP_PIN === '1') return true
  if (feature('READ_CLIP_PIN')) return true
  return false
}

/** Lines / bytes of the file handed back with the non-code clip-pin fallback. */
const CLIP_PIN_HEAD_LINES = 60
const CLIP_PIN_HEAD_BYTES = 4_000

/**
 * How many futile stand-down re-sends of one (path, offset, limit) before the
 * fallback takes over, for the cases a pin cannot bound: contexts with no
 * toolUseId, and the killswitch path.
 *
 * Three, matching the breaker this feature replaced — the number was never the
 * problem with that breaker, the side-map it lived in was. Here the count sits
 * on the FileState entry, so it dies with the thing it describes.
 *
 * Exported so the tests state their bounds in terms of the constant rather
 * than a literal that would silently stop matching if it were retuned.
 */
export const STAND_DOWN_STRIKES = 3

/**
 * How many times the sticky stand-down marker may replay its outline for one
 * (path, offset, limit) before it is spent and Read re-arms with a real body.
 *
 * The marker exists because re-arming on EVERY fallback oscillates (two full
 * bodies every three reads when the pin cannot protect a round, four when it
 * can, forever). But re-arming NEVER is worse: the marker is written with
 * isPartialView, so Edit/Write/apply_patch/NotebookEdit refuse with "read it
 * first", and the replay returns without rewriting the entry — the model
 * cannot read its way out and cannot edit, in a file sitting readable on disk.
 * The budget keeps both bugs closed at once: bodies cost 2 per (budget + 3)
 * reads, and any refusal the marker causes lifts within `budget + 1` reads —
 * `budget` replays plus the fallback that wrote the marker.
 *
 * Three, deliberately the same as STAND_DOWN_STRIKES and for the same reason
 * the repeated-failure hint uses three: it is the point at which a model that
 * keeps re-reading is already being told it is repeating itself, so the body
 * arrives with the advice instead of long after it.
 */
export const STICKY_REPLAY_BUDGET = 3

/**
 * The code arm of the fallback still answers the question the model asked — a
 * structural outline is a real view of the file. The non-code arm had nothing
 * to offer and returned a bare redirect, so a model that asked to read a large
 * JSON/CSV/log got back zero bytes of it, which is worse than what the old
 * three-strike breaker did (two more full bodies first). Hand back the head of
 * the file with the redirect: it is content, it is what a human opens first,
 * and it is small enough to survive the clip paths that removed the full body.
 *
 * Best effort — a failure here must degrade to the bare redirect, never turn
 * the fallback into a read error.
 *
 * Line-numbered like every other Read result: the tool's own prompt promises
 * `N→content` on every line, and the redirect that follows tells the model to
 * go read a different part of the file — which it cannot aim at without
 * anchors.
 *
 * Notebooks are excluded. A `.ipynb` has no outline language, so it lands here,
 * but its first 60 lines are raw nbformat JSON — metadata and base64 image
 * outputs, not the cells a Read of that path returns. That is worse than
 * nothing: it looks like content, it is line-numbered like content, and the
 * line numbers do not correspond to anything the model can ask for. Send the
 * bare redirect instead.
 */
async function renderClipPinHeadSlice(
  fullFilePath: string,
  signal: AbortSignal,
): Promise<string> {
  if (fullFilePath.toLowerCase().endsWith('.ipynb')) return ''
  try {
    const { content } = await readFileInRange(
      fullFilePath,
      0,
      CLIP_PIN_HEAD_LINES,
      CLIP_PIN_HEAD_BYTES,
      signal,
      { truncateOnByteLimit: true },
    )
    if (content.length === 0) return ''
    return `${addLineNumbers({ content, startLine: 1 })}\n\n`
  } catch (e) {
    // An abort is the user cancelling, not a failed fallback — degrading it to
    // a bare redirect would hand the model a truncated answer for a request
    // that was called off, and log a phantom error. scanFile rethrows for the
    // same reason.
    if (isAbortError(e)) throw e
    logError(e)
    return ''
  }
}

export const CYBER_RISK_MITIGATION_REMINDER =
  '\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.\n</system-reminder>\n'

// Models where cyber risk mitigation should be skipped
const MITIGATION_EXEMPT_MODELS = new Set(['claude-opus-4-6', 'claude-opus-4-7'])

function shouldIncludeFileReadMitigation(): boolean {
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REMINDERS)) {
    return false
  }
  const shortName = getCanonicalName(getMainLoopModel())
  return !MITIGATION_EXEMPT_MODELS.has(shortName)
}

/**
 * Side-channel from call() to mapToolResultToToolResultBlockParam: mtime
 * of auto-memory files, keyed by the `data` object identity. Avoids
 * adding a presentation-only field to the output schema (which flows
 * into SDK types) and avoids sync fs in the mapper. WeakMap auto-GCs
 * when the data object becomes unreachable after rendering.
 */
const memoryFileMtimes = new WeakMap<object, number>()

function memoryFileFreshnessPrefix(data: object): string {
  const mtimeMs = memoryFileMtimes.get(data)
  if (mtimeMs === undefined) return ''
  return memoryFreshnessNote(mtimeMs)
}

// Side-channel from call() to mapToolResultToToolResultBlockParam: flag the
// `data` object whose tool_result should carry the serial-read nudge.
// Same pattern as memoryFileMtimes — keyed on data identity, GCs naturally.
const serialReadNudgeFlagged: WeakSet<object> = new WeakSet()

function shouldEmitSerialReadNudge(): boolean {
  if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REMINDERS)) return false
  // feature() from bun:bundle must appear directly in if/ternary; the build
  // preprocessor replaces it with a boolean literal before bundling.
  return feature('SERIAL_READ_NUDGE') ? true : false
}

/**
 * Inspects the recent assistant history on context.messages and, if the
 * serial-Read narration pattern is present and we haven't already fired
 * this turn, marks the data object so the mapper appends the nudge.
 *
 * Only applies to plain `text` reads — that's the path that carries the
 * narration cost in practice. Outline/image/PDF/notebook/file_unchanged
 * results stay clean.
 */
function maybeFlagSerialReadNudge(
  data: unknown,
  context: ToolUseContext,
): void {
  if (!shouldEmitSerialReadNudge()) return
  if (!data || typeof data !== 'object') return
  // Limit injection to the standard text read result; the nudge talks about
  // "sequential single-file Reads", so attaching it to an outline/image/PDF
  // would be off-message.
  const type = (data as { type?: string }).type
  if (type !== 'text') return
  const messages = context.messages
  if (!Array.isArray(messages)) return
  if (!detectSerialReadPattern(messages)) return
  if (!markFiredAndCheck(messages)) return
  serialReadNudgeFlagged.add(data as object)
}

async function validateContentTokens(
  content: string,
  ext: string,
  maxTokens?: number,
): Promise<void> {
  const effectiveMaxTokens =
    maxTokens ?? getDefaultFileReadingLimits().maxTokens

  const tokenEstimate = roughTokenCountEstimationForFileType(content, ext)
  if (!tokenEstimate || tokenEstimate <= effectiveMaxTokens / 4) return

  const tokenCount = await countTokensWithAPI(content)
  const effectiveCount = tokenCount ?? tokenEstimate

  if (effectiveCount > effectiveMaxTokens) {
    throw new MaxFileReadTokenExceededError(effectiveCount, effectiveMaxTokens)
  }
}

type ImageResult = {
  type: 'image'
  file: {
    base64: string
    type: Base64ImageSource['media_type']
    originalSize: number
    dimensions?: ImageDimensions
    // Absolute path on disk. Optional for backward compatibility with
    // serialized tool results (older snapshots won't have it). The UI
    // layer uses this for inline rendering on Kitty-family terminals;
    // absence falls back to the legacy text display.
    filePath?: string
  }
}

function createImageResponse(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
  dimensions?: ImageDimensions,
  filePath?: string,
): ImageResult {
  return {
    type: 'image',
    file: {
      base64: buffer.toString('base64'),
      type: `image/${mediaType}` as Base64ImageSource['media_type'],
      originalSize,
      dimensions,
      filePath,
    },
  }
}

/**
 * Inner implementation of call, separated to allow ENOENT handling in the outer call.
 */
type ScannedFile = {
  /** Full file content split into lines — the basis scanSymbols computed on. */
  lines: string[]
  /** Raw file content (capped at SCAN_MAX_BYTES). */
  source: string
  entries: SymbolEntry[]
  mtimeMs: number
  /** true when the read was byte-capped — the scan only saw the head. */
  truncated: boolean
}

/**
 * Options for {@link scanFile}. `preloaded` reuses source already in memory
 * (the line-count auto-pivot path) to avoid a redundant disk read; `maxBytes`
 * lets a test inject a tiny scan cap to exercise the truncation flag without a
 * real multi-megabyte fixture.
 */
type ScanFileOptions = {
  preloaded?: { source: string; mtimeMs: number; truncated?: boolean }
  maxBytes?: number
}

/**
 * Reads a file in full and scans its symbol table. Returns null when the scan
 * yields nothing (unsupported shape, parse failure) so callers degrade to a
 * normal Read. Abort errors propagate; other read errors fail open as null.
 *
 * Exported for the truncation unit test, which injects a tiny `maxBytes` to
 * exercise the byte-cap `truncated` flag without a real multi-MB fixture.
 */
export async function scanFile(
  resolvedFilePath: string,
  lang: OutlineLang,
  signal: AbortSignal,
  options: ScanFileOptions = {},
): Promise<ScannedFile | null> {
  let source: string
  let mtimeMs: number
  let truncated: boolean
  if (options.preloaded) {
    source = options.preloaded.source
    mtimeMs = options.preloaded.mtimeMs
    truncated = options.preloaded.truncated ?? false
  } else {
    try {
      const res = await readFileInRange(
        resolvedFilePath,
        0,
        undefined,
        options.maxBytes ?? SCAN_MAX_BYTES,
        signal,
        { truncateOnByteLimit: true },
      )
      source = res.content
      mtimeMs = res.mtimeMs
      truncated = res.truncatedByBytes ?? false
    } catch (e) {
      if (isAbortError(e)) throw e
      logError(e)
      return null
    }
  }
  const entries = scanSymbols(source, lang)
  if (entries.length === 0) return null
  const lines = source.split('\n')
  // Drop the phantom empty element a trailing newline produces, so outline
  // totalLines matches the text-read line count (cat -n semantics). Symbol
  // line ranges are unaffected — they only ever point at real lines.
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return { lines, source, entries, mtimeMs, truncated }
}

/**
 * Exact symbol lookup. On a name collision prefers the shallowest (top-level);
 * on a depth tie prefers the widest line span — for overloaded TS functions
 * this picks the implementation (which has a body) over the bare signatures.
 */
function findSymbolEntry(
  entries: SymbolEntry[],
  name: string,
): SymbolEntry | null {
  let best: SymbolEntry | null = null
  for (const e of entries) {
    if (e.name !== name) continue
    if (best === null || e.depth < best.depth) {
      best = e
    } else if (
      e.depth === best.depth &&
      e.endLine - e.startLine > best.endLine - best.startLine
    ) {
      best = e
    }
  }
  return best
}

function formatSymbolList(names: string[]): string {
  const shown = names.slice(0, 15)
  const suffix =
    names.length > shown.length ? `, … (${names.length} total)` : ''
  return shown.join(', ') + suffix
}

/**
 * Builds the 'outline' result. The model has NOT seen real file content — only
 * the skeleton — so the cache entry is marked partial (Edit/Write will require
 * a fresh Read). Per FileState convention, `content` holds raw disk bytes.
 */
function makeOutlineData(
  scanned: ScannedFile,
  file_path: string,
  fullFilePath: string,
  readFileState: ToolUseContext['readFileState'],
  overCap: boolean,
  autoPivot = false,
): { data: Output } {
  const content = renderOutline(
    scanned.entries,
    file_path,
    scanned.lines.length,
    { overCap, truncated: scanned.truncated },
  )
  readFileState.set(fullFilePath, {
    content: scanned.source,
    timestamp: Math.floor(scanned.mtimeMs),
    offset: undefined,
    limit: undefined,
    isPartialView: true,
  })
  return {
    data: {
      type: 'outline' as const,
      file: {
        filePath: file_path,
        content,
        totalLines: scanned.lines.length,
        symbolCount: scanned.entries.length,
        ...(autoPivot ? { autoPivot: true } : {}),
      },
    },
  }
}

/**
 * Builds the 'unfold' result: one symbol's body as a normal partial Read. The
 * model has seen these exact lines, so the cache entry is NOT partial —
 * Edit/Write stay unblocked. Line numbering is applied downstream from
 * `startLine`, so the model sees the symbol's real line numbers.
 */
function makeUnfoldData(
  scanned: ScannedFile,
  entry: SymbolEntry,
  file_path: string,
  fullFilePath: string,
  readFileState: ToolUseContext['readFileState'],
  toolUseId: string | undefined,
): { data: Output } {
  const slice = scanned.lines
    .slice(entry.startLine - 1, entry.endLine)
    .join('\n')
  const numLines = entry.endLine - entry.startLine + 1
  readFileState.set(fullFilePath, {
    content: slice,
    timestamp: Math.floor(scanned.mtimeMs),
    offset: entry.startLine,
    limit: numLines,
    toolUseId,
  })
  return {
    data: {
      type: 'text' as const,
      file: {
        filePath: file_path,
        content: slice,
        numLines,
        startLine: entry.startLine,
        totalLines: scanned.lines.length,
      },
    },
  }
}

async function callInner(
  file_path: string,
  fullFilePath: string,
  resolvedFilePath: string,
  ext: string,
  offset: number,
  limit: number | undefined,
  pages: string | undefined,
  view: 'outline' | 'full' | undefined,
  symbol: string | undefined,
  maxSizeBytes: number,
  maxTokens: number,
  readFileState: ToolUseContext['readFileState'],
  context: ToolUseContext,
  messageId: string | undefined,
): Promise<{
  data: Output
  newMessages?: ReturnType<typeof createUserMessage>[]
}> {
  // --- Notebook ---
  if (ext === 'ipynb') {
    const cells = await readNotebook(resolvedFilePath)
    const cellsJson = jsonStringify(cells)

    const cellsJsonBytes = Buffer.byteLength(cellsJson)
    if (cellsJsonBytes > maxSizeBytes) {
      throw new Error(
        `Notebook content (${formatFileSize(cellsJsonBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). ` +
          `Use ${BASH_TOOL_NAME} with jq to read specific portions:\n` +
          `  cat "${file_path}" | jq '.cells[:20]' # First 20 cells\n` +
          `  cat "${file_path}" | jq '.cells[100:120]' # Cells 100-120\n` +
          `  cat "${file_path}" | jq '.cells | length' # Count total cells\n` +
          `  cat "${file_path}" | jq '.cells[] | select(.cell_type=="code") | .source' # All code sources`,
      )
    }

    await validateContentTokens(cellsJson, ext, maxTokens)

    // Get mtime via async stat (single call, no prior existence check)
    const stats = await getFsImplementation().stat(resolvedFilePath)
    readFileState.set(fullFilePath, {
      content: cellsJson,
      timestamp: Math.floor(stats.mtimeMs),
      offset,
      limit,
      toolUseId: context.toolUseId,
    })
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    const data = {
      type: 'notebook' as const,
      file: { filePath: file_path, cells },
    }

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: cellsJson,
    })

    return { data }
  }

  // --- Image (single read, no double-read) ---
  if (IMAGE_EXTENSIONS.has(ext)) {
    // Images have their own size limits (token budget + compression) —
    // don't apply the text maxSizeBytes cap.
    const data = await readImageWithTokenBudget(resolvedFilePath, maxTokens)
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: data.file.base64,
    })

    const metadataText = data.file.dimensions
      ? createImageMetadataText(data.file.dimensions)
      : null

    return {
      data,
      ...(metadataText && {
        newMessages: [
          createUserMessage({ content: metadataText, isMeta: true }),
        ],
      }),
    }
  }

  // --- PDF ---
  if (isPDFExtension(ext)) {
    if (pages) {
      const parsedRange = parsePDFPageRange(pages)
      const extractResult = await extractPDFPages(
        resolvedFilePath,
        parsedRange ?? undefined,
      )
      if (!extractResult.success) {
        throw new Error(extractResult.error.message)
      }
      logEvent('tengu_pdf_page_extraction', {
        success: true,
        pageCount: extractResult.data.file.count,
        fileSize: extractResult.data.file.originalSize,
        hasPageRange: true,
      })
      logFileOperation({
        operation: 'read',
        tool: 'FileReadTool',
        filePath: fullFilePath,
        content: `PDF pages ${pages}`,
      })
      const entries = await readdir(extractResult.data.file.outputDir)
      const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
      const imageBlocks = await Promise.all(
        imageFiles.map(async f => {
          const imgPath = path.join(extractResult.data.file.outputDir, f)
          const imgBuffer = await readFileAsync(imgPath)
          const resized = await maybeResizeAndDownsampleImageBuffer(
            imgBuffer,
            imgBuffer.length,
            'jpeg',
          )
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type:
                `image/${resized.mediaType}` as Base64ImageSource['media_type'],
              data: resized.buffer.toString('base64'),
            },
          }
        }),
      )
      return {
        data: extractResult.data,
        ...(imageBlocks.length > 0 && {
          newMessages: [
            createUserMessage({ content: imageBlocks, isMeta: true }),
          ],
        }),
      }
    }

    const pageCount = await getPDFPageCount(resolvedFilePath)
    if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      throw new Error(
        `This PDF has ${pageCount} pages, which is too many to read at once. ` +
          `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
          `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      )
    }

    const fs = getFsImplementation()
    const stats = await fs.stat(resolvedFilePath)
    const shouldExtractPages =
      !isPDFSupported() || stats.size > PDF_EXTRACT_SIZE_THRESHOLD

    if (shouldExtractPages) {
      const extractResult = await extractPDFPages(resolvedFilePath)
      if (extractResult.success) {
        logEvent('tengu_pdf_page_extraction', {
          success: true,
          pageCount: extractResult.data.file.count,
          fileSize: extractResult.data.file.originalSize,
        })
      } else {
        logEvent('tengu_pdf_page_extraction', {
          success: false,
          available: extractResult.error.reason !== 'unavailable',
          fileSize: stats.size,
        })
      }
    }

    if (!isPDFSupported()) {
      throw new Error(
        'Reading full PDFs is not supported with this model. Use a newer model (Sonnet 3.5 v2 or later), ' +
          `or use the pages parameter to read specific page ranges (e.g., pages: "1-5", maximum ${PDF_MAX_PAGES_PER_READ} pages per request). ` +
          'Page extraction requires poppler-utils: install with `brew install poppler` on macOS or `apt-get install poppler-utils` on Debian/Ubuntu.',
      )
    }

    const readResult = await readPDF(resolvedFilePath)
    if (!readResult.success) {
      throw new Error(readResult.error.message)
    }
    const pdfData = readResult.data
    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: pdfData.file.base64,
    })

    return {
      data: pdfData,
      newMessages: [
        createUserMessage({
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfData.file.base64,
              },
            },
          ],
          isMeta: true,
        }),
      ],
    }
  }

  // --- Smart Code Navigation: outline / unfold views ---
  // Precedence: symbol > view > offset/limit. Honoured at any file size.
  const outlineLang = detectOutlineLangFromPath(fullFilePath)
  const signal = context.abortController.signal

  if (outlineLang && symbol !== undefined) {
    const scanned = await scanFile(resolvedFilePath, outlineLang, signal)
    if (scanned) {
      const entry = findSymbolEntry(scanned.entries, symbol)
      if (!entry) {
        throw new Error(
          `Symbol '${symbol}' not found in ${file_path}. ` +
            `Available symbols: ${formatSymbolList(scanned.entries.map(e => e.name))}. ` +
            `Call Read(file_path, view='outline') to see the full structure.`,
        )
      }
      return makeUnfoldData(
        scanned,
        entry,
        file_path,
        fullFilePath,
        readFileState,
        context.toolUseId,
      )
    }
    // scan empty — degrade to a normal read
  }

  if (outlineLang && view === 'outline') {
    const scanned = await scanFile(resolvedFilePath, outlineLang, signal)
    if (scanned) {
      return makeOutlineData(
        scanned,
        file_path,
        fullFilePath,
        readFileState,
        false,
      )
    }
    // scan empty — degrade to a normal read
  }

  // --- Text file (single async read via readFileInRange) ---
  // offset is normalized to >= 1 in call() before reaching here.
  const lineOffset = offset - 1
  let readResult: ReadFileRangeResult
  try {
    readResult = await readFileInRange(
      resolvedFilePath,
      lineOffset,
      limit,
      limit === undefined ? maxSizeBytes : undefined,
      signal,
    )
    await validateContentTokens(readResult.content, ext, maxTokens)
  } catch (e) {
    // Over-cap auto-outline: a plain Read that blew the byte or token cap
    // becomes a structural outline instead of a dead-end error. Only when
    // no explicit view/symbol was requested and the file is a code file.
    if (
      outlineLang &&
      symbol === undefined &&
      view === undefined &&
      (e instanceof FileTooLargeError ||
        e instanceof MaxFileReadTokenExceededError)
    ) {
      const scanned = await scanFile(resolvedFilePath, outlineLang, signal)
      if (scanned) {
        return makeOutlineData(
          scanned,
          file_path,
          fullFilePath,
          readFileState,
          true,
        )
      }
    }
    throw e
  }

  const { content, lineCount, totalLines, totalBytes, readBytes, mtimeMs } =
    readResult

  // AUTO_OUTLINE_ON_ELISION: a vanilla full-file Read of a large code file
  // (≥ READ_AUTO_OUTLINE_THRESHOLD_CHARS) returns a structural outline
  // instead of the full body. With a large literal body in tool_result Opus
  // 4.8 reliably starts narrating ("preciso do trecho do meio") and re-Reads
  // in smaller windows — by far the dominant narration pattern in bench
  // samples. Returning the outline removes the stimulus entirely; the
  // appended footer tells the model how to opt back in to the full body.
  //
  // Skip when the caller already targeted a slice (offset/limit), explicitly
  // asked for the full body (view==='full'), asked for outline themselves
  // (handled above), pinned a symbol, or the file is below both thresholds.
  //
  // Two triggers share one scan: the char trigger pivots on any symbol table;
  // the line trigger additionally requires ≥ READ_AUTO_OUTLINE_MIN_SYMBOLS so
  // a long single-function file still returns its body. The scan reuses the
  // in-memory `content` (a full read, since offset===1 && limit===undefined)
  // to avoid a redundant disk read.
  if (
    autoOutlineOnElisionEnabled() &&
    outlineLang &&
    symbol === undefined &&
    view === undefined &&
    offset === 1 &&
    limit === undefined
  ) {
    const charTrigger = content.length >= READ_AUTO_OUTLINE_THRESHOLD_CHARS
    const lineTrigger = totalLines >= READ_AUTO_OUTLINE_THRESHOLD_LINES
    if (charTrigger || lineTrigger) {
      const scanned = await scanFile(resolvedFilePath, outlineLang, signal, {
        preloaded: {
          source: content,
          mtimeMs,
          truncated: readResult.truncatedByBytes ?? false,
        },
      })
      if (
        scanned &&
        (charTrigger ||
          scanned.entries.length >= READ_AUTO_OUTLINE_MIN_SYMBOLS)
      ) {
        return makeOutlineData(
          scanned,
          file_path,
          fullFilePath,
          readFileState,
          true,
          true,
        )
      }
      // below the symbol gate (or scan empty) — fall through to the full body
    }
  }

  readFileState.set(fullFilePath, {
    content,
    timestamp: Math.floor(mtimeMs),
    offset,
    limit,
    toolUseId: context.toolUseId,
  })
  context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

  // Snapshot before iterating — a listener that unsubscribes mid-callback
  // would splice the live array and skip the next listener.
  for (const listener of fileReadListeners.slice()) {
    listener(resolvedFilePath, content)
  }

  const data = {
    type: 'text' as const,
    file: {
      filePath: file_path,
      content,
      numLines: lineCount,
      startLine: offset,
      totalLines,
    },
  }
  if (isAutoMemFile(fullFilePath)) {
    memoryFileMtimes.set(data, mtimeMs)
  }

  logFileOperation({
    operation: 'read',
    tool: 'FileReadTool',
    filePath: fullFilePath,
    content,
  })

  const sessionFileType = detectSessionFileType(fullFilePath)
  const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
  logEvent('tengu_session_file_read', {
    totalLines,
    readLines: lineCount,
    totalBytes,
    readBytes,
    offset,
    ...(limit !== undefined && { limit }),
    ...(analyticsExt !== undefined && { ext: analyticsExt }),
    ...(messageId !== undefined && {
      messageID:
        messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    is_session_memory: sessionFileType === 'session_memory',
    is_session_transcript: sessionFileType === 'session_transcript',
  })

  return { data }
}

/**
 * Reads an image file and applies token-based compression if needed.
 * Reads the file ONCE, then applies standard resize. If the result exceeds
 * the token limit, applies aggressive compression from the same buffer.
 *
 * @param filePath - Path to the image file
 * @param maxTokens - Maximum token budget for the image
 * @returns Image data with appropriate compression applied
 */
export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number = getDefaultFileReadingLimits().maxTokens,
  maxBytes?: number,
): Promise<ImageResult> {
  // Read file ONCE — capped to maxBytes to avoid OOM on huge files
  const imageBuffer = await getFsImplementation().readFileBytes(
    filePath,
    maxBytes,
  )
  const originalSize = imageBuffer.length

  if (originalSize === 0) {
    throw new Error(`Image file is empty: ${filePath}`)
  }

  const detectedMediaType = detectImageFormatFromBuffer(imageBuffer)
  const detectedFormat = detectedMediaType.split('/')[1] || 'png'

  // Try standard resize
  let result: ImageResult
  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      originalSize,
      detectedFormat,
    )
    result = createImageResponse(
      resized.buffer,
      resized.mediaType,
      originalSize,
      resized.dimensions,
      filePath,
    )
  } catch (e) {
    if (e instanceof ImageResizeError) throw e
    logError(e)
    result = createImageResponse(
      imageBuffer,
      detectedFormat,
      originalSize,
      undefined,
      filePath,
    )
  }

  // Check if it fits in token budget
  const estimatedTokens = Math.ceil(result.file.base64.length * 0.125)
  if (estimatedTokens > maxTokens) {
    // Aggressive compression from the SAME buffer (no re-read)
    try {
      const compressed = await compressImageBufferWithTokenLimit(
        imageBuffer,
        maxTokens,
        detectedMediaType,
      )
      return {
        type: 'image',
        file: {
          base64: compressed.base64,
          type: compressed.mediaType,
          originalSize,
          filePath,
        },
      }
    } catch (e) {
      logError(e)
      // Fallback: heavily compressed version from the SAME buffer
      try {
        const sharpModule = await import('sharp')
        const sharp =
          (
            sharpModule as {
              default?: typeof sharpModule
            } & typeof sharpModule
          ).default || sharpModule

        const fallbackBuffer = await sharp(imageBuffer)
          .resize(400, 400, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 20 })
          .toBuffer()

        return createImageResponse(
          fallbackBuffer,
          'jpeg',
          originalSize,
          undefined,
          filePath,
        )
      } catch (error) {
        logError(error)
        return createImageResponse(
          imageBuffer,
          detectedFormat,
          originalSize,
          undefined,
          filePath,
        )
      }
    }
  }

  return result
}
