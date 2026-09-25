import * as path from 'path'
import { PDF_MAX_PAGES_PER_READ } from 'src/shared/constants/apiLimits.js'
import { hasBinaryExtension } from 'src/shared/constants/files.js'
import {
  checkReadPermissionForTool,
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from 'src/permissions/filePermissions.js'
import { checkBatchReadPermission } from 'src/permissions/filePermissions/readWriteChecks.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { matchWildcardPattern } from 'src/permissions/shellRuleMatching.js'
import {
  exceedsPinnedResultCeiling,
  getStandDownEpoch,
  isPinRegistered,
  isPinShielding,
  pinToolResult,
  retirePinAfterUse,
} from 'src/agent/compact/stableStubState.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from 'src/skills/loadSkillsDir.js'
import type {
  ToolResult,
  ToolUseContext,
  ValidationResult,
} from 'src/tools/Tool.js'
import { buildTool, type ToolDef } from 'src/tools/Tool.js'
import { renderOutline } from 'src/tools/shared/codeOutline/renderOutline.js'
import { detectOutlineLangFromPath } from 'src/tools/shared/codeOutline/scanSymbols.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { getErrnoCode, isENOENT, isFsInaccessible } from 'src/shared/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  getFileModificationTimeAsync,
  suggestPathUnderCwd,
} from 'src/shared/fs/file.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { extractGlobBaseDirectory, glob } from 'src/shared/fs/glob.js'
import { expandPath } from 'src/shared/fs/path.js'
import { isPDFExtension, parsePDFPageRange } from 'src/shared/fs/pdfUtils.js'
import { assertKnownEncoding } from 'src/shared/fs/textEncoding.js'
import { logError } from 'src/shared/log.js'
import { isPriorReadClippedOrMissing } from 'src/tools/FileReadTool/clientClippingDetection.js'
import {
  clipPinEnabled,
  renderClipPinHeadSlice,
  STAND_DOWN_STRIKES,
  STICKY_REPLAY_BUDGET,
} from 'src/tools/FileReadTool/clipPin.js'
import {
  getAlternateScreenshotPath,
  IMAGE_EXTENSIONS,
  isBlockedDevicePath,
} from 'src/tools/FileReadTool/guards.js'
import { getDefaultFileReadingLimits } from 'src/tools/FileReadTool/limits.js'
import {
  READ_AUTO_OUTLINE_MIN_SYMBOLS,
  scanFile,
} from 'src/tools/FileReadTool/outlineView.js'
import {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  LINE_FORMAT_INSTRUCTION,
  renderCompactPromptTemplate,
  renderPromptTemplate,
  renderClipPinFallbackFooter,
  renderClipPinFallbackStub,
} from 'src/tools/FileReadTool/prompt.js'
import { isCompactToolPromptsEnabled } from 'src/agent/prompts/toolPromptTier.js'
import {
  batchHookUnits,
  isBatchFileContext,
  readBatch,
  validateBatchPaths,
} from 'src/tools/FileReadTool/batchRead.js'
import { callInner } from 'src/tools/FileReadTool/readDispatch.js'
import {
  batchShapeRefusal,
  isBatchReadInput,
  readMultiEnabledAtLoad,
  readPathsOf,
  recordedReadTargets,
  toSingleInput,
} from 'src/tools/FileReadTool/readMulti.js'
import {
  mapReadResultToToolResultBlock,
  maybeFlagReadReminder,
} from 'src/tools/FileReadTool/resultContent.js'
import {
  readGlobsEnabledAtLoad,
  resolveReadGlobs,
  type ReadGlobDeps,
} from 'src/tools/FileReadTool/readGlobs.js'
import {
  inputSchema,
  outputSchema,
  type Input,
  type InputSchema,
  type Output,
  type OutputSchema,
} from 'src/tools/FileReadTool/schemas.js'
import { hasServerClearedToolUses } from 'src/tools/FileReadTool/serverClearingDetection.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from 'src/tools/FileReadTool/UI.js'

// The public surface of this module predates the split into siblings: seventeen
// modules and the directory's tests import these names from 'src/tools/FileReadTool/FileReadTool.js'.
export type { Input, Output } from 'src/tools/FileReadTool/schemas.js'
export { MaxFileReadTokenExceededError } from 'src/tools/FileReadTool/guards.js'
export { readImageWithTokenBudget } from 'src/tools/FileReadTool/imageRead.js'
export { STAND_DOWN_STRIKES, STICKY_REPLAY_BUDGET } from 'src/tools/FileReadTool/clipPin.js'
export { AUTO_OUTLINE_PIVOT_FOOTER, scanFile } from 'src/tools/FileReadTool/outlineView.js'

