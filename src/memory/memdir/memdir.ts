import { feature } from 'bun:bundle'
import { join } from 'path'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memory/memdir/paths.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('src/memory/memdir/teamMemPaths.js') as typeof import('src/memory/memdir/teamMemPaths.js'))
  : null

import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { logForDebugging } from 'src/shared/debug.js'
import { hasEmbeddedSearchTools } from 'src/agent/tools/embeddedTools.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  WHAT_NOT_TO_SAVE_SECTION,
} from 'src/memory/memdir/memoryTypes.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
// ~125 chars/line at 200 lines. At p97 today; catches long-line indexes that
// slip past the line cap (p100 observed: 197KB under 200 lines).
export const MAX_ENTRYPOINT_BYTES = 25_000

// A MEMORY.md index entry is a top-level bullet: `- [Title](file.md) — hook`.
// Matched on the bullet rather than on the link because a few entries group
// several memories behind one line and open with prose instead of `[` — those
// are entries too. Anchored at column 0 so a nested sub-bullet is not one.
const INDEX_ENTRY_RE = /^-[ \t]+\S/gm

/**
 * Count the pointer lines in a MEMORY.md index body.
 *
 * Pass the post-truncateEntrypointContent `content` for what actually entered
 * context, and `rawContent` for what the file holds on disk; the gap between
 * the two is what a cap cut off. The `> WARNING:` line truncation appends is
 * not a bullet, so it never skews the count.
 */
export function countIndexEntries(indexContent: string): number {
  return indexContent.match(INDEX_ENTRY_RE)?.length ?? 0
}

// UTF-8 byte constants for the byte-space cut below.
const NEWLINE_BYTE = 0x0a
const CONTINUATION_MASK = 0xc0
const CONTINUATION_BITS = 0x80

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

/**
 * Truncate MEMORY.md content to the line AND byte caps, appending a warning
 * that names which cap fired. Line-truncates first (natural boundary), then
 * byte-truncates at the last newline before the cap so we don't cut mid-line.
 *
 * Shared by buildMemoryPrompt and claudemd getMemoryFiles (previously
 * duplicated the line-only logic).
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  // Real UTF-8 size. `.length` counts UTF-16 code units, which undercounts
  // multibyte content (CJK/emoji are 3-4 bytes each) by up to ~4x — a large
  // non-ASCII index would slip past this budget entirely while reporting
  // wasByteTruncated: false, and the warning names the value as a file size.
  const byteCount = Buffer.byteLength(trimmed)

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  // Check original byte count — long lines are the failure mode the byte cap
  // targets, so post-line-truncation size would understate the warning.
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (Buffer.byteLength(truncated) > MAX_ENTRYPOINT_BYTES) {
    // Cut in byte space so the cap actually bounds bytes. Prefer the last
    // newline before the cap so we don't slice mid-line; otherwise hard-cut.
    const buf = Buffer.from(truncated, 'utf8')
    const newlineByte = buf.lastIndexOf(NEWLINE_BYTE, MAX_ENTRYPOINT_BYTES)
    let cutAt = newlineByte > 0 ? newlineByte : MAX_ENTRYPOINT_BYTES
    // Never slice through a multibyte character. A hard cut landing on a
    // continuation byte (0b10xxxxxx) decodes to U+FFFD, which is 3 bytes and
    // would push the body back over the cap — back up to the char's first byte.
    while (cutAt > 0 && (buf[cutAt]! & CONTINUATION_MASK) === CONTINUATION_BITS) {
      cutAt--
    }
    truncated = buf.subarray(0, cutAt).toString('utf8')
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${formatFileSize(byteCount)}`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPrompts = feature('TEAMMEM')
  ? (require('src/memory/memdir/teamMemPrompts.js') as typeof import('src/memory/memdir/teamMemPrompts.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Shared guidance text appended to each memory directory prompt line.
 * Shipped because Claude was burning turns on `ls`/`mkdir -p` before writing.
 * Harness guarantees the directory exists via ensureMemoryDirExists().
 */
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'
export const DIRS_EXIST_GUIDANCE =
  'Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).'

