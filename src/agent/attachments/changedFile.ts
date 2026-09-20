// One entry's worth of the changed-files watcher: re-read a file that moved on
// disk since the model last saw it, and hand back the diff as an attachment.
//
// Split out of `services.ts` for one reason: `services.ts` reaches the TUI and
// the task runtime through its import chain (`terminal/state/selectors`,
// `agent/tasks/tasks`, `platform/ide/ide`), which under `bun test` fails to
// load, so it has never had a test of its own while nine sibling attachment
// modules do. The decision here — what to re-read, what to write back, when to
// evict — is exactly the part that was wrong, so it lives where a test can
// reach it. `getChangedFiles` keeps the loop and the gates.
//
// What was wrong: this re-read used to call FileReadTool with no `view`, which
// is a vanilla Read, which for any code file over ~10 KB pivots to a structural
// outline (AUTO_OUTLINE_ON_ELISION). Two silent consequences:
//
//   1. `makeOutlineData` writes `isPartialView: true`, so the entry for a file
//      the model had seen in full was downgraded to "outline only" and the next
//      Edit/apply_patch was refused with a message that says the model never
//      saw the body. Measured over 683 sessions: 38 of the 50 `partial-view`
//      refusals on an already-read path had an out-of-band rewrite (a build, a
//      `perl -i`, a `git checkout`) between the read and the refusal.
//   2. The result then has `type: 'outline'`, which matches neither the 'text'
//      nor the 'image' arm below, so this function returned null — the model
//      was never told the file had changed at all.
//
// `view: 'full'` fixes both, and skips two mechanisms that have no business
// firing on an internal re-read: the clip-pin sticky replay and the dedup stub
// (FileReadTool.ts) both require `view === undefined`.
import type { Attachment } from 'src/agent/attachments/types.js'
import { getSnippetForTwoFileDiff } from 'src/tools/FileEditTool/utils.js'
import {
  FileReadTool,
  readImageWithTokenBudget,
} from 'src/tools/FileReadTool/FileReadTool.js'
import { MaxFileReadTokenExceededError } from 'src/tools/FileReadTool/guards.js'
import { FileTooLargeError } from 'src/shared/fs/readFileInRange.js'
import { getFileModificationTimeAsync } from 'src/shared/fs/file.js'
import type { FileState, FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { expandPath } from 'src/shared/fs/path.js'
import { isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { isFileReadDenied } from 'src/agent/attachments/shared.js'

/**
 * The entries one pass visits, snapshotted WITHOUT touching their recency.
 *
 * The previous loop took `cacheKeys()` (MRU → LRU) and called `get()` on each,
 * and lru-cache counts a `get` as a use — so every pass moved every entry to
 * the head in reverse order and the most recently written file became the
 * next eviction victim. It only bites past 100 distinct files, which is why
 * it read as "the model forgot to Read" for so long: 16 "has not been read
 * yet" refusals in the 2026-09-14..20 corpus were on a file the model had
 * just written, in the 4 sessions that crossed the cap (one held 249).
 * `entries()` walks the same list without the side effect.
 */
export function changedFileCandidates(
  readFileState: FileStateCache,
): Array<[string, FileState]> {
  return Array.from(readFileState.entries())
}

/**
 * The changed-files pass: one `refreshChangedFile` per entry the watcher
 * covers. Lives here rather than in `services.ts` so the end-to-end scenarios
 * (`src/__tests__/readGateScenarios.test.ts`) can drive the real selection —
 * which entries are visited, and in what order — instead of a hand-rolled
 * copy of the loop; `services.ts` only delegates.
 */
export async function getChangedFileAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const candidates = changedFileCandidates(toolUseContext.readFileState)
  if (candidates.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    candidates.map(async ([filePath, fileState]) => {
      // TODO: Implement offset/limit support for changed files
      if (fileState.offset !== undefined || fileState.limit !== undefined) {
        return null
      }

      const normalizedPath = expandPath(filePath)

      // Check if file has a deny rule configured
      if (isFileReadDenied(normalizedPath, appState.toolPermissionContext)) {
        return null
      }

      return refreshChangedFile(
        filePath,
        normalizedPath,
        fileState,
        toolUseContext,
      )
    }),
  )
  return results.filter(result => result != null) as Attachment[]
}

/**
 * `cacheKey` is the key the entry is stored under and `normalizedPath` its
 * expanded form — the two differ for a `~`-rooted path, and the eviction paths
 * have always used the key. Keeping them separate rather than "simplifying" to
 * one is deliberate: deleting under the expanded path would silently miss.
 */
export async function refreshChangedFile(
  cacheKey: string,
  normalizedPath: string,
  fileState: FileState,
  toolUseContext: ToolUseContext,
): Promise<Attachment | null> {
  const { readFileState } = toolUseContext
  try {
    const mtime = await getFileModificationTimeAsync(normalizedPath)
    if (mtime <= fileState.timestamp) {
      return null
    }

    // `view: 'full'` is load-bearing, not a default made explicit — see the
    // module header. The same object goes to validateInput and to call, so the
    // validation cannot disagree with what is read.
    const fileInput = { file_path: normalizedPath, view: 'full' as const }

    // Validate file path is valid
    const isValid = await FileReadTool.validateInput(fileInput, toolUseContext)
    if (!isValid.result) {
      return null
    }

    const result = await FileReadTool.call(fileInput, toolUseContext)
    // Extract only the changed section
    if (result.data.type === 'text') {
      const snippet = getSnippetForTwoFileDiff(
        fileState.content,
        result.data.file.content,
      )

      // The Read just wrote an entry for its own request shape, which for a
      // full read is `offset: 1`. That is the shape `getChangedFiles` skips,
      // so leaving it would quietly retire this file from change detection for
      // the rest of the session. Normalize to the whole-file shape the write
      // tools use.
      const written = readFileState.get(cacheKey)
      if (written) {
        readFileState.set(cacheKey, {
          ...written,
          offset: undefined,
          limit: undefined,
        })
      }

      // File was touched but not modified
      if (snippet === '') {
        return null
      }

      return {
        type: 'edited_text_file' as const,
        filename: normalizedPath,
        snippet,
      }
    }

    // For non-text files (images), apply the same token limit logic as FileReadTool
    if (result.data.type === 'image') {
      try {
        const data = await readImageWithTokenBudget(normalizedPath)
        return {
          type: 'edited_image_file' as const,
          filename: normalizedPath,
          content: data,
        }
      } catch (compressionError) {
        logError(compressionError)
        return null
      }
    }

    // notebook / pdf / parts — no diff representation; explicitly
    // null so the map callback has no implicit-undefined path.
    return null
  } catch (err) {
    // Evict ONLY on ENOENT (file truly deleted). Transient stat
    // failures — atomic-save races (editor writes tmp→rename and
    // stat hits the gap), EACCES churn, network-FS hiccups — must
    // NOT evict, or the next Edit fails code-6 even though the
    // file still exists and the model just read it. VS Code
    // auto-save/format-on-save hits this race especially often.
    // See regression analysis on PR #18525.
    if (isENOENT(err)) {
      readFileState.delete(cacheKey)
      return null
    }
    // Over the byte or token cap. `view: 'full'` rethrows here where a vanilla
    // Read would have served an outline, and an outline at least refreshed the
    // timestamp — so doing nothing would leave `mtime > timestamp` true and
    // retry this read every single turn, forever. Evicting ends it: the entry
    // no longer describes the file, the next write is refused with "has not
    // been read yet", which is true, and the loop cannot restart because
    // `getChangedFiles` only walks entries that exist.
    if (
      err instanceof FileTooLargeError ||
      err instanceof MaxFileReadTokenExceededError
    ) {
      readFileState.delete(cacheKey)
      return null
    }
    return null
  }
}
