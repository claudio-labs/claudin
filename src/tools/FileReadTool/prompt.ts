import { isPDFSupported } from 'src/shared/fs/pdfUtils.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { getDefaultFileReadingLimits } from 'src/tools/FileReadTool/limits.js'
import {
  MAX_BATCH_FILES,
  readMultiEnabledAtLoad,
} from 'src/tools/FileReadTool/readMulti.js'
import {
  MAX_GLOB_FILES,
  readGlobsEnabledAtLoad,
} from 'src/tools/FileReadTool/readGlobs.js'

// Use a string constant for tool names to avoid circular dependencies
export const FILE_READ_TOOL_NAME = 'Read'

const READ_MULTI = readMultiEnabledAtLoad()
const READ_GLOBS = readGlobsEnabledAtLoad()

/**
 * The one line the batch Read adds to both descriptions (readMulti.ts),
 * placed under the default-length bullet. Empty under the killswitch
 * (CLAUDIN_READ_MULTI=0), which is what keeps both templates byte-identical
 * to the text before the batch Read existed. Under CLAUDIN_READ_GLOBS
 * (readGlobs.ts) the same line takes globs and their cap instead.
 */
function batchReadInstruction(): string {
  if (!READ_MULTI) return ''
  const budgetK = Math.round(getDefaultFileReadingLimits().maxTokens / 1000)
  if (READ_GLOBS) {
    return `\n- \`file_paths\` reads up to ${MAX_GLOB_FILES} files in one call — each as \`view\`/\`symbol\` say, within ${budgetK}k tokens in total; a glob like \`src/*.ts\` reads every match.`
  }
  return `\n- \`file_paths\` reads up to ${MAX_BATCH_FILES} files in one call — each as \`view\`/\`symbol\` say, within ${budgetK}k tokens in total.`
}

export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

/** Human-readable line range for the clip-pin fallback messages ("line 1450" or
 *  "lines 1450-1569"). `limit` undefined ⇒ open-ended from `offset`. */
function formatRange(offset: number, limit: number | undefined): string {
  if (limit === undefined) return `from line ${offset}`
  if (limit <= 1) return `line ${offset}`
  return `lines ${offset}-${offset + limit - 1}`
}

/**
 * Which stand-down arm produced the fallback. The two carry different
 * evidence and must not claim each other's:
 *   'clipped' — the pinned copy is no longer readable in the transcript. Note
 *               this covers THREE cases: the scanner matched the id and found a
 *               clip stub in its place, the id is absent entirely (the whole
 *               message was evicted), or the id was registered as clipped
 *               mid-prompt. Only the first is a clip actually witnessed, so the
 *               wording says the copy is gone, not that we watched it go — see
 *               isPriorReadClippedOrMissing, whose name is the honest one.
 *
 *               It also does NOT claim the copy "was protected". An audit
 *               pointed out this arm fires for an id retired on sight by
 *               MAX_PINNED_RESULT_TOKENS — registered, but over the size
 *               ceiling and therefore never actually shielding anything. The
 *               model would have been told a protection held that never ran.
 *   'cleared' — the API applied clear_tool_uses at some point in this session.
 *               That latches session-wide and reports counts only, so we never
 *               learn which result was cleared, and a client-side pin cannot
 *               stop server-side clearing in the first place. Claiming the copy
 *               was protected here would be false.
 */
export type ClipPinArm = 'clipped' | 'cleared'

function clipPinReason(arm: ClipPinArm, range: string): string {
  return arm === 'clipped'
    ? `You already re-read ${range} of this file and that copy is no longer in the conversation`
    : `You already re-read ${range} of this file and the API keeps clearing tool results out of this conversation, so that copy is gone again`
}

/**
 * Footer appended to the structural outline served when a re-sent range was
 * lost again anyway. Tells the model the re-send is futile and to switch to a
 * stable navigation move.
 */
export function renderClipPinFallbackFooter(
  offset: number,
  limit: number | undefined,
  arm: ClipPinArm,
): string {
  const range = formatRange(offset, limit)
  return `\n\n<system-reminder>${clipPinReason(arm, range)} — re-sending the body is futile. Stop re-reading this range: pick a symbol above with symbol='name', or use Grep, to fetch a stable slice instead.</system-reminder>`
}

/**
 * Standalone redirect stub for the non-code case (nothing to outline). Same
 * intent as the outline footer, delivered as the whole tool_result.
 */
export function renderClipPinFallbackStub(
  offset: number,
  limit: number | undefined,
  arm: ClipPinArm,
): string {
  const range = formatRange(offset, limit)
  return `<system-reminder>${clipPinReason(arm, range)} — re-sending it is futile. Stop re-reading this range: use Grep to fetch just the lines you need, or read a different part of the file.</system-reminder>`
}

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = 'Read a file from the local filesystem.'

export const LINE_FORMAT_INSTRUCTION =
  '- Each result line is prefixed with its 1-indexed line number followed by an arrow (e.g. `42→content` is line 42 of the file); numbering starts at the requested offset'

