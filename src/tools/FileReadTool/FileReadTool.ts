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
import { renderOutline } from '../shared/codeOutline/renderOutline.js'
import {
  detectOutlineLang,
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
            'True when this outline was produced by AUTO_OUTLINE_ON_ELISION because the vanilla full-body Read would have been head-tail elided. Triggers an extra footer hint in the tool_result.',
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
  async call(
    { file_path, offset = 1, limit = undefined, pages, view, symbol },
    context,
    _canUseTool?,
    parentMessage?,
  ) {
    const { readFileState, fileReadingLimits } = context

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
    const existingState = dedupKillswitch
      ? undefined
      : readFileState.get(fullFilePath)
    // Only dedup entries that came from a prior Read (offset is always set
    // by Read). Edit/Write store offset=undefined — their readFileState
    // entry reflects post-edit mtime, so deduping against it would wrongly
    // point the model at the pre-edit Read content.
    // Skip dedup for outline/unfold requests: they share the default
    // offset/limit with a prior full Read, so they would wrongly dedup-match
    // and return a file_unchanged stub instead of the requested view.
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
            }
          }
        } catch {
          // stat failed — fall through to full read
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
      maybeFlagSerialReadNudge(result?.data, context)
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
      case 'text': {
        let content: string

        if (data.file.content) {
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
              : `<system-reminder>Warning: the file exists but is shorter than the provided offset (${data.file.startLine}). The file has ${data.file.totalLines} lines.</system-reminder>`
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
function formatFileLines(file: { content: string; startLine: number }): string {
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
// Cap for the full read backing a symbol scan, aligned with readFileInRange's
// fast-path ceiling. Past it the scan still works on the truncated head.
const SCAN_MAX_BYTES = 10 * 1024 * 1024

type ScannedFile = {
  /** Full file content split into lines — the basis scanSymbols computed on. */
  lines: string[]
  /** Raw file content (capped at SCAN_MAX_BYTES). */
  source: string
  entries: SymbolEntry[]
  mtimeMs: number
}

/**
 * Reads a file in full and scans its symbol table. Returns null when the scan
 * yields nothing (unsupported shape, parse failure) so callers degrade to a
 * normal Read. Abort errors propagate; other read errors fail open as null.
 */
async function scanFile(
  resolvedFilePath: string,
  lang: OutlineLang,
  signal: AbortSignal,
): Promise<ScannedFile | null> {
  let source: string
  let mtimeMs: number
  try {
    const res = await readFileInRange(
      resolvedFilePath,
      0,
      undefined,
      SCAN_MAX_BYTES,
      signal,
      { truncateOnByteLimit: true },
    )
    source = res.content
    mtimeMs = res.mtimeMs
  } catch (e) {
    if (isAbortError(e)) throw e
    logError(e)
    return null
  }
  const entries = scanSymbols(source, lang)
  if (entries.length === 0) return null
  return { lines: source.split('\n'), source, entries, mtimeMs }
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
    { overCap },
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
  const outlineLang = detectOutlineLang(ext)
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
  const lineOffset = offset === 0 ? 0 : offset - 1
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
  // (handled above), pinned a symbol, or the file is below the threshold.
  if (
    autoOutlineOnElisionEnabled() &&
    outlineLang &&
    symbol === undefined &&
    view === undefined &&
    offset === 1 &&
    limit === undefined &&
    content.length >= READ_AUTO_OUTLINE_THRESHOLD_CHARS
  ) {
    const scanned = await scanFile(resolvedFilePath, outlineLang, signal)
    if (scanned) {
      return makeOutlineData(
        scanned,
        file_path,
        fullFilePath,
        readFileState,
        true,
        true,
      )
    }
    // scan empty — fall through to the normal text return below
  }

  readFileState.set(fullFilePath, {
    content,
    timestamp: Math.floor(mtimeMs),
    offset,
    limit,
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
