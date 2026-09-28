import {
  comparablePath,
  comparableText,
  isStrictlyBelow,
  type PathPlatform,
  withoutTrailingSlashes,
} from 'src/memory/memdir/detection/comparablePath.js'
import { absolutePathTokens } from 'src/memory/memdir/detection/shellCommandPaths.js'

/** Everything the predicates read from the session, passed in. */
export type MemoryDetectionContext = {
  readonly platform: PathPlatform
  readonly configHome: string
  readonly memoryBase: string
  readonly autoMemoryEnabled: boolean
  /** The private directory with its separator; read only while auto memory is on. */
  readonly autoMemDir: () => string
  /** The TEAMMEM build flag. */
  readonly teamBuild: boolean
  readonly teamMemoryEnabled: () => boolean
  readonly isAutoMemPath: (path: string) => boolean
  readonly isTeamMemPath: (path: string) => boolean
  readonly isAgentMemoryPath: (path: string) => boolean
}

const SESSION_MEMORY_SEGMENT = '/session-memory/'
const PROJECTS_SEGMENT = '/projects/'
const MEMORY_SEGMENT = '/memory/'
const AGENT_MEMORY_SEGMENTS = ['/agent-memory/', '/agent-memory-local/'] as const
const AGENT_MEMORY_PATTERN_PARTS = ['agent-memory/', 'agent-memory-local/'] as const
const PROJECTS_PATTERN_SEGMENT_RE = /(?:^|\/)projects(?:\/|$)/
const BACKSLASH_RE = /\\/g
const TRAILING_SEPARATOR_RE = /[/\\]$/

export function isAutoMemFileIn(
  ctx: MemoryDetectionContext,
  filePath: string,
): boolean {
  return ctx.autoMemoryEnabled && ctx.isAutoMemPath(filePath)
}

function isTeamMemFileIn(
  ctx: MemoryDetectionContext,
  filePath: string,
): boolean {
  return ctx.teamBuild && ctx.teamMemoryEnabled() && ctx.isTeamMemPath(filePath)
}

/**
 * Written by the agent itself rather than the user: the memory directories,
 * agent memory, and the session summaries and transcripts under the config
 * home. Instruction files such as CLAUDE.md and rules are the user's.
 */
export function isAutoManagedMemoryFileIn(
  ctx: MemoryDetectionContext,
  filePath: string,
): boolean {
  return (
    isAutoMemFileIn(ctx, filePath) ||
    isTeamMemFileIn(ctx, filePath) ||
    isSessionFile(ctx, filePath) ||
    (ctx.autoMemoryEnabled && ctx.isAgentMemoryPath(filePath))
  )
}

/** Session files count whether or not auto memory is on. */
function isSessionFile(ctx: MemoryDetectionContext, filePath: string): boolean {
  const path = comparablePath(filePath, ctx.platform)
  if (!isStrictlyBelow(path, comparablePath(ctx.configHome, ctx.platform))) {
    return false
  }
  return (
    (path.includes(SESSION_MEMORY_SEGMENT) && path.endsWith('.md')) ||
    (path.includes(PROJECTS_SEGMENT) && path.endsWith('.jsonl'))
  )
}

export function isMemoryDirectoryIn(
  ctx: MemoryDetectionContext,
  dirPath: string,
): boolean {
  const path = comparablePath(dirPath, ctx.platform)
  if (
    ctx.autoMemoryEnabled &&
    AGENT_MEMORY_SEGMENTS.some(segment => path.includes(segment))
  ) {
    return true
  }
  if (isTeamMemFileIn(ctx, dirPath)) return true
  if (ctx.autoMemoryEnabled && isPrivateDirOrBelow(ctx, path)) return true

  const underConfig = isStrictlyBelow(
    path,
    comparablePath(ctx.configHome, ctx.platform),
  )
  const underBase =
    underConfig ||
    isStrictlyBelow(path, comparablePath(ctx.memoryBase, ctx.platform))
  if (!underBase) return false
  return (
    path.includes(SESSION_MEMORY_SEGMENT) ||
    (underConfig && path.includes(PROJECTS_SEGMENT)) ||
    (ctx.autoMemoryEnabled && path.includes(MEMORY_SEGMENT))
  )
}

/** The private directory with or without its separator, or anything below it. */
function isPrivateDirOrBelow(
  ctx: MemoryDetectionContext,
  path: string,
): boolean {
  const dir = withoutTrailingSlashes(
    comparablePath(ctx.autoMemDir(), ctx.platform),
  )
  return path === dir || path.startsWith(`${dir}/`)
}

/**
 * Only a command that spells out the config home, the memory base or the
 * private directory is examined; then any absolute path in it that is a
 * memory file or directory makes it a memory command.
 */
export function isShellCommandTargetingMemoryIn(
  ctx: MemoryDetectionContext,
  command: string,
): boolean {
  const tokens = absolutePathTokens(command, ctx.platform)
  const anchors = [
    ctx.configHome,
    ctx.memoryBase,
    ...(ctx.autoMemoryEnabled ? [withoutTrailingSeparator(ctx.autoMemDir())] : []),
  ]
  const text = [command, ...tokens]
    .map(part => comparableText(part, ctx.platform))
    .join('\n')
  const named = anchors.some(anchor =>
    text.includes(comparableText(anchor, ctx.platform)),
  )
  if (!named) return false
  return tokens.some(
    token =>
      isAutoManagedMemoryFileIn(ctx, token) || isMemoryDirectoryIn(ctx, token),
  )
}

function withoutTrailingSeparator(dir: string): string {
  return dir.replace(TRAILING_SEPARATOR_RE, '')
}

/**
 * A search pattern aimed at memory: session summaries, transcripts under a
 * `projects` directory, or agent memory while auto memory is on.
 */
export function isAutoManagedMemoryPatternIn(
  ctx: MemoryDetectionContext,
  pattern: string,
): boolean {
  const slashed = pattern.replace(BACKSLASH_RE, '/')
  const text = ctx.platform === 'windows' ? slashed.toLowerCase() : slashed
  if (
    text.includes('session-memory') &&
    (text.includes('.md') || text.endsWith('*'))
  ) {
    return true
  }
  // A `.jsonl` glob elsewhere, such as `data/**/*.jsonl`, is an ordinary search.
  if (text.includes('.jsonl') && PROJECTS_PATTERN_SEGMENT_RE.test(text)) {
    return true
  }
  return (
    ctx.autoMemoryEnabled &&
    AGENT_MEMORY_PATTERN_PARTS.some(part => text.includes(part))
  )
}
