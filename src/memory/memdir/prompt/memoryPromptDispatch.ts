/**
 * Which memory text the system prompt carries.
 *
 *   CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES  when it has non-blank content, is
 *                                          passed as written as the one extra
 *                                          guideline of the text.
 */
import { feature } from 'bun:bundle'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import {
  areMemoryIndexesEmpty,
  ensureMemoryDirExists,
  hasExistingMemories,
} from 'src/memory/memdir/directory/memoryDirectory.js'
import {
  buildMemoryLines,
  buildMemoryStubLines,
} from 'src/memory/memdir/prompt/privateMemoryPrompt.js'
import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memory/memdir/paths.js'
import {
  getTeamMemPath,
  isTeamMemoryEnabled,
} from 'src/memory/memdir/teamMemPaths.js'

export type MemoryPromptSwitches = {
  /** The TEAMMEM build flag. */
  readonly teamBuild: boolean
  readonly teamMemoryEnabled: boolean
  readonly autoMemoryEnabled: boolean
  readonly lean: boolean
}

export type MemoryPromptChoice =
  | { readonly kind: 'none' }
  | { readonly kind: 'team'; readonly variant: 'lean' | 'full' }
  | { readonly kind: 'private' }

/**
 * With the team flag on, team memory is on exactly when auto memory is, so a
 * shipped build never takes the private branch; it is what runs under
 * `bun test` and in a build without the flag, and `lean` does not reach it.
 */
export function chooseMemoryPrompt(
  switches: MemoryPromptSwitches,
): MemoryPromptChoice {
  if (switches.teamBuild && switches.teamMemoryEnabled) {
    return { kind: 'team', variant: switches.lean ? 'lean' : 'full' }
  }
  if (switches.autoMemoryEnabled) return { kind: 'private' }
  return { kind: 'none' }
}

type TeamPromptBuilder = (
  extraGuidelines?: string[],
  indexesEmpty?: boolean,
) => string

type TeamPromptBuilders = {
  readonly buildCombinedMemoryPrompt: TeamPromptBuilder
  readonly buildLeanCombinedMemoryPrompt: TeamPromptBuilder
}

export type LoadedInstructionFile = Pick<MemoryFileInfo, 'type' | 'content'>

export type MemoryPromptDeps = {
  readonly teamBuild: boolean
  readonly isTeamMemoryEnabled: () => boolean
  readonly isAutoMemoryEnabled: () => boolean
  readonly autoMemDir: () => string
  readonly teamMemDir: () => string
  readonly ensureDir: (dir: string) => Promise<void>
  readonly hasMemories: (dir: string) => boolean
  /** What the instruction loader put in context, indexes included. */
  readonly loadInstructionFiles: () => Promise<readonly LoadedInstructionFile[]>
  readonly loadTeamPrompts: () => Promise<TeamPromptBuilders>
  readonly extraGuidelines: () => string[] | undefined
}

const PRIVATE_DISPLAY_NAME = 'auto memory'

export async function loadMemoryPromptWith(
  deps: MemoryPromptDeps,
  lean: boolean,
): Promise<string | null> {
  const choice = chooseMemoryPrompt({
    teamBuild: deps.teamBuild,
    teamMemoryEnabled: deps.teamBuild && deps.isTeamMemoryEnabled(),
    autoMemoryEnabled: deps.isAutoMemoryEnabled(),
    lean,
  })
  switch (choice.kind) {
    case 'none':
      return null
    case 'team':
      return buildTeamPrompt(deps, choice.variant)
    case 'private':
      return buildPrivatePrompt(deps)
  }
}

async function buildTeamPrompt(
  deps: MemoryPromptDeps,
  variant: 'lean' | 'full',
): Promise<string> {
  // Creating the team directory creates the private one that holds it.
  await deps.ensureDir(deps.teamMemDir())
  const indexesEmpty = await indexesAreEmpty(deps)
  const builders = await deps.loadTeamPrompts()
  const build =
    variant === 'lean'
      ? builders.buildLeanCombinedMemoryPrompt
      : builders.buildCombinedMemoryPrompt
  return build(deps.extraGuidelines(), indexesEmpty)
}

async function buildPrivatePrompt(deps: MemoryPromptDeps): Promise<string> {
  const dir = deps.autoMemDir()
  await deps.ensureDir(dir)
  const build = deps.hasMemories(dir) ? buildMemoryLines : buildMemoryStubLines
  return build(PRIVATE_DISPLAY_NAME, dir, deps.extraGuidelines()).join('\n')
}

/** Unknown counts as not empty: the note must never claim memory is missing. */
async function indexesAreEmpty(deps: MemoryPromptDeps): Promise<boolean> {
  try {
    return areMemoryIndexesEmpty(await deps.loadInstructionFiles())
  } catch (error) {
    logForDebugging(
      `Could not load the memory indexes to tell whether they are empty: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    return false
  }
}

function extraGuidelinesFromEnv(): string[] | undefined {
  const raw = process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  return raw !== undefined && raw.trim() !== '' ? [raw] : undefined
}

const PRODUCTION_DEPS: MemoryPromptDeps = {
  teamBuild: feature('TEAMMEM') ? true : false,
  isTeamMemoryEnabled: () => isTeamMemoryEnabled(),
  isAutoMemoryEnabled: () => isAutoMemoryEnabled(),
  autoMemDir: () => getAutoMemPath(),
  teamMemDir: () => getTeamMemPath(),
  ensureDir: dir => ensureMemoryDirExists(dir),
  hasMemories: dir => hasExistingMemories(dir),
  // Both are imported on use: the instruction loader's parser imports
  // memdir.ts, and the team prompts import it too, so a static import here
  // would close a cycle at load time.
  loadInstructionFiles: async () =>
    (await import('src/memory/instructions/claudemd.js')).getMemoryFiles(),
  loadTeamPrompts: () => import('src/memory/memdir/teamMemPrompts.js'),
  extraGuidelines: extraGuidelinesFromEnv,
}

/**
 * The memory section of the system prompt, or null while auto memory is off.
 * The team text reports empty indexes from the same memoized instruction load
 * that puts them in context.
 */
export function loadMemoryPrompt(lean = false): Promise<string | null> {
  return loadMemoryPromptWith(PRODUCTION_DEPS, lean)
}
