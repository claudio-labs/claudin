import { feature } from 'bun:bundle'
import { isAbortError } from 'src/utils/errors.js'
import { addLineNumbers } from 'src/utils/fs/file.js'
import { readFileInRange } from 'src/utils/fs/readFileInRange.js'
import { logError } from 'src/utils/log.js'

/**
 * Gate for the clip-pin stand-down (READ_CLIP_PIN). Same shape as
 * autoOutlineOnElisionEnabled: the test-preload stubs every `feature()` to
 * `false`, so tests force-enable via `CLAUDIN_FORCE_READ_CLIP_PIN=1`;
 * production folds `feature('READ_CLIP_PIN')` at build time.
 */
export function clipPinEnabled(): boolean {
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
 * How many STAND-DOWNS of one (path, offset, limit) the re-send lanes get
 * before the fallback takes over, for the cases a pin cannot bound: contexts
 * with no toolUseId, and the killswitch path.
 *
 * Stand-downs, not re-sends — the distinction is worth a paragraph because an
 * earlier version of this doc got it wrong and no test contradicted it. The
 * count starts at 1 on the FIRST stand-down and the check is
 * `>= STAND_DOWN_STRIKES`, so the third stand-down serves the fallback instead
 * of a body: the model gets TWO futile re-sends, not three. The killswitch
 * test bounds the run of consecutive bodies at `<= STAND_DOWN_STRIKES`, which
 * a two-body regime satisfies just as well, so it now also pins the exact
 * sequence for a file that keeps getting clipped: body (the first read, which
 * stands down from nothing), re-send, re-send, fallback, fallback.
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
export async function renderClipPinHeadSlice(
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
