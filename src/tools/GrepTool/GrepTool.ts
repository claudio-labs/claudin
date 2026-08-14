import { z } from 'zod/v4'
import type { ValidationResult } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { getCwd } from 'src/utils/fs/cwd.js'
import { isENOENT } from 'src/utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  suggestPathUnderCwd,
} from 'src/utils/fs/file.js'
import { getFsImplementation } from 'src/utils/fs/fsOperations.js'
import { lazySchema } from 'src/utils/data/lazySchema.js'
import { expandPath, toRelativePath } from 'src/utils/fs/path.js'
import { relativizeRgLine, RG_LINE_RE } from './relativize.js'
import {
  checkReadPermissionForTool,
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from 'src/services/permissions/filesystem.js'
import type { PermissionDecision } from 'src/services/permissions/PermissionResult.js'
import { matchWildcardPattern } from 'src/services/permissions/shellRuleMatching.js'
import { getGlobExclusionsForPluginCache } from 'src/services/plugins/orphanedPluginFilter.js'
import { ripGrepWithStatus } from 'src/utils/fs/ripgrep.js'
import { semanticBoolean } from 'src/utils/data/semanticBoolean.js'
import { semanticNumber } from 'src/utils/data/semanticNumber.js'
import { plural } from 'src/utils/text/stringUtils.js'
import { buildSymbolsOutput } from './symbolsOutput.js'
import { GREP_TOOL_NAME, getDescription } from './prompt.js'
import {
  GREP_AUTO_PIVOT_FOOTER,
  grepAutoPivotEnabled,
  measureGrepShape,
  pivotWins,
  shouldAutoPivot,
} from './autoPivot.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z
      .string()
      .describe(
        'The regular expression pattern to search for in file contents',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'File or directory to search in (rg PATH). Defaults to current working directory.',
      ),
    glob: z
      .string()
      .optional()
      .describe(
        'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
      ),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count', 'symbols'])
      .optional()
      .describe(
        'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit), "symbols" maps each match to the enclosing function/class signature (TS/JS, Python, Go, Java, Kotlin, C#, Rust, C/C++, PHP, Swift, Scala, Ruby, Lua, Bash, SQL, CSS/SCSS, HTML, Markdown, YAML, XML, .properties, .env, TOML, Dockerfile, Makefile, GraphQL, Terraform). Defaults to "files_with_matches".',
      ),
    '-B': semanticNumber(z.number().optional()).describe(
      'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
    ),
    '-A': semanticNumber(z.number().optional()).describe(
      'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
    ),
    '-C': semanticNumber(z.number().optional()).describe(
      'Alias for context; when both are given, context wins. Requires output_mode: "content", ignored otherwise.',
    ),
    context: semanticNumber(z.number().optional()).describe(
      'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
    ),
    '-n': semanticBoolean(z.boolean().optional()).describe(
      'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
    ),
    '-i': semanticBoolean(z.boolean().optional()).describe(
      'Force case-insensitive (true) or case-sensitive (false) matching. When omitted, ripgrep smart-case applies: a lowercase pattern matches any case, a pattern containing an uppercase letter does not.',
    ),
    no_ignore: semanticBoolean(z.boolean().optional()).describe(
      'Also search files excluded by .gitignore/.ignore (rg --no-ignore). Off by default; a search that finds nothing retries with this automatically and says so.',
    ),
    binary: semanticBoolean(z.boolean().optional()).describe(
      'Search binary files as if they were text (rg -a). Off by default, so matches inside binaries are invisible without it.',
    ),
    encoding: z
      .string()
      .optional()
      .describe(
        'Force a text encoding (rg --encoding), e.g. "utf-16le", "utf-16be", "shift_jis", "windows-1252", "euc-jp", "gbk". Default is UTF-8 with BOM sniffing, so UTF-16 without a BOM is otherwise skipped as binary.',
      ),
    type: z
      .string()
      .optional()
      .describe(
        'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
      ),
    head_limit: semanticNumber(z.number().optional()).describe(
      'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
    ),
    offset: semanticNumber(z.number().optional()).describe(
      'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
    ),
    multiline: semanticBoolean(z.boolean().optional()).describe(
      'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// Version control system directories to exclude from searches
// These are excluded automatically because they create noise in search results
const VCS_DIRECTORIES_TO_EXCLUDE = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
] as const

// Default cap on grep results when head_limit is unspecified. Unbounded content-mode
// greps can fill up to the 20KB persist threshold (~6-24K tokens/grep-heavy session).
// 250 is generous enough for exploratory searches while preventing context bloat.
// Pass head_limit=0 explicitly for unlimited.
const DEFAULT_HEAD_LIMIT = 250

/**
 * The retry that searches .gitignore'd files after a search comes back empty.
 * On by default; `CLAUDIN_DISABLE_GREP_IGNORED_FALLBACK=1` turns it off for a
 * session, at the cost of putting "found nothing" and "did not look there"
 * back under the same answer.
 */
function grepIgnoredFallbackEnabled(): boolean {
  return process.env.CLAUDIN_DISABLE_GREP_IGNORED_FALLBACK !== '1'
}

/**
 * Header for a result that only exists outside version control. Names the count
 * it actually measured rather than raising the possibility of one — a hint the
 * tool cannot back with a number is the kind that measured zero adoption.
 */
function formatIgnoredOnlyNote(count: number, unit: string): string {
  return `No matches in tracked files. The ${count} ${plural(count, unit)} below ${count === 1 ? 'is' : 'are'} in files excluded by .gitignore, searched only because the first pass found nothing. Pass no_ignore: true to include them from the start.`
}

function formatIncompleteNote(reason: 'timeout' | 'buffer'): string {
  return reason === 'timeout'
    ? 'INCOMPLETE: ripgrep was stopped before it finished walking the tree. The matches above are real but they are not all of them — narrow the search with path, glob or type.'
    : 'INCOMPLETE: the search produced more output than could be buffered. The matches above are real but they are not all of them — narrow the search with path, glob or type, or use head_limit.'
}

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  // Explicit 0 = unlimited escape hatch
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effectiveLimit)
  // Only report appliedLimit when truncation actually occurred, so the model
  // knows there may be more results and can paginate with offset.
  const wasTruncated = items.length - offset > effectiveLimit
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  }
}

