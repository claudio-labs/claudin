import { dirname, isAbsolute, sep } from 'path'
import { diagnosticTracker } from 'src/platform/diagnosticTracking.js'
import {
  armFileForLateDiagnostics,
  buildPostEditDiagnosticsMessages,
} from 'src/platform/lsp/diagnosticsForToolResult.js'
import { forgetDiagnosticsForEditedFile } from 'src/platform/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from 'src/platform/lsp/manager.js'
import { notifyVscodeFileUpdated } from 'src/mcp/vscodeSdkMcp.js'
import {
  checkMemoryFileFormat,
  indexTextFromResponse,
  isMemoryWriteTarget,
  memoryWriteNotes,
  notesToAdvice,
} from 'src/memory/memdir/memoryFormatGuard.js'
import { checkTeamMemSecrets } from 'src/memory/memdir/teamMemSecretGuard.js'
import { isSessionMemoryIndex } from 'src/memory/memdir/memoryDirs.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from 'src/skills/loadSkillsDir.js'
import type { ToolUseContext, ValidationResult } from 'src/tools/Tool.js'
import { buildTool, type ToolDef } from 'src/tools/Tool.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { logForDebugging } from 'src/shared/debug.js'
import { countLinesChanged } from 'src/vcs/git/diff.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isENOENT } from 'src/shared/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  suggestPathUnderCwd,
  writeTextContent,
} from 'src/shared/fs/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from 'src/shared/fs/fileHistory.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from 'src/shared/fs/fileRead.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { logError } from 'src/shared/log.js'
import { expandPath } from 'src/shared/fs/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from 'src/permissions/filePermissions.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { matchWildcardPattern } from 'src/permissions/shellRuleMatching.js'
import { validateInputForSettingsFileEdit } from 'src/platform/settings/validateEditTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import {
  foldThenPermission,
  formatThen,
  resolveThen,
  runThen,
  takeThenSkipNote,
  thenClassifierInput,
} from 'src/tools/shared/editThen/editThen.js'
import { thenCommands } from 'src/tools/shared/editThen/editThenShape.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import {
  appliedUnreadNote,
  FILE_NOT_READ_ERROR,
  unreadRefusal,
} from 'src/tools/shared/readBeforeEditMessages.js'
import {
  fileLinesOf,
  locateExactText,
  occurrenceLines,
} from 'src/tools/shared/servedRegion.js'
import {
  describeDivergence,
  NOWHERE_REMEDY,
} from 'src/tools/shared/blockMismatch.js'
import { getEditToolDescription } from 'src/tools/FileEditTool/prompt.js'
import {
  type FileEditInput,
  type FileEditOutput,
  inputSchema,
  outputSchema,
} from 'src/tools/FileEditTool/types.js'
import {
  getToolUseSummary,
  renderGroupedFileEditToolUse,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from 'src/tools/FileEditTool/UI.js'
import {
  applyEditToFile,
  areFileEditsInputsEquivalent,
  editedFile,
  findActualString,
  getPatchForEdit,
  preserveQuoteStyle,
  resolveFuzzyEdit,
} from 'src/tools/FileEditTool/utils.js'

// V8/Bun string length limit is ~2^30 characters (~1 billion). For typical
// ASCII/Latin-1 files, 1 byte on disk = 1 character, so 1 GiB in stat bytes
// ≈ 1 billion characters ≈ the runtime string limit. Multi-byte UTF-8 files
// can be larger on disk per character, but 1 GiB is a safe byte-level guard
// that prevents OOM without being unnecessarily restrictive.
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB (stat bytes)

/**
 * Why a file never read was not edited (readBeforeEditMessages.ts, in-place
 * writes), naming how often old_string does occur so the retry knows whether
 * to Read or to widen it. It opens with FILE_NOT_READ_ERROR ("…before writing
 * to it", not "editing") because UI.tsx picks its one-liner on that constant.
 */
function unreadRefusalFor(file: string, oldString: string): string {
  const count = occurrenceLines(file, oldString).length
  const occurs = count === 0 ? 'does not occur in it' : `occurs in it ${count} times`
  return unreadRefusal(FILE_NOT_READ_ERROR, `old_string ${occurs}`, 'edited')
}

/**
 * Why old_string is not in the file, as Patch says it of a hunk
 * (blockMismatch.ts): where it stops agreeing with the file, or that it
 * matches nowhere. It never echoes old_string, which the model just sent.
 */
function notFoundMessage(file: string, oldString: string): string {
  const divergence = describeDivergence(file.split('\n'), fileLinesOf(oldString), 0, 'old_string')
  return divergence
    ? `String to replace not found in file.\n${divergence}`
    : `String to replace not found in file. ${NOWHERE_REMEDY}`
}

/** Several places old_string matches, by line, so the retry can pick one. */
function multipleMatchesMessage(lines: number[]): string {
  return `Found ${lines.length} matches of the string to replace, at lines ${lines.join(', ')}, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.`
}

/**
 * The format guard's verdict (memoryFormatGuard.ts) on the whole file as the
 * Edit leaves it — `new_string` when it creates the file, the file with the
 * replacement applied otherwise — so a memory file gets the verdict a Write
 * or a Patch of the same content gets.
 */
function memoryFormatVerdict(fullFilePath: string, content: string): ValidationResult {
  const formatError = checkMemoryFileFormat(fullFilePath, content)
  return formatError ? { result: false, message: formatError, errorCode: 0 } : { result: true }
}

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  searchHint: 'modify file contents in place',
  maxResultSizeChars: 100_000,
  clearableInputFields: ['old_string', 'new_string'],
  async description() {
    return 'A tool for editing files'
  },
  async prompt() {
    return getEditToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Editing ${summary}` : 'Editing file'
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return thenClassifierInput(`${input.file_path}: ${input.new_string}`, input)
  },
  getPath(input): string {
    return input.file_path
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
  async resolveInput(input, context) {
    return { ok: true, input: await resolveThen(input, context) }
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return foldThenPermission(
      input,
      checkWritePermissionForTool(FileEditTool, input, appState.toolPermissionContext),
      context,
    )
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderGroupedToolUse: renderGroupedFileEditToolUse,
  async validateInput(input: FileEditInput, toolUseContext: ToolUseContext) {
    const { file_path, old_string, new_string, replace_all = false } = input
    // Use expandPath for consistent path normalization (especially on Windows
    // where "/" vs "\" can cause readFileState lookup mismatches)
    const fullFilePath = expandPath(file_path)

    // Reject edits to team memory files that introduce secrets
    const secretError = checkTeamMemSecrets(fullFilePath, new_string)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }
    if (old_string === new_string) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'No changes to make: old_string and new_string are exactly the same.',
        errorCode: 1,
      }
    }

    // Check if path should be ignored based on permission settings
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 2,
      }
    }

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // On Windows, fs.existsSync() on UNC paths triggers SMB authentication which could
    // leak credentials to malicious servers. Let the permission check handle UNC paths.
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()

    // Prevent OOM on multi-GB files.
    try {
      const { size } = await fs.stat(fullFilePath)
      if (size > MAX_EDIT_FILE_SIZE) {
        return {
          result: false,
          behavior: 'ask',
          message: `File is too large to edit (${formatFileSize(size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
          errorCode: 10,
        }
      }
    } catch (e) {
      if (!isENOENT(e)) {
        throw e
      }
    }

    // Read the file as bytes first so we can detect encoding from the buffer
    // instead of calling detectFileEncoding (which does its own sync readSync
    // and would fail with a wasted ENOENT when the file doesn't exist).
    let fileContent: string | null
    try {
      const fileBuffer = await fs.readFileBytes(fullFilePath)
      const encoding: BufferEncoding =
        fileBuffer.length >= 2 &&
        fileBuffer[0] === 0xff &&
        fileBuffer[1] === 0xfe
          ? 'utf16le'
          : 'utf8'
      fileContent = fileBuffer.toString(encoding).replaceAll('\r\n', '\n')
    } catch (e) {
      if (isENOENT(e)) {
        fileContent = null
      } else {
        throw e
      }
    }

    // File doesn't exist
    if (fileContent === null) {
      // Empty old_string on nonexistent file means new file creation — valid
      if (old_string === '') {
        return memoryFormatVerdict(fullFilePath, new_string)
      }
      // Try to find a similar file with a different extension
      const similarFilename = findSimilarFile(fullFilePath)
      const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
      let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`

      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        behavior: 'ask',
        message,
        errorCode: 4,
      }
    }

    // File exists with empty old_string — only valid if file is empty
    if (old_string === '') {
      // Only reject if the file has content (for file creation attempt)
      if (fileContent.trim() !== '') {
        return {
          result: false,
          behavior: 'ask',
          message: 'Cannot create new file - file already exists.',
          errorCode: 3,
        }
      }

      // Empty file with empty old_string is valid - we're replacing empty with content
      return memoryFormatVerdict(fullFilePath, new_string)
    }

    if (fullFilePath.endsWith('.ipynb')) {
      return {
        result: false,
        behavior: 'ask',
        message: `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
        errorCode: 5,
      }
    }

    // An in-place write, like Patch (readBeforeEditMessages.ts): any read of
    // the file authorizes it, and whether old_string is in the file as it is
    // now decides it below. A file never read is edited only when old_string
    // sits in it exactly once — the model wrote those bytes, so it saw them.
    // A memory index is in context from the first turn: it counts as read.
    if (
      toolUseContext.readFileState.get(fullFilePath) === undefined &&
      !isSessionMemoryIndex(fullFilePath) &&
      !locateExactText(fileContent, old_string)
    ) {
      return {
        result: false,
        behavior: 'ask',
        message: unreadRefusalFor(fileContent, old_string),
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 6,
      }
    }

    const file = fileContent

    // Use findActualString to handle quote normalization, then fall back to a
    // whitespace-tolerant line match (indentation/trailing-whitespace drift).
    let actualOldString = findActualString(file, old_string)
    // The effective replacement string; re-indented when the match is fuzzy so
    // the settings simulation below validates what will actually be written.
    let effectiveNewString = new_string
    let fuzzyMatched = false
    if (!actualOldString && !replace_all) {
      const fuzzy = resolveFuzzyEdit(file, old_string, new_string)
      if (fuzzy.kind === 'ambiguous') {
        return {
          result: false,
          behavior: 'ask',
          message: multipleMatchesMessage(fuzzy.lines),
          meta: {
            isFilePathAbsolute: String(isAbsolute(file_path)),
          },
          errorCode: 9,
        }
      }
      if (fuzzy.kind === 'match') {
        actualOldString = fuzzy.matchedOldString
        effectiveNewString = fuzzy.adjustedNewString
        fuzzyMatched = true
      }
    }
    if (!actualOldString) {
      return {
        result: false,
        behavior: 'ask',
        message: notFoundMessage(file, old_string),
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 8,
      }
    }

    const matches = occurrenceLines(file, actualOldString)

    // Check if we have multiple matches but replace_all is false
    if (matches.length > 1 && !replace_all) {
      return {
        result: false,
        behavior: 'ask',
        message: multipleMatchesMessage(matches),
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
          actualOldString,
        },
        errorCode: 9,
      }
    }

    // Additional validation for Claude settings files
    const settingsValidationResult = validateInputForSettingsFileEdit(
      fullFilePath,
      file,
      () => {
        // Simulate the edit to get the final content using the exact same logic as the tool
        return replace_all
          ? file.replaceAll(actualOldString, effectiveNewString)
          : file.replace(actualOldString, effectiveNewString)
      },
    )

    if (settingsValidationResult !== null) {
      return settingsValidationResult
    }

    // The file as call() will write it: the same replacement, the quote style
    // call() preserves, the trailing newline a deletion takes along
    const verdict = memoryFormatVerdict(
      fullFilePath,
      applyEditToFile(
        file,
        actualOldString,
        fuzzyMatched
          ? effectiveNewString
          : preserveQuoteStyle(old_string, actualOldString, new_string),
        replace_all,
      ),
    )
    if (!verdict.result) {
      return verdict
    }

    return { result: true, meta: { actualOldString } }
  },
  advise(input, context) {
    // An Edit that creates a memory file gets the index-line note a Write
    // gets (memoryFormatGuard.ts), one that changes a file does not; both
    // get the hygiene notes on what the edit leaves
    const path = expandPath(input.file_path)
    if (!isMemoryWriteTarget(path)) return null
    const creates = input.old_string === ''
    let onDisk: string | null
    try {
      const current = readFileForEdit(path)
      onDisk = current.fileExists ? current.content : null
    } catch {
      return null // an unreadable file is reported by the call
    }
    const content = creates
      ? onDisk === null ? input.new_string : null
      : onDisk === null ? null : editedFile(onDisk, input.old_string, input.new_string, input.replace_all ?? false)
    return notesToAdvice(
      memoryWriteNotes(
        path,
        { content, isNew: creates && onDisk === null, indexNote: creates },
        indexTextFromResponse(context.responseToolUses, getCwd()),
      ),
    )
  },
  inputsEquivalent(input1, input2) {
    return areFileEditsInputsEquivalent(
      {
        file_path: input1.file_path,
        edits: [
          {
            old_string: input1.old_string,
            new_string: input1.new_string,
            replace_all: input1.replace_all ?? false,
          },
        ],
      },
      {
        file_path: input2.file_path,
        edits: [
          {
            old_string: input2.old_string,
            new_string: input2.new_string,
            replace_all: input2.replace_all ?? false,
          },
        ],
      },
    )
  },
  async call(
    input: FileEditInput,
    context,
    _,
    parentMessage,
  ) {
    const {
      readFileState,
      userModified,
      updateFileHistoryState,
      dynamicSkillDirTriggers,
      agentId,
    } = context
    const { file_path, old_string, new_string, replace_all = false } = input

    // 1. Get current state
    const fs = getFsImplementation()
    const absoluteFilePath = expandPath(file_path)

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDIN_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths(
        [absoluteFilePath],
        cwd,
      )
      if (newSkillDirs.length > 0) {
        // Store discovered dirs for attachment display
        for (const dir of newSkillDirs) {
          dynamicSkillDirTriggers?.add(dir)
        }
        // Don't await - let skill loading happen in the background
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // Activate conditional skills whose path patterns match this file
      activateConditionalSkillsForPaths([absoluteFilePath], cwd)
    }

    await diagnosticTracker.beforeFileEditedCompat(absoluteFilePath)

    // Ensure parent directory exists before the atomic read-modify-write section.
    // These awaits must stay OUTSIDE the critical section below — a yield between
    // the staleness check and writeTextContent lets concurrent edits interleave.
    await fs.mkdir(dirname(absoluteFilePath))
    if (fileHistoryEnabled()) {
      // Backup captures pre-edit content — safe to call before the staleness
      // check (idempotent v1 backup keyed on content hash; if staleness fails
      // later we just have an unused backup, not corrupt state).
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        absoluteFilePath,
        parentMessage.uuid,
      )
    }

    // 2. Load current state. Whether old_string is still in it decides the
    // edit, not whether the file changed since it was read.
    // Please avoid async operations between here and writing to disk to preserve atomicity
    const {
      content: originalFileContents,
      fileExists,
      encoding,
      lineEndings: endings,
    } = readFileForEdit(absoluteFilePath)

    // A file never read: the check validateInput made, against the bytes
    // about to be replaced.
    const unread =
      fileExists &&
      readFileState.get(absoluteFilePath) === undefined &&
      !isSessionMemoryIndex(absoluteFilePath)
    if (unread && !locateExactText(originalFileContents, old_string)) {
      throw new Error(unreadRefusalFor(originalFileContents, old_string))
    }

    // 3. Use findActualString to handle quote normalization
    let actualOldString =
      findActualString(originalFileContents, old_string) || old_string

    // Preserve curly quotes in new_string when the file uses them
    let actualNewString = preserveQuoteStyle(
      old_string,
      actualOldString,
      new_string,
    )

    // Fall back to a whitespace-tolerant line match when the exact/quote-
    // normalized string is not literally present (indentation drift). Uses the
    // matched file bytes and re-indents new_string to the file's indentation.
    if (
      !replace_all &&
      old_string !== '' &&
      !originalFileContents.includes(actualOldString)
    ) {
      const fuzzy = resolveFuzzyEdit(
        originalFileContents,
        old_string,
        new_string,
      )
      if (fuzzy.kind === 'match') {
        actualOldString = fuzzy.matchedOldString
        actualNewString = fuzzy.adjustedNewString
      }
    }

    // validateInput counted the matches; a change since (another agent, the
    // user during the permission prompt) may have added one, and replace()
    // would then edit the first, which nobody chose.
    const matches = occurrenceLines(originalFileContents, actualOldString)
    if (!replace_all && matches.length > 1) {
      throw new Error(multipleMatchesMessage(matches))
    }

    // 4. Generate patch
    const { patch, updatedFile } = getPatchForEdit({
      filePath: absoluteFilePath,
      fileContents: originalFileContents,
      oldString: actualOldString,
      newString: actualNewString,
      replaceAll: replace_all,
    })

    // 5. Write to disk
    writeTextContent(absoluteFilePath, updatedFile, encoding, endings)

    // Notify LSP servers about file modification (didChange) and save (didSave)
    const lspManager = getLspServerManager()
    if (lspManager) {
      // Drop the file's pre-edit diagnostics so only the republish is shown
      forgetDiagnosticsForEditedFile(absoluteFilePath)
      // didChange: Content has been modified
      lspManager
        .changeFile(absoluteFilePath, updatedFile)
        .catch((err: Error) => {
          logForDebugging(
            `LSP: Failed to notify server of file change for ${absoluteFilePath}: ${err.message}`,
          )
          logError(err)
        })
      // didSave: File has been saved to disk (triggers diagnostics in TypeScript server)
      lspManager.saveFile(absoluteFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${absoluteFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // Notify VSCode about the file change for diff view
    notifyVscodeFileUpdated(absoluteFilePath, originalFileContents, updatedFile)

    // 6. Update read timestamp, to invalidate stale writes
    readFileState.set(absoluteFilePath, {
      content: updatedFile,
      timestamp: getFileModificationTime(absoluteFilePath),
      offset: undefined,
      limit: undefined,
    })

    countLinesChanged(patch)

    // 8. Yield result
    const data = {
      filePath: file_path,
      oldString: actualOldString,
      newString: new_string,
      originalFile: originalFileContents,
      structuredPatch: patch,
      userModified: userModified ?? false,
      replaceAll: replace_all,
      ...(unread && { unread }),
    }

    // Per-edit LSP diagnostic injection: wait briefly for the LSP server to
    // publish diagnostics for this file, then attach them so the model sees
    // errors in the same turn instead of next-turn via getLSPDiagnosticAttachments.
    // Silent skip if LSP is off, no server handles the language, or timeout.
    const diagnosticMessages =
      await buildPostEditDiagnosticsMessages(absoluteFilePath)

    // Arm this path for the tail-wait + re-engage that fires if the assistant
    // ends the turn without further tool calls — closes the third diagnostic
    // window (publish lands after per-edit timeout but before next prompt).
    armFileForLateDiagnostics(absoluteFilePath, agentId)

    // CLAUDIN_EDIT_THEN (editThen.ts): the check rides this call.
    const commands = thenCommands(input)
    const then = commands.length > 0 ? await runThen(commands, context) : undefined
    const thenNote = takeThenSkipNote(context)

    return {
      data: { ...data, ...(then && { then }), ...(thenNote && { thenNote }) },
      ...(diagnosticMessages.length > 0 && {
        newMessages: diagnosticMessages,
      }),
    }
  },
  mapToolResultToToolResultBlockParam(data: FileEditOutput, toolUseID) {
    const { filePath, userModified, replaceAll } = data
    const modifiedNote = userModified
      ? '.  The user modified your proposed changes before accepting them. '
      : ''
    const unreadNote = data.unread
      ? `\n${appliedUnreadNote(filePath, 'edited because old_string matched it exactly once')}`
      : ''
    const tail = unreadNote + formatThen(data.then, data.thenNote)

    if (replaceAll) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.${tail}`,
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated successfully${modifiedNote}.${tail}`,
    }
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, FileEditOutput>)

// --

function readFileForEdit(absoluteFilePath: string): {
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    const meta = readFileSyncWithMetadata(absoluteFilePath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
    }
  } catch (e) {
    if (isENOENT(e)) {
      return {
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      }
    }
    throw e
  }
}