/**
 * No "stop slicing after N" rule here, and that is deliberate. A draft of the
 * ladder ended step 3 with "coming back for a third slice means read it whole",
 * written on a single A/B run showing +35% cost that did not survive three
 * reps. Two things sank it, and the second is the load-bearing one:
 *
 * - A 40-line slice fits into one whole read a median of 3.1 times over the
 *   non-test `.ts` files in `src/`, but the median hides the shape: ~1.0x under
 *   100 lines against 9.4x at 250-600 and 22x at 600-1500. A fixed ceiling of
 *   three therefore bites hardest exactly where slicing pays most. (An earlier
 *   note here said 4.3x and 1.6x — those came from silently dropping files
 *   shorter than the slice, which is most of the small bucket.)
 * - Past ~250 lines or 10k chars a no-view Read auto-outlines anyway
 *   (AUTO_OUTLINE_ON_ELISION), so "read it whole" does not return a whole file
 *   there. The rule was instructing the model to ask for something the tool
 *   declines to serve.
 *
 * Do not re-add a ceiling from a session A/B alone: that bench cannot see reads
 * a sub-agent made, which is enough on its own to invert its verdict.
 */

/**
 * The counterpart that used to sit beside this one — "it's recommended to read
 * the whole file by not providing these parameters" — contradicted the
 * surgical-read strategy ten lines above it, and it was the one that shipped:
 * the choice between them hung on `targetedRangeNudge`, a runtime flag that
 * always resolved to its default here. So the wrong wording rendered
 * unconditionally and the right one was unreachable. Deleted rather than
 * re-gated — there is no server here to flip it.
 */
export const OFFSET_INSTRUCTION_TARGETED =
  '- When you already know which part of the file you need, only read that part. This can be important for larger files.'

/**
 * Renders the Read tool prompt template.  The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(
  lineFormat: string,
): string {
  return `Reads a file from the local filesystem. You can access any file directly by using this tool: assume any path the user gives you is valid and readable, including a temporary path outside the project — try the read rather than verifying the path first.

Reading strategy for code files (TS/JS, Python, Go, Java, Kotlin, C#, Rust, C/C++, PHP, Swift, Scala, Ruby, Lua, Bash, SQL, CSS/SCSS, HTML, Markdown, YAML, XML, .properties, .env, TOML, Dockerfile, Makefile, GraphQL, Terraform):
Default to surgical reads: a targeted read costs a fraction of the file, and a read you did not need costs a turn on top of its bytes. Follow this order:
1. Unknown file → start with view='outline' (~5-10% of full-file tokens; typically 150-1500 depending on symbol count). Returns every function, class and object-literal member signature with line ranges, plus the substantial handlers nested inside a large function. The header says how much of the file the symbols actually cover.
2. Need to inspect or modify a known function X → use symbol='X' (returns just that function body, not the whole file). A symbol too large to send whole comes back as its own outline instead; add view='full' to get the body anyway.
3. Need lines around a known location → use offset/limit (range read) instead of full file.
4. Full file only when you genuinely need top-level imports, module-level constants, or the entire structure end-to-end.

An outline is not always a symbol list: Markdown and HTML outline by heading, a unified diff (.diff/.patch) outlines by file and symbol='<path>' returns that file's hunks, and a large plain-text file (.txt, .log, no extension — outside the languages above) comes back as its head and tail with the line count. A file over the read cap outlines automatically, and so does a large Read that names no view (a large literal body in tool_result reliably induces a slice-walk re-read loop) — pass view='full' for the body, or offset/limit/symbol for one range.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file${batchReadInstruction()}
${OFFSET_INSTRUCTION_TARGETED}
${lineFormat}
- Reading a directory, a file that does not exist, or an empty file returns an error or a system reminder rather than content; list a directory with the ${GLOB_TOOL_NAME} tool.
- This tool allows Claudin to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claudin is a multimodal LLM.${
    isPDFSupported()
      ? '\n- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.'
      : ''
  }
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- Do NOT re-read a file you just edited to verify the change — Edit/Write would have errored if it failed, and the harness tracks file state for you.`
}

/**
 * The same instructions in the v2 tool descriptions
 * (isCompactToolPromptsEnabled): the reading ladder in one paragraph, and the
 * language list dropped — an outline answers for any file, and the non-code
 * shapes are named.
 */
export function renderCompactPromptTemplate(
  lineFormat: string,
): string {
  return `Reads a file from the local filesystem. file_path must be absolute; any path the user gives you is readable, including a temporary path outside the project — read it rather than checking first.

Read only what you need: view='outline' for an unknown file (signatures with line ranges; Markdown and HTML outline by heading, a .diff/.patch by file, with symbol='<path>' for one file's hunks), symbol='X' for one function (a large one comes back as its own outline; add view='full' for the body), offset/limit for a range, the whole file only when you need all of it. A large Read that names no view, and any file over the cap, comes back as an outline, a long plain-text file as its head and tail with the line count — pass view='full' for the body.

- Reads up to ${MAX_LINES_TO_READ} lines by default.${batchReadInstruction()}
${lineFormat}
- A directory, a missing file or an empty file returns an error or a system reminder; list a directory with ${GLOB_TOOL_NAME}.
- Images come back visually.${isPDFSupported() ? ' A PDF past 10 pages needs `pages` (e.g. "1-5", at most 20 per request).' : ''} A notebook (.ipynb) returns every cell with its outputs.
- Don't re-read a file you just edited: Edit/Write would have failed if the change did not land.`
}
