import { isPDFSupported } from '../../utils/pdfUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

// Use a string constant for tool names to avoid circular dependencies
export const FILE_READ_TOOL_NAME = 'Read'

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
 *               this covers TWO cases: the scanner matched the id and found a
 *               clip stub in its place, OR the id is absent entirely (the whole
 *               message was evicted). Only the first is a clip actually
 *               witnessed, so the wording says the copy is gone, not that we
 *               watched it go — see isPriorReadClippedOrMissing, whose name is
 *               the honest one.
 *   'cleared' — the API applied clear_tool_uses at some point in this session.
 *               That latches session-wide and reports counts only, so we never
 *               learn which result was cleared, and a client-side pin cannot
 *               stop server-side clearing in the first place. Claiming the copy
 *               was protected here would be false.
 */
export type ClipPinArm = 'clipped' | 'cleared'

function clipPinReason(arm: ClipPinArm, range: string): string {
  return arm === 'clipped'
    ? `You already re-read ${range} of this file and that copy is no longer in the conversation, even though it was protected`
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

export const OFFSET_INSTRUCTION_DEFAULT =
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters"

export const OFFSET_INSTRUCTION_TARGETED =
  '- When you already know which part of the file you need, only read that part. This can be important for larger files.'

/**
 * Renders the Read tool prompt template.  The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string {
  return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Reading strategy for code files (TS/JS, Python, Go, Java, Kotlin, C#, Rust, C/C++, PHP, Swift, Scala, Ruby, Lua, Bash, SQL, CSS/SCSS, HTML, Markdown, YAML, XML, .properties, .env, TOML, Dockerfile, Makefile, GraphQL, Terraform):
Default to surgical reads — full-file reads waste tokens proportionally to file size, while targeted reads cost ~95% less. Follow this order:
1. Unknown file → start with view='outline' (~5-10% of full-file tokens; typically 150-1500 depending on symbol count). Returns every function/class signature with line ranges.
2. Need to inspect or modify a known function X → use symbol='X' (returns just that function body, not the whole file).
3. Need lines around a known location → use offset/limit (range read) instead of full file.
4. Full file only when you genuinely need top-level imports, module-level constants, or the entire structure end-to-end.
Example: to refactor 'login' in src/auth/index.ts, prefer view='outline' → symbol='login' over reading the whole file.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file${maxSizeInstruction}
${offsetInstruction}
${lineFormat}
- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.${
    isPDFSupported()
      ? '\n- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.'
      : ''
  }
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- For large code files (TS/JS, Python, Go, Java, Kotlin, C#, Rust, C/C++, PHP, Swift, Scala, Ruby, Lua, Bash, SQL, CSS/SCSS, HTML, YAML, XML, .properties, .env, TOML, Dockerfile, Makefile, GraphQL, Terraform), pass view='outline' to read just the function/class signatures, then symbol='name' to expand one of them. Markdown and HTML files outline by heading the same way. A file that exceeds the read cap returns this outline automatically. Large-file Reads without an explicit view also auto-pivot to the outline by default (a large literal body in tool_result reliably induces a slice-walk re-read loop); pass view='full' to force the body, or use offset/limit/symbol to target a specific range.
- This tool can only read files, not directories. To read a directory, use an ls command via the ${BASH_TOOL_NAME} tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
- Do NOT re-read a file you just edited to verify the change — Edit/Write would have errored if it failed, and the harness tracks file state for you.

Multi-file investigations. When the task spans more than ~2 files (tracing a feature, mapping a subsystem, finding call sites), prefer one of these over a serial chain of single Reads:
- Dispatch the Explore agent (via the Agent tool with subagent_type='Explore') with the question — it returns excerpts in one turn and keeps your context clean.
- Otherwise, emit the Reads as parallel tool_use blocks in the same assistant message. Same-turn parallel Reads are first-class.
A serial loop of Read → short comment → Read → short comment is the wrong shape.`
}