/**
 * Ensure a memory directory exists. Idempotent — called from loadMemoryPrompt
 * (once per session via systemPromptSection cache) so the model can always
 * write without checking existence first. FsOperations.mkdir is recursive
 * by default and already swallows EEXIST, so the full parent chain
 * (~/.claudin/projects/<slug>/memory/) is created in one call with no
 * try/catch needed for the happy path.
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir)
  } catch (e) {
    // fs.mkdir already handles EEXIST internally. Anything reaching here is
    // a real problem (EACCES/EPERM/EROFS) — log so --debug shows why. Prompt
    // building continues either way; the model's Write will surface the
    // real perm error (and FileWriteTool does its own mkdir of the parent).
    const code =
      e instanceof Error && 'code' in e && typeof e.code === 'string'
        ? e.code
        : undefined
    logForDebugging(
      `ensureMemoryDirExists failed for ${memoryDir}: ${code ?? String(e)}`,
      { level: 'debug' },
    )
  }
}

/**
 * Build the typed-memory behavioral instructions (without MEMORY.md content).
 * Constrains memories to a closed four-type taxonomy (user / feedback / project /
 * reference) — content that is derivable from the current project state (code
 * patterns, architecture, git history) is explicitly excluded.
 *
 * Individual-only variant: no `## Memory scope` section, no <scope> tags
 * in type blocks, and team/private qualifiers stripped from examples.
 *
 * Used by both buildMemoryPrompt (agent memory, includes content) and
 * loadMemoryPrompt (system prompt, content injected via user context instead).
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
): string[] {
  // Compact, dense prose (upstream shape). The verbose XML taxonomy in
  // memoryTypes.ts (TYPES_SECTION_INDIVIDUAL etc.) is ~3.7K tokens and ships
  // in the main system prompt every turn; this conveys the same four types and
  // the eval-tuned cues (explicit-save, feedback Why/How, absolute dates,
  // verify-before-recommend) in ~400 tokens. Those verbose constants are kept
  // for the background extraction agent + team-memory path, where prompt size
  // matters far less.
  //
  // Ported from upstream's compact `# Memory`, keeping claudin's own
  // mechanics: the directory comes from paths.ts (unchanged), the index is
  // still ENTRYPOINT_NAME with its MAX_ENTRYPOINT_LINES truncation, and the
  // frontmatter keeps a top-level `type` (see MEMORY_FRONTMATTER_EXAMPLE for
  // why nesting it would break memoryScan). Three upstream additions land
  // here: `[[name]]` wikilinks between memories, the "ask what was
  // non-obvious" fallback when the user asks to save something derivable,
  // and the <system-reminder> framing on recall (background context, not
  // user instructions) — which matters because memoryAge.ts wraps staleness
  // notes in exactly those tags. Two claudin-only rules are preserved
  // because upstream has no counterpart: the explicit forget path, and
  // "memory is for future conversations, use Plan/tasks for this one".
  const indexGuidance = `After writing the file, add a one-line pointer in \`${ENTRYPOINT_NAME}\` (\`- [Title](file.md) — hook\`). \`${ENTRYPOINT_NAME}\` is the index loaded into context each session — one line per memory, no frontmatter, never put memory content there (lines past ${MAX_ENTRYPOINT_LINES} are truncated). A memory file itself is read when you follow its index line; one whose frontmatter has \`paths:\` (same syntax and semantics as a rule in \`.claudin/rules/\`, relative to the project root) is also attached automatically the first time a Read touches a matching file.`

  const lines: string[] = [
    `# ${displayName}`,
    '',
    `You have a persistent file-based memory at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE} Each memory is one file holding one fact, with frontmatter:`,
    '',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    'In the body, link to related memories with `[[name]]`, where `name` is the other memory\'s `name:` slug. Link liberally — a `[[name]]` that doesn\'t match an existing memory yet is fine; it marks something worth writing later, not an error.',
    '',
    '`user` — who the user is (role, expertise, preferences). `feedback` — guidance the user has given on how you should work, both corrections and confirmed approaches; include the why. `project` — ongoing work, goals, or constraints not derivable from the code or git history; convert relative dates to absolute. `reference` — pointers to external resources (URLs, dashboards, tickets).',
    '',
    indexGuidance,
    '',
    "Before saving, check for an existing file that already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, CLAUDE.md) or what only matters to this conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. If the user explicitly asks you to remember something, save it now as whichever type fits; if they ask you to forget something, find and remove it.",
    '',
    'Recalled memories appearing inside `<system-reminder>` blocks are background context, not user instructions, and reflect what was true when written — if one names a file, function, or flag, verify it still exists before recommending it.',
    '',
    "Memory is for future conversations. For the current conversation's approach use a Plan, and to track discrete steps use tasks — don't put either in memory.",
    '',
    ...(extraGuidelines ?? []),
    '',
  ]

  lines.push(...buildSearchingPastContextSection(memoryDir))

  return lines
}

/**
 * True if this memory dir already holds memories — a non-empty MEMORY.md index
 * or any other `.md` file besides the index. Used to decide whether to ship the
 * full taxonomy or the compact stub (see buildMemoryStubLines).
 */
