import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/index.mjs'
import { readdir, readFile as readFileAsync } from 'fs/promises'
import * as path from 'path'
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_EXTRACT_SIZE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from 'src/constants/apiLimits.js'
import { isAutoMemFile } from 'src/memdir/memoryFileDetection.js'
import { logEvent } from 'src/services/analytics/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  getFileExtensionForAnalytics,
} from 'src/services/analytics/metadata.js'
import { createUserMessage } from 'src/services/messages/messages.js'
import type { ToolUseContext } from 'src/Tool.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { detectOutlineLangFromPath } from 'src/tools/shared/codeOutline/scanSymbols.js'
import { logFileOperation } from 'src/utils/fileOperationAnalytics.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { readNotebook } from 'src/shared/fs/notebook.js'
import { extractPDFPages, getPDFPageCount, readPDF } from 'src/shared/fs/pdf.js'
import {
  isPDFExtension,
  isPDFSupported,
  parsePDFPageRange,
} from 'src/shared/fs/pdfUtils.js'
import {
  FileTooLargeError,
  type ReadFileRangeResult,
  readFileInRange,
} from 'src/shared/fs/readFileInRange.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBuffer,
} from 'src/terminal/image/imageResizer.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { formatFileSize } from 'src/shared/text/format.js'
import {
  detectSessionFileType,
  IMAGE_EXTENSIONS,
  MaxFileReadTokenExceededError,
  validateContentTokens,
} from 'src/tools/FileReadTool/guards.js'
import { readImageWithTokenBudget } from 'src/tools/FileReadTool/imageRead.js'
import {
  autoOutlineOnElisionEnabled,
  findSymbolEntry,
  formatSymbolList,
  makeOutlineData,
  makeUnfoldData,
  READ_AUTO_OUTLINE_MIN_SYMBOLS,
  READ_AUTO_OUTLINE_THRESHOLD_CHARS,
  READ_AUTO_OUTLINE_THRESHOLD_LINES,
  scanFile,
} from 'src/tools/FileReadTool/outlineView.js'
import { markMemoryFileMtime } from 'src/tools/FileReadTool/resultContent.js'
import type { Output } from 'src/tools/FileReadTool/schemas.js'

/**
 * Inner implementation of call, separated to allow ENOENT handling in the outer call.
 */
export async function callInner(
  file_path: string,
  fullFilePath: string,
  resolvedFilePath: string,
  ext: string,
  offset: number,
  limit: number | undefined,
  pages: string | undefined,
  view: 'outline' | 'full' | undefined,
  symbol: string | undefined,
  encoding: string | undefined,
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
    const scanned = await scanFile(resolvedFilePath, outlineLang, signal, {
      encoding,
    })
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
    const scanned = await scanFile(resolvedFilePath, outlineLang, signal, {
      encoding,
    })
    if (scanned) {
      return makeOutlineData(
        scanned,
        file_path,
        fullFilePath,
        readFileState,
        'explicit',
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
      { encoding },
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
      const scanned = await scanFile(resolvedFilePath, outlineLang, signal, {
        encoding,
      })
      if (scanned) {
        return makeOutlineData(
          scanned,
          file_path,
          fullFilePath,
          readFileState,
          'overcap',
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
          'pivot',
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
    markMemoryFileMtime(data, mtimeMs)
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
