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
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/platform/analytics/index.js'
import type { Attachment } from 'src/agent/attachments/types.js'
import { getSnippetForTwoFileDiff } from 'src/tools/FileEditTool/utils.js'
import {
  FileReadTool,
  readImageWithTokenBudget,
} from 'src/tools/FileReadTool/FileReadTool.js'
import { MaxFileReadTokenExceededError } from 'src/tools/FileReadTool/guards.js'
import { FileTooLargeError } from 'src/shared/fs/readFileInRange.js'
import { getFileModificationTimeAsync } from 'src/shared/fs/file.js'
import type { FileState } from 'src/shared/fs/fileStateCache.js'
import { isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

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
        logEvent('tengu_watched_file_compression_failed', {
          file: normalizedPath,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
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
