import { join } from 'path'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { getMemoryDirs } from 'src/memory/memdir/memoryDirs.js'
import {
  ENTRYPOINT_NAME,
  isMemoryFileType,
  MEMORY_SCOPE_SPECS,
} from 'src/memory/memdir/memoryScopes.js'
// teamMemPrompts.ts imports this module back; the cycle is safe because
// neither side reads the other's bindings at module-evaluation time.
import {
  buildCombinedMemoryPrompt,
  buildLeanCombinedMemoryPrompt,
} from 'src/memory/memdir/teamMemPrompts.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { logForDebugging } from 'src/shared/debug.js'
import { hasEmbeddedSearchTools } from 'src/agent/tools/embeddedTools.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  WHAT_NOT_TO_SAVE_SECTION,
} from 'src/memory/memdir/memoryTypes.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

import { fitEntrypointContent, MAX_ENTRYPOINT_LINES } from 'src/memory/memdir/entrypointFit.js'

export {
  countIndexEntries,
  type EntrypointFit,
  fitEntrypointContent,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/entrypointFit.js'

/**
 * Shared guidance text appended to each memory directory prompt line.
 * Shipped because Claude was burning turns on `ls`/`mkdir -p` before writing.
 * Harness guarantees the directory exists via ensureMemoryDirExists().
 */
export const DIR_EXISTS_GUIDANCE =
  'This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).'
export const DIRS_EXIST_GUIDANCE =
  'Both directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).'
export const ALL_DIRS_EXIST_GUIDANCE =
  'All three directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence).'

/**
 * Ensure a memory directory exists. Idempotent — called from loadMemoryPrompt
 * (once per session via systemPromptSection cache) so the model can always
 * write without checking existence first. FsOperations.mkdir is recursive
 * by default and already swallows EEXIST, so the full parent chain
 * (~/.claudin/projects/<slug>/memory/) is created in one call with no
 * try/catch needed for the happy path.
 * `mode` applies to every directory the call creates (0o700 for the global
 * dir, which holds what is about the user).
 */
export async function ensureMemoryDirExists(
  memoryDir: string,
  mode?: number,
): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir, mode === undefined ? undefined : { mode })
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
 * Used by buildMemoryPrompt (agent memory, includes content); the system
 * prompt's memory section is teamMemPrompts.ts's combined prompt instead.
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
): string[] {
  // Compact, dense prose (upstream shape). The verbose XML taxonomy in
  // memoryTypes.ts (typesSectionCombined) is ~3.7K tokens and ships
  // in the main system prompt every turn; this conveys the same four types and
  // the eval-tuned cues (explicit-save, feedback Why/How, absolute dates,
  // verify-before-recommend) in ~400 tokens. Those verbose constants are kept
  // for the background extraction agent + team-memory path, where prompt size
  // matters far less.
  //
  // Ported from upstream's compact `# Memory`, keeping claudin's own
  // mechanics: the directory comes from paths.ts (unchanged), the index is
  // still ENTRYPOINT_NAME, fitted to its caps (fitEntrypointContent), and the
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
 * True when no MEMORY.md index put anything into context: every one is
 * absent, empty or whitespace only. `loaded` is getMemoryFiles(), the list the
 * indexes reach context from (getUserContext → getClaudeMds), so this is
 * decided on what the model was given, at no second read — an index
 * getClaudeMds skips as empty counts as empty here. The combined prompts say
 * so when it holds (teamMemPrompts.ts).
 */
export function areMemoryIndexesEmpty(
  loaded: readonly Pick<MemoryFileInfo, 'type' | 'content'>[],
): boolean {
  return !loaded.some(
    file => isMemoryFileType(file.type) && file.content.trim() !== '',
  )
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
    const t = fitEntrypointContent(entrypointContent)
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
 * `globalMemDir` adds the global memory dir to the first step; the team dir
 * needs no line of its own, it sits inside `autoMemDir`.
 */
export function buildSearchingPastContextSection(
  autoMemDir: string,
  lean = false,
  globalMemDir: string | null = null,
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
  const globalSearch =
    globalMemDir === null
      ? null
      : embedded
        ? `grep -rn "<search term>" ${globalMemDir} --include="*.md"`
        : `${GREP_TOOL_NAME} with pattern="<search term>" path="${globalMemDir}" glob="*.md"`
  const transcriptSearch = embedded
    ? `grep -rn "<search term>" ${projectDir}/ --include="*.jsonl"`
    : `${GREP_TOOL_NAME} with pattern="<search term>" path="${projectDir}/" glob="*.jsonl"`
  if (lean) {
    const memory =
      globalSearch === null
        ? `\`${memSearch}\``
        : `\`${memSearch}\`, and \`${globalSearch}\` for the global one`
    return [
      `To search past context, use narrow terms (error messages, paths, function names): first your memory (${memory}), then, as a slow last resort, the session transcripts (\`${transcriptSearch}\`).`,
    ]
  }
  return [
    '## Searching past context',
    '',
    'When looking for past context:',
    `1. Search topic files in your memory ${globalSearch === null ? 'directory' : 'directories'}:`,
    '```',
    memSearch,
    ...(globalSearch === null ? [] : [globalSearch]),
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
 * Load the unified memory prompt for inclusion in the system prompt.
 * Team memory is on whenever auto memory is, so this is always the combined
 * prompt (private + team directories, plus the global one while it is on).
 *
 * `lean` selects the v2 text of the combined prompt
 * (teamMemPrompts.ts `buildLeanCombinedMemoryPrompt`), which getSystemPrompt
 * sends to the Anthropic family.
 *
 * Returns null when auto memory is disabled.
 */
export async function loadMemoryPrompt(lean = false): Promise<string | null> {
  const dirs = getMemoryDirs()
  if (dirs.length === 0) {
    return null
  }

  // Cowork injects memory-policy text via env var; thread into all builders.
  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [coworkExtraGuidelines]
      : undefined

  // Harness guarantees every directory exists so the model can write
  // without checking. The prompt text reflects this ("already exists").
  // A scope with a dirMode (the global dir, the user's alone across
  // projects: 0700) is created with it.
  for (const dir of dirs) {
    await ensureMemoryDirExists(dir.root, MEMORY_SCOPE_SPECS[dir.scope].dirMode)
  }
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
    ? buildLeanCombinedMemoryPrompt(dirs, extraGuidelines, indexesEmpty)
    : buildCombinedMemoryPrompt(dirs, extraGuidelines, indexesEmpty)
}