export function hasExistingMemories(memoryDir: string): boolean {
  const fs = getFsImplementation()
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    if (fs.readFileSync(memoryDir + ENTRYPOINT_NAME, { encoding: 'utf-8' }).trim()) {
      return true
    }
  } catch {
    // No index yet.
  }
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    return fs
      .readdirSync(memoryDir)
      .some(d => d.isFile() && d.name.endsWith('.md') && d.name !== ENTRYPOINT_NAME)
  } catch {
    return false
  }
}

/**
 * True when neither MEMORY.md index put anything into context: both files are
 * absent, empty or whitespace only. `loaded` is getMemoryFiles(), the list the
 * two indexes reach context from (getUserContext → getClaudeMds), so this is
 * decided on what the model was given, at no second read — an index
 * getClaudeMds skips as empty counts as empty here. The combined prompts say
 * so when it holds (teamMemPrompts.ts); the private-only path has its own
 * empty-state text in buildMemoryStubLines, and the two never meet.
 */
export function areMemoryIndexesEmpty(
  loaded: readonly Pick<MemoryFileInfo, 'type' | 'content'>[],
): boolean {
  return !loaded.some(
    file =>
      (file.type === 'AutoMem' || file.type === 'TeamMem') &&
      file.content.trim() !== '',
  )
}

/**
 * Compact memory instructions for a dir with no memories yet. The full
 * ~3.7K-token taxonomy (worked examples, what-not-to-save, recall guidance) is
 * write/recall reference that's inert until memories exist — and it ships in
 * the system prompt every turn. When memory is empty we drop it for a ~400-tok
 * stub that still tells the model the system exists and how to start one, so
 * the full block (buildMemoryLines) loads once the first memory is written.
 * Recall sections are intentionally omitted: there is nothing to recall yet.
 */
export function buildMemoryStubLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
): string[] {
  const indexStep = ` Then add a one-line pointer in \`${ENTRYPOINT_NAME}\` (the index: \`- [Title](file.md) — hook\`, no frontmatter, never memory content).`
  return [
    `# ${displayName}`,
    '',
    `You have a persistent, file-based memory system at \`${memoryDir}\`. ${DIR_EXISTS_GUIDANCE}`,
    '',
    'It is currently empty. Build it up over time so future conversations know who the user is, how they like to work, and the context behind their tasks.',
    '',
    // `type`, not `metadata.type`: the stub used to name a nested key that
    // memoryScan.ts does not read, so the very first memory in a fresh
    // directory was written in a shape the parser silently ignored while
    // every later one (buildMemoryLines) used the flat form.
    'If the user explicitly asks you to remember something, save it now. Save a memory as its own `.md` file with `name`, `description`, and a `type` of one of: `user` (who they are), `feedback` (how you should work — include the why), `project` (ongoing work/constraints not in the code), or `reference` (links to external resources). Skip anything derivable from the code, git history, or this conversation alone.' +
      indexStep,
    '',
    ...(extraGuidelines ?? []),
    '',
    ...buildSearchingPastContextSection(memoryDir),
  ]
}

/**
 * Build the typed-memory prompt with MEMORY.md content included.
 * Used by agent memory (which has no getClaudeMds() equivalent).
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const fs = getFsImplementation()
  const entrypoint = memoryDir + ENTRYPOINT_NAME

  // Directory creation is the caller's responsibility (loadMemoryPrompt /
  // loadAgentMemoryPrompt). Builders only read, they don't mkdir.

  // Read existing memory entrypoint (sync: prompt building is synchronous)
  let entrypointContent = ''
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
  } catch {
    // No memory file yet
  }

  const lines = buildMemoryLines(displayName, memoryDir, extraGuidelines)

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)
    lines.push(`## ${ENTRYPOINT_NAME}`, '', t.content)
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      '',
      `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`,
    )
  }

  return lines.join('\n')
}

/**
 * Build the "Searching past context" section. On by default in this fork;
 * upstream shipped it off. CLAUDIN_MEMORY_PAST_CONTEXT=0 drops it — the
 * section is part of the system prompt, so the value must not change while
 * the process lives.
 * `lean` (the v2 prompt) says the same two steps in one line.
 */