// The batch Read — `file_paths`, and `symbol` as a list (readMulti.ts). Read
// once, at load, like the schema and the description it must agree with.
const READ_MULTI = readMultiEnabledAtLoad()
// Globs in `file_paths` (readGlobs.ts), read at load for the same reason.
const READ_GLOBS = readGlobsEnabledAtLoad()

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  searchHint: 'read files, images, PDFs, notebooks',
  clearableResult: true,
  // Output is bounded by maxTokens (validateContentTokens). Persisting to a
  // file the model reads back with Read is circular — never persist.
  maxResultSizeChars: Infinity,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return isCompactToolPromptsEnabled()
      ? renderCompactPromptTemplate(pickLineFormatInstruction())
      : renderPromptTemplate(pickLineFormatInstruction())
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
    // A batch shows the classifier every file it reads, one per line — the
    // way Git's commands are joined. The transcript hands this the model's
    // own arguments, where Codex sets `file_paths: null` beside a single
    // path, so they are read as recorded; one path goes out as it always has.
    const paths = readPathsOf(recordedReadTargets(input))
    return paths.length > 1 ? paths.join('\n') : input.file_path
  },
  isSearchOrReadCommand() {
    return { isSearch: false, isRead: true }
  },
  getPath({ file_path, file_paths }): string {
    // A batch's first file: the permission dialog titles itself with one path,
    // and the ask it shows lists them all (checkBatchReadPermission).
    return file_path || file_paths?.[0] || getCwd()
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
    if (Array.isArray(input.file_paths)) {
      input.file_paths = input.file_paths.map(p =>
        typeof p === 'string' ? expandPath(p) : p,
      )
    }
  },
  async preparePermissionMatcher(input) {
    // Hooks see a batch one file at a time (hookUnits below), so an
    // `if: "Read(*.env)"` condition is judged on that file's own path. Should
    // a batch input reach a matcher all the same, it fires on any of its
    // paths — never on none. One file_path matches exactly as before.
    const paths = readPathsOf(input)
    return pattern => paths.some(p => matchWildcardPattern(pattern, p))
  },
  hookUnits(input) {
    // A batch is, to every hook, the single Reads it makes — one per file
    // and symbol (batchRead.ts) — each seen as a Read of its own would be.
    if (!READ_MULTI || !isBatchReadInput(input)) return undefined
    return batchHookUnits(input, unit => FileReadTool.backfillObservableInput(unit))
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    if (READ_MULTI && input.file_paths !== undefined) {
      return checkBatchReadPermission(
        FileReadTool.name,
        input.file_paths,
        input,
        appState.toolPermissionContext,
      )
    }
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
  // A glob in file_paths is expanded here, before validateInput, the hooks,
  // the permission check and call() see the input (readGlobs.ts). Absent
  // unless CLAUDIN_READ_GLOBS is on, so every other Read runs as it did.
  ...(READ_GLOBS && {
    resolveInput(input: Input, context: ToolUseContext) {
      return resolveReadGlobs(input, readGlobDeps(context))
    },
  }),
  async validateInput(
    input,
    toolUseContext: ToolUseContext,
  ): Promise<ValidationResult> {
    if (READ_MULTI) {
      const refusal = batchShapeRefusal(input)
      if (refusal) return { result: false, ...refusal }
      if (input.file_paths !== undefined) {
        // Every path gets the checks below, exactly as a Read of it would.
        return validateBatchPaths(input.file_paths, filePath =>
          FileReadTool.validateInput({ file_path: filePath }, toolUseContext),
        )
      }
    }
    const { file_path, pages } = toSingleInput(input)
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
   *
   * A batch never uses the cache, nor does a file read inside one
   * (batchRead.ts): the entry's freshness is checked on one path, and every
   * file of a batch shares the tool_use id the stand-down keys on.
   */
  bypassResultCache(input, context) {
    if (READ_MULTI && (isBatchReadInput(input) || isBatchFileContext(context))) {
      return true
    }
    try {
      const { file_path } = toSingleInput(input)
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
  /**
   * Re-seed readFileState when the cache answers instead of call(). The body
   * the model receives is the same either way; what a hit skips is
   * readDispatch's `readFileState.set`, and that entry is the read-before-edit
   * gate's whole evidence. Without this the model reads a file, gets its
   * content, and is then told the file "has not been read yet" by
   * Edit/Patch/Write — which is what a live session showed five times
   * over, each one cleared only by an identical second Read (the refused write
   * does not invalidate the entry, but any Bash does, and the re-read then
   * reaches call()).
   *
   * The window is narrow but ordinary: readFileState holds 100 paths while the
   * Read result cache holds 500 for 60s, so any session touching more files
   * than that (219 in the one measured) can lose the entry while the cached
   * body lives on. bypassResultCache cannot cover it — the entry it would key
   * on is exactly the one that is gone, making it indistinguishable from a
   * first read.
   *
   * Seeds ONLY when the context has no entry at all. A partial view, an
   * outline or a sticky stand-down marker is state call() owns; overwriting it
   * with a full body here would hand back precisely the content those arms
   * concluded must not be served.
   */
  onCacheHit(input, context, data) {
    try {
      if (data.type !== 'text') return
      const { file_path, offset = 1, limit } = toSingleInput(input)
      const fullFilePath = expandPath(file_path)
      if (context.readFileState.has(fullFilePath)) return
      context.readFileState.set(fullFilePath, {
        content: data.file.content,
        // getCached only serves a Read whose file has not been modified since
        // it was stored, so the bytes above describe the file on disk now and
        // this mtime is the one they belong to.
        timestamp: getFileModificationTime(fullFilePath),
        // Same normalization call() applies: offset 0 and 1 both start at the
        // first line, and a 0 here would make the entry describe a range no
        // Read can ask for again.
        offset: offset === 0 ? 1 : offset,
        limit,
        toolUseId: context.toolUseId,
      })
    } catch (e) {
      // Fail open: the cached body still goes to the model, the gate just
      // stays where it was.
      logError(e)
    }
  },
  async call(
    input,
    context,
    _canUseTool?,
    parentMessage?,
  ): Promise<ToolResult<Output>> {
    // Several files, or several symbols of one (readMulti.ts): the batch runs
    // this same call once per file and symbol, through the tool itself.
    if (READ_MULTI && isBatchReadInput(input)) {
      return readBatch(input, context, (one, fileContext) =>
        FileReadTool.call(one, fileContext, _canUseTool, parentMessage),
      )
    }
    const one = toSingleInput(input)
    const { file_path, limit = undefined, pages, view, symbol, encoding } = one
    // `let`: an offset of 0 is normalized to 1 below.
    let offset = one.offset ?? 1
    const { readFileState, fileReadingLimits } = context

    // Reject an unusable label here, before any filesystem work and before the
    // dedup arms below decide anything — a bad encoding is a bad request, not
    // a file that failed to read.
    if (encoding !== undefined) assertKnownEncoding(encoding)

    // offset is 1-indexed but the schema accepts 0 (nonnegative). Both read
    // from the first line, so normalize early — otherwise startLine: 0 would
    // make the line-number prefixes start at 0 (off by one vs the real file)
    // and dedup would treat offset 0 and 1 as different ranges.
    if (offset === 0) offset = 1

    const defaults = getDefaultFileReadingLimits()
    const maxSizeBytes =
      fileReadingLimits?.maxSizeBytes ?? defaults.maxSizeBytes
    const maxTokens = fileReadingLimits?.maxTokens ?? defaults.maxTokens


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
    // Client-side only — no server support needed, safe for
    // Bedrock/Vertex/Foundry.
    //
    // `let`, not `const`: the sticky branch below can spend its budget and
    // delete the entry, and everything downstream must then see a genuine
    // first read rather than a stale local.
    let existingState = readFileState.get(fullFilePath)

    // STICKY STAND-DOWN. This exact (path, offset, limit) already exhausted
    // the re-send lanes and was answered with a structural outline. Serve that
    // same answer again instead of starting the cycle over.
    //
    // This RATE-LIMITS the fallback; it does not end it. An earlier version of
    // this comment claimed the fallback "terminates" and a review falsified it
    // from 88 lines below: the budget exit at the bottom of this branch deletes
    // the marker, the write arm re-creates it, and BOTH counters live on the
    // entry — so nothing survives a cycle to shorten the next one. The steady
    // state is still `body → pinned body → outline ×STICKY_REPLAY_BUDGET →
    // body`, forever.
    //
    // What changed is the RATE. The version before deleted the entry on every
    // fallback, so the next read was a first read and paid another full body;
    // the pin is temporary by construction (it expires, loses its slot to the
    // FIFO, or exceeds the ceiling) while the file is permanent, so the two
    // together settled into two full bodies every THREE reads when the pin
    // cannot protect a round (over the 8k ceiling, evicted by the FIFO, or no
    // toolUseId to pin), and every four when it can — the protected round adds
    // one cheap dedup stub before the fallback. With the marker the same two
    // bodies are spread over six reads, seven when the pin protects a round.
    //
    // So the bug this fixes is the PERMANENT REFUSAL and the body rate, not
    // the cycle. Do not re-describe it as termination.
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
      encoding === undefined &&
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
    // Set when this Read is the re-send half of a clip-pin stand-down;
    // consumed after callInner succeeds.
    let standDownResend = false
    // Strike count to carry onto the entry the re-send is about to write.
    let standDownStrikes = 0
    if (
      existingState &&
      !existingState.isPartialView &&
      existingState.offset !== undefined &&
      // Written by the watcher or a refusal, never delivered as a Read
      // tool_result — a stub would point at the OLD bytes (fileStateCache.ts).
      !existingState.dedupExempt &&
      view === undefined &&
      symbol === undefined &&
      // An encoding override asks for different characters out of the same
      // bytes, so a stub built from the UTF-8 read answers a question that was
      // not asked. Excluding it here also keeps the whole clip-pin arm below
      // (its outline scan, its head slice) on the UTF-8 path it assumes.
      encoding === undefined
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
        } else         // Clip-pin stand-down. A clipped/cleared stand-down re-sends the full
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
            // The arm separates the two stand-downs: 'clipped' has positive
            // evidence the pinned copy was removed, 'cleared' only knows the
            // API cleared something, sometime.
            const arm = serverCleared ? 'cleared' : 'clipped'
            const message = scanned
              ? renderOutline(scanned.entries, file_path, scanned.lines.length, {
                  reason: 'explicit',
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
      }
    }

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDIN_SIMPLE)) {
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
        encoding,
        maxSizeBytes,
        maxTokens,
        readFileState,
        context,
        parentMessage?.message.id,
      )
      maybeFlagReadReminder(result?.data, context)
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
        //
        // A file inside a batch is never pinned either (batchRead.ts): every
        // file of the batch shares this id, and a pin shields — and a dispose
        // releases — the whole block by it. Lane 2 bounds its stand-down, as
        // it bounds the killswitch path.
        if (
          clipPinEnabled() &&
          !isBatchFileContext(context) &&
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
              encoding,
              maxSizeBytes,
              maxTokens,
              readFileState,
              context,
              parentMessage?.message.id,
            )
            maybeFlagReadReminder(altResult?.data, context)
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
    return mapReadResultToToolResultBlock(data, toolUseID)
  },
} satisfies ToolDef<InputSchema, Output>)