// Format limit/offset information for display in tool results.
// appliedLimit is only set when truncation actually occurred (see applyHeadLimit),
// so it may be undefined even when appliedOffset is set — build parts conditionally
// to avoid "limit: undefined" appearing in user-visible output.
function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

export { RG_LINE_RE, RG_PREFIX_RE, relativizeRgLine } from './relativize.js'

const outputSchema = lazySchema(() =>
  z.object({
    mode: z
      .enum(['content', 'files_with_matches', 'count', 'symbols'])
      .optional(),
    numFiles: z.number(),
    filenames: z.array(z.string()),
    content: z.string().optional(),
    numLines: z.number().optional(), // For content mode
    numMatches: z.number().optional(), // For count mode
    appliedLimit: z.number().optional(), // The limit that was applied (if any)
    appliedOffset: z.number().optional(), // The offset that was applied
    // Set when a content-mode search was broad enough that the symbol map
    // replaced its lines (see autoPivot.ts). Drives the footer and the
    // breadth clause in the header below.
    autoPivot: z.boolean().optional(),
    totalMatchLines: z.number().optional(), // Match lines the search produced
    totalMatchFiles: z.number().optional(), // Files those lines came from
    // Set when the tracked files held nothing and the matches below came from
    // the .gitignore'd retry. Without it the result reads as an ordinary hit.
    ignoredOnly: z.boolean().optional(),
    // Set when ripgrep was cut short, so the results are a prefix of the real
    // ones rather than all of them.
    incomplete: z.enum(['timeout', 'buffer']).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  searchHint: 'search file contents with regex (ripgrep)',
  // 20K chars - tool result persistence threshold
  maxResultSizeChars: 20_000,
  strict: true,
  async description() {
    return getDescription()
  },
  userFacingName() {
    return 'Search'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching'
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
    return input.path ? `${input.pattern} in ${input.path}` : input.pattern
  },
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
  getPath({ path }): string {
    return path || getCwd()
  },
  async preparePermissionMatcher({ pattern }) {
    return rulePattern => matchWildcardPattern(rulePattern, pattern)
  },
  async validateInput({ path }): Promise<ValidationResult> {
    // If path is provided, validate that it exists
    if (path) {
      const fs = getFsImplementation()
      const absolutePath = expandPath(path)

      // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
      if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
        return { result: true }
      }

      try {
        await fs.stat(absolutePath)
      } catch (e: unknown) {
        if (isENOENT(e)) {
          const cwdSuggestion = await suggestPathUnderCwd(absolutePath)
          let message = `Path does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
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
    }

    return { result: true }
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      GrepTool,
      input,
      appState.toolPermissionContext,
    )
  },
  async prompt() {
    return getDescription()
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // SearchResultSummary shows content (mode=content) or filenames.join.
  // numFiles/numLines/numMatches are chrome ("Found 3 files") — fine to
  // skip (under-count, not phantom). Glob reuses this via UI.tsx:65.
  extractSearchText({ mode, content, filenames }) {
    if (mode === 'content' && content) return content
    return filenames.join('\n')
  },
  mapToolResultToToolResultBlockParam(
    {
      mode = 'files_with_matches',
      numFiles,
      filenames,
      content,
      numLines: _numLines,
      numMatches,
      appliedLimit,
      appliedOffset,
      autoPivot,
      totalMatchLines,
      totalMatchFiles,
      ignoredOnly,
      incomplete,
    },
    toolUseID,
  ) {
    // The two search-level notes bracket whatever the mode renders: why these
    // results exist at all, and whether they are all of them.
    const withNotes = (body: string, ignoredCount: number, unit: string) => {
      const parts: string[] = []
      if (ignoredOnly) parts.push(formatIgnoredOnlyNote(ignoredCount, unit))
      parts.push(body)
      if (incomplete) parts.push(formatIncompleteNote(incomplete))
      return parts.join('\n\n')
    }

    if (mode === 'content') {
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
      const resultContent = content || 'No matches found'
      const finalContent = limitInfo
        ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
        : resultContent
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: withNotes(finalContent, _numLines ?? 0, 'match'),
      }
    }

    if (mode === 'count') {
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
      const rawContent = content || 'No matches found'
      const matches = numMatches ?? 0
      const files = numFiles ?? 0
      const summary = `\n\nFound ${matches} total ${matches === 1 ? 'occurrence' : 'occurrences'} across ${files} ${files === 1 ? 'file' : 'files'}.${limitInfo ? ` with pagination = ${limitInfo}` : ''}`
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: withNotes(rawContent + summary, matches, 'occurrence'),
      }
    }

    if (mode === 'symbols') {
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
      if (!content) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: 'No matches found',
        }
      }
      const matches = numMatches ?? 0
      const files = numFiles ?? 0
      let header = `Found ${matches} matched ${matches === 1 ? 'symbol' : 'symbols'} across ${files} ${files === 1 ? 'file' : 'files'}${limitInfo ? ` (pagination = ${limitInfo})` : ''}`
      // An auto-pivoted result maps only the lines that would have been sent,
      // so state how much wider the search actually was — that is the number
      // the model needs to decide between narrowing and paginating.
      if (autoPivot && totalMatchLines !== undefined && appliedLimit) {
        header += `\nThe search matched ${totalMatchLines} lines in ${totalMatchFiles} files; the first ${appliedLimit} are mapped below.`
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: withNotes(
          autoPivot
            ? `${header}\n\n${content}${GREP_AUTO_PIVOT_FOOTER}`
            : `${header}\n\n${content}`,
          matches,
          'symbol',
        ),
      }
    }

    // files_with_matches mode
    const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
    if (numFiles === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
      }
    }
    // head_limit has already been applied in call() method, so just show all filenames
    const result = `Found ${numFiles} ${plural(numFiles, 'file')}${limitInfo ? ` ${limitInfo}` : ''}\n${filenames.join('\n')}`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: withNotes(result, numFiles, 'file'),
    }
  },
  async call(
    {
      pattern,
      path,
      glob,
      type,
      output_mode = 'files_with_matches',
      '-B': context_before,
      '-A': context_after,
      '-C': context_c,
      context,
      '-n': show_line_numbers = true,
      '-i': case_insensitive,
      no_ignore = false,
      binary = false,
      encoding,
      head_limit,
      offset = 0,
      multiline = false,
    },
    { abortController, getAppState },
  ) {
    const absolutePath = path ? expandPath(path) : getCwd()
    const args = ['--hidden']

    // Off by default: including .gitignore'd files means walking node_modules
    // and build output on every search. The zero-result fallback below is what
    // keeps that from turning into a silent miss.
    if (no_ignore) {
      args.push('--no-ignore')
    }

    // Exclude VCS directories to avoid noise from version control metadata
    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
      args.push('--glob', `!${dir}`)
    }

    // Limit line length to prevent base64/minified content from cluttering output
    args.push('--max-columns', '500')

    // Only apply multiline flags when explicitly requested
    if (multiline) {
      args.push('-U', '--multiline-dotall')
    }

    // Add optional flags
    // Smart-case unless the caller decided: a lowercase pattern matches any
    // case, a pattern carrying an uppercase letter stays sensitive. Plain
    // case-sensitive matching (ripgrep's own default) makes a search for
    // `zqprobe` miss `ZQPROBE`, which reads as "not there".
    if (case_insensitive === true) {
      args.push('-i')
    } else if (case_insensitive === false) {
      args.push('--case-sensitive')
    } else {
      args.push('--smart-case')
    }

    if (binary) {
      args.push('--text')
    }

    // Passed through unvalidated on purpose: ripgrep accepts every label in the
    // Encoding Standard and owns that list. A bad one comes back as a usage
    // error rather than as zero matches (see ripGrepWithStatus).
    if (encoding) {
      args.push('--encoding', encoding)
    }

    // Add output mode flags
    if (output_mode === 'files_with_matches') {
      args.push('-l')
    } else if (output_mode === 'count') {
      args.push('-c')
    }

    // Add line numbers if requested. 'symbols' mode always needs them — the
    // line number is what maps each match to its enclosing symbol.
    if (
      (show_line_numbers && output_mode === 'content') ||
      output_mode === 'symbols'
    ) {
      args.push('-n')
    }

    // 'symbols' mode parses `path:line:text`, so the filename must always be
    // present. rg omits it when the search target is a single file — force it
    // with -H so single-file greps don't parse as `line:text` and drop matches.
    if (output_mode === 'symbols') {
      args.push('-H')
    }

    // Add context flags (-C/context takes precedence over context_before/context_after)
    if (output_mode === 'content') {
      if (context !== undefined) {
        args.push('-C', context.toString())
      } else if (context_c !== undefined) {
        args.push('-C', context_c.toString())
      } else {
        if (context_before !== undefined) {
          args.push('-B', context_before.toString())
        }
        if (context_after !== undefined) {
          args.push('-A', context_after.toString())
        }
      }
    }

    // If pattern starts with dash, use -e flag to specify it as a pattern
    // This prevents ripgrep from interpreting it as a command-line option
    if (pattern.startsWith('-')) {
      args.push('-e', pattern)
    } else {
      args.push(pattern)
    }

    // Add type filter if specified
    if (type) {
      args.push('--type', type)
    }

    if (glob) {
      // Split on commas and spaces, but preserve patterns with braces
      const globPatterns: string[] = []
      const rawPatterns = glob.split(/\s+/)

      for (const rawPattern of rawPatterns) {
        // If pattern contains braces, don't split further
        if (rawPattern.includes('{') && rawPattern.includes('}')) {
          globPatterns.push(rawPattern)
        } else {
          // Split on commas for patterns without braces
          globPatterns.push(...rawPattern.split(',').filter(Boolean))
        }
      }

      for (const globPattern of globPatterns.filter(Boolean)) {
        args.push('--glob', globPattern)
      }
    }

    // Add ignore patterns
    const appState = getAppState()
    const ignorePatterns = normalizePatternsToPath(
      getFileReadIgnorePatterns(appState.toolPermissionContext),
      getCwd(),
    )
    for (const ignorePattern of ignorePatterns) {
      // Note: ripgrep only applies gitignore patterns relative to the working directory
      // So for non-absolute paths, we need to prefix them with '**'
      // See: https://github.com/BurntSushi/ripgrep/discussions/2156#discussioncomment-2316335
      //
      // We also need to negate the pattern with `!` to exclude it
      const rgIgnorePattern = ignorePattern.startsWith('/')
        ? `!${ignorePattern}`
        : `!**/${ignorePattern}`
      args.push('--glob', rgIgnorePattern)
    }

    // Exclude orphaned plugin version directories
    for (const exclusion of await getGlobExclusionsForPluginCache(
      absolutePath,
    )) {
      args.push('--glob', exclusion)
    }

    // WSL has severe performance penalty for file reads (3-5x slower on WSL2)
    // The timeout is handled by ripgrep itself via execFile timeout option
    // We don't use AbortController for timeout to avoid interrupting the agent loop
    // If ripgrep times out, it throws RipgrepTimeoutError which propagates up
    // so Claude knows the search didn't complete (rather than thinking there were no matches)
    const search = await ripGrepWithStatus(
      args,
      absolutePath,
      abortController.signal,
    )

    // ripgrep refused the invocation — a bad regex, an unknown --encoding
    // label, an unrecognized flag. It searched nothing, so an empty result here
    // would read as "no matches" and send the caller looking in the wrong place.
    if (search.usageError) {
      throw new Error(
        `ripgrep rejected this search, so nothing was searched:\n${search.usageError}`,
      )
    }

    let results = search.lines
    let incomplete = search.incomplete

    // Nothing in the tracked files. Before reporting that, look in the files
    // .gitignore hides — build output, generated code, vendored trees — because
    // "no matches" and "I did not look there" are not the same answer.
    let ignoredOnly = false
    if (
      results.length === 0 &&
      !no_ignore &&
      incomplete === null &&
      grepIgnoredFallbackEnabled()
    ) {
      const fallback = await ripGrepWithStatus(
        [...args, '--no-ignore'],
        absolutePath,
        abortController.signal,
      )
      if (fallback.lines.length > 0) {
        results = fallback.lines
        incomplete = fallback.incomplete
        ignoredOnly = true
      }
    }

    // Both describe the search rather than the output mode, so every return
    // path below carries them. An aborted search is the caller's own doing and
    // its result is discarded, so it is not reported as incompleteness.
    const searchNotes = {
      ...(ignoredOnly && { ignoredOnly: true }),
      ...((incomplete === 'timeout' || incomplete === 'buffer') && {
        incomplete,
      }),
    }

    if (output_mode === 'content') {
      // For content mode, results are the actual content lines
      // Convert absolute paths to relative paths to save tokens

      // Apply head_limit first — relativize is per-line work, so
      // avoid processing lines that will be discarded (broad patterns can
      // return 10k+ lines with head_limit keeping only ~30-100).
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )

      const finalLines = limitedResults.map(line =>
        relativizeRgLine(line, absolutePath),
      )
      const contentText = finalLines.join('\n')

      // A search wide enough that its first N lines are an arbitrary slice
      // answers better as a symbol map. Measured on the raw rg lines (so the
      // file count is the map's file count) but sized on the relativized text
      // that would actually be sent. See autoPivot.ts for the thresholds.
      if (grepAutoPivotEnabled()) {
        const shape = measureGrepShape(limitedResults, contentText.length)
        if (
          shouldAutoPivot({
            shape,
            headLimitGiven: head_limit !== undefined,
            offset,
            lineNumbers: show_line_numbers,
          })
        ) {
          const symbols = await buildSymbolsOutput(limitedResults, encoding)
          if (pivotWins(symbols.content.length, contentText.length)) {
            const total = measureGrepShape(results, 0)
            return {
              data: {
                mode: 'symbols' as const,
                autoPivot: true,
                numFiles: symbols.numFiles,
                filenames: symbols.filenames,
                content: symbols.content,
                numMatches: symbols.numMatches,
                totalMatchLines: total.matchLines,
                totalMatchFiles: total.files,
                ...(appliedLimit !== undefined && { appliedLimit }),
                ...searchNotes,
              },
            }
          }
        }
      }

      const output = {
        mode: 'content' as const,
        numFiles: 0, // Not applicable for content mode
        filenames: [],
        content: contentText,
        numLines: finalLines.length,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
        ...searchNotes,
      }
      return { data: output }
    }

    if (output_mode === 'symbols') {
      // rg ran in content mode with -n (abs:line:text). Map each match to
      // its enclosing function/class; head_limit bounds the rg lines fed in.
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )
      const symbols = await buildSymbolsOutput(limitedResults, encoding)
      const output = {
        mode: 'symbols' as const,
        numFiles: symbols.numFiles,
        filenames: symbols.filenames,
        content: symbols.content,
        numMatches: symbols.numMatches,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
        ...searchNotes,
      }
      return { data: output }
    }

    if (output_mode === 'count') {
      // For count mode, pass through raw ripgrep output (filename:count format)
      // Apply head_limit first to avoid relativizing entries that will be discarded.
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )

      // Convert absolute paths to relative paths to save tokens
      const finalCountLines = limitedResults.map(line => {
        // Lines have format: /absolute/path:count
        const colonIndex = line.lastIndexOf(':')
        if (colonIndex > 0) {
          const filePath = line.substring(0, colonIndex)
          const count = line.substring(colonIndex)
          return toRelativePath(filePath) + count
        }
        return line
      })

      // Parse count output to extract total matches and file count
      let totalMatches = 0
      let fileCount = 0
      for (const line of finalCountLines) {
        const colonIndex = line.lastIndexOf(':')
        if (colonIndex > 0) {
          const countStr = line.substring(colonIndex + 1)
          const count = parseInt(countStr, 10)
          if (!isNaN(count)) {
            totalMatches += count
            fileCount += 1
          }
        }
      }

      const output = {
        mode: 'count' as const,
        numFiles: fileCount,
        filenames: [],
        content: finalCountLines.join('\n'),
        numMatches: totalMatches,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
        ...searchNotes,
      }
      return { data: output }
    }

    // For files_with_matches mode (default)
    // Use allSettled so a single ENOENT (file deleted between ripgrep's scan
    // and this stat) does not reject the whole batch. Failed stats sort as mtime 0.
    const stats = await Promise.allSettled(
      results.map(_ => getFsImplementation().stat(_)),
    )
    const sortedMatches = results
      // Sort by modification time
      .map((_, i) => {
        const r = stats[i]!
        return [
          _,
          r.status === 'fulfilled' ? (r.value.mtimeMs ?? 0) : 0,
        ] as const
      })
      .sort((a, b) => {
        const timeComparison = b[1] - a[1]
        if (timeComparison === 0) {
          // Filename tiebreaker — this is what keeps the order deterministic
          // for files written in the same millisecond (tests included).
          return a[0].localeCompare(b[0])
        }
        return timeComparison
      })
      .map(_ => _[0])

    // Apply head_limit to sorted file list (like "| head -N")
    const { items: finalMatches, appliedLimit } = applyHeadLimit(
      sortedMatches,
      head_limit,
      offset,
    )

    // Convert absolute paths to relative paths to save tokens
    const relativeMatches = finalMatches.map(toRelativePath)

    const output = {
      mode: 'files_with_matches' as const,
      filenames: relativeMatches,
      numFiles: relativeMatches.length,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
      ...searchNotes,
    }

    return {
      data: output,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
