import { z } from 'zod/v4'
import type { ValidationResult } from 'src/tools/Tool.js'
import { buildTool, type ToolDef } from 'src/tools/Tool.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { isENOENT } from 'src/shared/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  suggestPathUnderCwd,
} from 'src/shared/fs/file.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { glob } from 'src/shared/fs/glob.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { expandPath, toRelativePath } from 'src/shared/fs/path.js'
import { checkReadPermissionForTool } from 'src/permissions/filesystem.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { matchWildcardPattern } from 'src/permissions/shellRuleMatching.js'
import { semanticBoolean } from 'src/shared/data/semanticBoolean.js'
import { semanticNumber } from 'src/shared/data/semanticNumber.js'
import { DESCRIPTION, GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from 'src/tools/GlobTool/UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z
      .string()
      .optional()
      .describe(
        'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
      ),
    offset: semanticNumber(z.number().optional()).describe(
      'Skip the first N matching files before applying the 100-file cap. Pass the offset a truncated result reports to page through the rest. Defaults to 0.',
    ),
    head_limit: semanticNumber(z.number().optional()).describe(
      'Return at most N paths (`head -N`). Capped at 100 regardless.',
    ),
    max_depth: semanticNumber(z.number().optional()).describe(
      'How deep to walk below the search directory (`find -maxdepth`). 1 means no recursion. Default: unlimited.',
    ),
    type: z
      .enum(['file', 'dir'])
      .optional()
      .describe(
        '"file" (default) or "dir" (`find -type d`). A directory is inferred from the files in it, so an empty one is not listed.',
      ),
    sort: z
      .enum(['modified', 'path'])
      .optional()
      .describe(
        '"modified" (default, newest first) or "path" (alphabetical, like `find | sort`), which makes a truncated listing a stable prefix.',
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe(
        'Globs to leave out, e.g. ["**/node_modules/**"] — .gitignore is not applied, so this is how a vendored tree is kept out.',
      ),
    '-i': semanticBoolean(z.boolean().optional()).describe(
      'Match the pattern case-insensitively (rg --iglob). Defaults to false — unlike Grep, which applies smart-case, this tool is case-sensitive unless you ask. Use it for the `find -iname` case: "*readme*" with -i finds README.md.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// Cap on how many paths one call returns. Pagination through `offset` is the
// escape hatch — the model is told the next offset whenever this cap bites.
const DEFAULT_GLOB_LIMIT = 100

const outputSchema = lazySchema(() =>
  z.object({
    durationMs: z
      .number()
      .describe('Time taken to execute the search in milliseconds'),
    numFiles: z.number().describe('Total number of files found'),
    filenames: z
      .array(z.string())
      .describe('Array of file paths that match the pattern'),
    truncated: z
      .boolean()
      .describe('Whether results were truncated (limited to 100 files per call)'),
    listedDirectories: z
      .boolean()
      .optional()
      .describe(
        'Set when the listing is directories rather than files, which is what makes the empty-directory caveat apply.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass on the next call to page past a truncated result',
      ),
    incomplete: z
      .enum(['timeout', 'buffer'])
      .optional()
      .describe(
        'Set when ripgrep stopped before finishing the walk, so the listing is a prefix of what matches rather than all of it. Distinct from `truncated`, which is this tool capping a complete listing.',
      ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  searchHint: 'find files by name pattern or wildcard',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Finding ${summary}` : 'Finding files'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.pattern
  },
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
  getPath({ path }): string {
    return path ? expandPath(path) : getCwd()
  },
  async preparePermissionMatcher({ pattern }) {
    return rulePattern => matchWildcardPattern(rulePattern, pattern)
  },
  async validateInput({
    path,
    offset,
    head_limit,
    max_depth,
  }): Promise<ValidationResult> {
    if (offset !== undefined && (offset < 0 || !Number.isFinite(offset))) {
      return {
        result: false,
        message: `offset must be a non-negative number, got: ${offset}`,
        errorCode: 3,
      }
    }
    if (
      head_limit !== undefined &&
      (head_limit < 1 || !Number.isFinite(head_limit))
    ) {
      return {
        result: false,
        message: `head_limit must be a positive number, got: ${head_limit}`,
        errorCode: 3,
      }
    }
    if (
      max_depth !== undefined &&
      (max_depth < 1 || !Number.isFinite(max_depth))
    ) {
      return {
        result: false,
        message: `max_depth must be a positive number, got: ${max_depth}`,
        errorCode: 3,
      }
    }

    // If path is provided, validate that it exists and is a directory
    if (path) {
      const fs = getFsImplementation()
      const absolutePath = expandPath(path)

      // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
      if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
        return { result: true }
      }

      let stats
      try {
        stats = await fs.stat(absolutePath)
      } catch (e: unknown) {
        if (isENOENT(e)) {
          const cwdSuggestion = await suggestPathUnderCwd(absolutePath)
          let message = `Directory does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
          if (cwdSuggestion) {
            message += ` Did you mean ${cwdSuggestion}?`
          }
          return {
            result: false,
            message,
            errorCode: 1,
          }
        }
        throw e
      }

      if (!stats.isDirectory()) {
        return {
          result: false,
          message: `Path is not a directory: ${path}`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      GlobTool,
      input,
      appState.toolPermissionContext,
    )
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // Reuses Grep's render (UI.tsx:65) — shows filenames.join. durationMs/
  // numFiles are "Found 3 files in 12ms" chrome (under-count, fine).
  extractSearchText({ filenames }) {
    return filenames.join('\n')
  },
  async call(input, { abortController, getAppState }) {
    const start = Date.now()
    const appState = getAppState()
    const offset = input.offset ?? 0
    const limit = Math.min(input.head_limit ?? DEFAULT_GLOB_LIMIT, DEFAULT_GLOB_LIMIT)
    const { files, truncated, incomplete } = await glob(
      input.pattern,
      GlobTool.getPath(input),
      {
        limit,
        offset,
        caseInsensitive: input['-i'],
        maxDepth: input.max_depth,
        sort: input.sort,
        type: input.type,
        exclude: input.exclude,
      },
      abortController.signal,
      appState.toolPermissionContext,
    )
    // Relativize paths under cwd to save tokens (same as GrepTool)
    const filenames = files.map(toRelativePath)
    const output: Output = {
      filenames,
      durationMs: Date.now() - start,
      numFiles: filenames.length,
      truncated,
      ...(input.type === 'dir' && { listedDirectories: true }),
      ...(truncated && { nextOffset: offset + filenames.length }),
      // An aborted walk is the caller's own cancellation and its result is
      // discarded, so it is not reported as incompleteness.
      ...((incomplete === 'timeout' || incomplete === 'buffer') && {
        incomplete,
      }),
    }
    return {
      data: output,
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    // Reported even with zero paths: a walk that never finished has not
    // established that nothing matches.
    const incompleteNote =
      output.incomplete === 'timeout'
        ? '(INCOMPLETE: ripgrep was stopped before it finished walking the tree. Any paths above are real but they are not all of them — search a narrower path.)'
        : output.incomplete === 'buffer'
          ? '(INCOMPLETE: the walk produced more output than could be buffered. Any paths above are real but they are not all of them — search a narrower path.)'
          : undefined
    // Said on every directory listing, including the empty one: "no matches"
    // and "no directory holding a matching file" are different answers.
    const directoryNote = output.listedDirectories
      ? '(Directories are inferred from the files inside them, so an empty directory does not appear, and the search root itself is not listed.)'
      : undefined
    if (output.filenames.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: [
          output.listedDirectories ? 'No directories found' : 'No files found',
          ...(directoryNote ? [directoryNote] : []),
          ...(incompleteNote ? [incompleteNote] : []),
        ].join('\n'),
      }
    }
    // Keep the "(Results are truncated" prefix: summarizeGlobOutput matches on
    // it to tell the notice apart from a path.
    const truncationNote =
      output.nextOffset !== undefined
        ? `(Results are truncated. Pass offset=${output.nextOffset} for the next page, or use a more specific path or pattern.)`
        : '(Results are truncated. Consider using a more specific path or pattern.)'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        ...output.filenames,
        ...(output.truncated ? [truncationNote] : []),
        ...(directoryNote ? [directoryNote] : []),
        ...(incompleteNote ? [incompleteNote] : []),
      ].join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