function pickLineFormatInstruction(): string {
  return LINE_FORMAT_INSTRUCTION
}

/**
 * The session and the disk as the glob expansion reaches them (readGlobs.ts).
 * A glob's base directory is checked lexically first, which touches nothing
 * outside the project, then through its symlinks the way the Read permission
 * resolves a path — so a link inside the project that leads out of it is not
 * listed either.
 */
function readGlobDeps(context: ToolUseContext): ReadGlobDeps {
  const { toolPermissionContext } = context.getAppState()
  return {
    cwd: getCwd(),
    baseDirectoryOf: pattern => extractGlobBaseDirectory(pattern).baseDir,
    isInsideProject: directory =>
      pathInAllowedWorkingPath(directory, toolPermissionContext, [directory]) &&
      pathInAllowedWorkingPath(directory, toolPermissionContext),
    isFile: isExistingFile,
    listMatches: (pattern, limit) => {
      const { baseDir, relativePattern } = extractGlobBaseDirectory(pattern)
      // The leading `./` anchors the pattern at its base, as a shell reads it:
      // `src/*.ts` is src's own files, where glob.ts matches a bare `*.ts` at
      // any depth.
      return glob(
        `./${relativePattern}`,
        baseDir,
        { limit, offset: 0, sort: 'path', type: 'file', respectGitignore: true },
        context.abortController.signal,
        toolPermissionContext,
      )
    },
  }
}

async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await getFsImplementation().stat(path)).isFile()
  } catch (e) {
    // A glob is not a file name, so not finding one is the usual answer.
    if (isFsInaccessible(e)) return false
    logError(e)
    return false
  }
}