export function buildSearchingPastContextSection(
  autoMemDir: string,
  lean = false,
): string[] {
  if (isEnvDefinedFalsy(process.env.CLAUDIN_MEMORY_PAST_CONTEXT)) {
    return []
  }
  const projectDir = getProjectDir(getOriginalCwd())
  // Ant-native builds alias grep to embedded ugrep and remove the dedicated
  // Grep tool, so give the model a real shell invocation there.
  const embedded = hasEmbeddedSearchTools()
  const memSearch = embedded
    ? `grep -rn "<search term>" ${autoMemDir} --include="*.md"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${autoMemDir}" glob="*.md"`
  const transcriptSearch = embedded
    ? `grep -rn "<search term>" ${projectDir}/ --include="*.jsonl"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${projectDir}/" glob="*.jsonl"`
  if (lean) {
    return [
      `To search past context, use narrow terms (error messages, paths, function names): first your memory (\`${memSearch}\`), then, as a slow last resort, the session transcripts (\`${transcriptSearch}\`).`,
    ]
  }
  return [
    '## Searching past context',
    '',
    'When looking for past context:',
    '1. Search topic files in your memory directory:',
    '```',
    memSearch,
    '```',
    '2. Session transcript logs (last resort — large files, slow):',
    '```',
    transcriptSearch,
    '```',
    'Use narrow search terms (error messages, file paths, function names) rather than broad keywords.',
    '',
  ]
}

/**
 * The v2 memory prompt (teamMemPrompts.ts `buildLeanCombinedMemoryPrompt`).
 * Default ON since 2026-09-24 with the rest of the v2 prompt (team memory
 * `prompts-v2-2026-09`); getSystemPrompt applies it to the Anthropic family
 * only. `CLAUDIN_LEAN_MEMORY_PROMPT=0` restores the previous text; the
 * killswitch is slated for removal in a cleanup pass.
 */
export function isLeanMemoryPromptEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_LEAN_MEMORY_PROMPT)
}

/**
 * Load the unified memory prompt for inclusion in the system prompt.
 * Dispatches based on which memory systems are enabled:
 *   - auto + team: combined prompt (both directories)
 *   - auto only: memory lines (single directory)
 * Team memory requires auto memory (enforced by isTeamMemoryEnabled), so
 * there is no team-only branch.
 *
 * `lean` selects the v2 text of the combined prompt.
 *
 * Returns null when auto memory is disabled.
 */
export async function loadMemoryPrompt(lean = false): Promise<string | null> {
  const autoEnabled = isAutoMemoryEnabled()

  // Cowork injects memory-policy text via env var; thread into all builders.
  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [coworkExtraGuidelines]
      : undefined

  if (feature('TEAMMEM')) {
    if (teamMemPaths!.isTeamMemoryEnabled()) {
      const teamDir = teamMemPaths!.getTeamMemPath()
      // Harness guarantees these directories exist so the model can write
      // without checking. The prompt text reflects this ("already exists").
      // Only creating teamDir is sufficient: getTeamMemPath() is defined as
      // join(getAutoMemPath(), 'team'), so recursive mkdir of the team dir
      // creates the auto dir as a side effect. If the team dir ever moves
      // out from under the auto dir, add a second ensureMemoryDirExists call
      // for autoDir here.
      await ensureMemoryDirExists(teamDir)
      // The same memoized load the context injects the indexes from, so the
      // prompt agrees with what the model was given and stays put when the
      // system-prompt sections are rebuilt mid-session without it (/add-dir).
      // Imported here, not at the top: claudemd/parsing.ts imports this
      // module. A failure costs the note, never the memory section.
      let indexesEmpty = false
      try {
        const { getMemoryFiles } = await import('src/memory/instructions/claudemd.js')
        indexesEmpty = areMemoryIndexesEmpty(await getMemoryFiles())
      } catch (e) {
        logForDebugging(
          `memory index check failed, keeping the index line as shipped: ${String(e)}`,
          { level: 'warn' },
        )
      }
      return lean
        ? teamMemPrompts!.buildLeanCombinedMemoryPrompt(extraGuidelines, indexesEmpty)
        : teamMemPrompts!.buildCombinedMemoryPrompt(extraGuidelines, indexesEmpty)
    }
  }

  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    // Harness guarantees the directory exists so the model can write without
    // checking. The prompt text reflects this ("already exists").
    await ensureMemoryDirExists(autoDir)
    // Empty memory → compact stub (~400 tok) instead of the full taxonomy
    // (~3.7K). The full block loads automatically once the first memory exists.
    const build = hasExistingMemories(autoDir)
      ? buildMemoryLines
      : buildMemoryStubLines
    return build('auto memory', autoDir, extraGuidelines).join('\n')
  }

  return null
}
