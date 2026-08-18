/**
 * Local signal collection for /auto-mode-setup.
 *
 * Every source here reads the machine and nothing else — no network, no `gh`.
 * The IO is injected (`CollectSignalsDeps`) so the shape of what gets collected
 * can be tested without touching disk or mocking a module.
 *
 * Two rules the collectors follow, because their output is sent to a model:
 * command lines are reduced to counted heads by `signalParsing.ts`, and file
 * contents are never read except for the project's own instructions file.
 */

import { basename, join } from 'path'
import { readFile, readdir, realpath } from 'fs/promises'
import { homedir } from 'os'

import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getProjectDir } from 'src/sessions/sessionStoragePortable.js'
import { getSessionFilesWithMtime } from 'src/sessions/indexing/liteMetadata.js'
import { tailFile } from 'src/shared/fs/fsOperations.js'
import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'
import { isENOENT } from 'src/shared/errors.js'
import { logForDebugging } from 'src/shared/debug.js'
import {
  type CommandCount,
  buildHistogram,
  extractToolUsesFromTranscript,
  extractCommandHead,
  isNetworkHome,
  parseShellHistory,
} from 'src/commands/auto-mode-setup/signalParsing.js'

/** How the user described their work in this directory. */
export type UsagePosture = 'work' | 'open-source' | 'hobby' | 'mixed'

export type EnvironmentSignals = {
  posture: UsagePosture
  project: {
    directoryName: string
    instructionsFile: string | null
    instructionsExcerpt: string | null
    packageManagers: string[]
    scripts: { name: string; command: string }[]
    configFileNames: string[]
  }
  repo: {
    isGitRepo: boolean
    remote: string | null
    currentBranch: string | null
    hasCustomHooks: boolean
  }
  permissionsAllow: string[]
  sessions: {
    filesScanned: number
    tools: CommandCount[]
    commands: CommandCount[]
  }
  shellHistory: {
    commands: CommandCount[]
    skipped: string | null
  }
}

const MAX_SESSION_FILES = 12
const MAX_SESSION_BYTES_PER_FILE = 256_000
const MAX_SESSION_BYTES_TOTAL = 2_000_000
const MAX_HISTORY_BYTES = 512_000
const MAX_HISTORY_ENTRIES = 3_000
const MAX_INSTRUCTIONS_CHARS = 2_000
const MAX_SCRIPTS = 20
const MAX_SCRIPT_CHARS = 120
const MAX_CONFIG_NAMES = 40
const TOP_COMMANDS = 60
const TOP_TOOLS = 20
const GIT_TIMEOUT_MS = 5_000

const INSTRUCTIONS_FILES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md']

const LOCKFILE_TO_MANAGER: ReadonlyMap<string, string> = new Map([
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['Cargo.lock', 'cargo'],
  ['poetry.lock', 'poetry'],
  ['uv.lock', 'uv'],
  ['Gemfile.lock', 'bundler'],
  ['composer.lock', 'composer'],
  ['go.sum', 'go'],
  ['pubspec.lock', 'dart'],
  ['mix.lock', 'mix'],
])

const CONFIG_FILE_RE =
  /^(\.env.*|\.[a-z0-9_.-]+rc(\.[a-z]+)?|[a-z0-9_.-]+\.config\.[a-z]+|Dockerfile.*|docker-compose\..*|Makefile|Justfile|.*\.ya?ml|.*\.toml|tsconfig.*\.json|package\.json|go\.mod|Cargo\.toml|pyproject\.toml|requirements.*\.txt|Gemfile|build\.gradle.*|pom\.xml)$/i

const SHELL_HISTORY_FILES = [
  '.zsh_history',
  '.bash_history',
  '.local/share/fish/fish_history',
  '.history',
]

export type CollectSignalsDeps = {
  cwd: string
  homeDir: string
  /** File contents, or null when the file is absent or unreadable. */
  readTextFile(path: string): Promise<string | null>
  /** Directory entry names, or an empty list when unreadable. */
  listDir(path: string): Promise<string[]>
  /** git stdout, or null when git failed or this is not a repository. */
  git(args: string[]): Promise<string | null>
  /** Absolute paths of this project's session transcripts, newest first. */
  listSessionFiles(): Promise<string[]>
  /** Last `maxBytes` of a file, or '' when unreadable. */
  tail(path: string, maxBytes: number): Promise<string>
  /** Contents of /proc/mounts, or null where that does not exist. */
  readMounts(): Promise<string | null>
}

export function defaultCollectSignalsDeps(): CollectSignalsDeps {
  // `git` and `listSessionFiles` read `deps.cwd` at call time rather than
  // closing over it: a caller that overrides `cwd` would otherwise get project
  // files from one directory and git facts from another, silently.
  const deps: CollectSignalsDeps = {
    cwd: getOriginalCwd(),
    homeDir: homedir(),
    readTextFile: safeReadTextFile,
    listDir: safeListDir,
    git: (args: string[]) => runGit(deps.cwd, args),
    listSessionFiles: () => listProjectSessionFiles(deps.cwd),
    tail: safeTail,
    readMounts: () => safeReadTextFile('/proc/mounts'),
  }
  return deps
}

export async function collectSignals(
  options: {
    posture: UsagePosture
    includeShellHistory: boolean
    permissionsAllow: readonly string[]
  },
  deps: CollectSignalsDeps = defaultCollectSignalsDeps(),
): Promise<EnvironmentSignals> {
  const [project, repo, sessions, shellHistory] = await Promise.all([
    collectProject(deps),
    collectRepo(deps),
    collectSessions(deps),
    options.includeShellHistory
      ? collectShellHistory(deps)
      : Promise.resolve({ commands: [], skipped: 'not requested' }),
  ])

  return {
    posture: options.posture,
    project,
    repo,
    permissionsAllow: [...options.permissionsAllow],
    sessions,
    shellHistory,
  }
}

async function collectProject(
  deps: CollectSignalsDeps,
): Promise<EnvironmentSignals['project']> {
  const entries = await deps.listDir(deps.cwd)

  let instructionsFile: string | null = null
  let instructionsExcerpt: string | null = null
  for (const candidate of INSTRUCTIONS_FILES) {
    if (!entries.includes(candidate)) continue
    const content = await deps.readTextFile(join(deps.cwd, candidate))
    if (content === null) continue
    instructionsFile = candidate
    instructionsExcerpt = content.slice(0, MAX_INSTRUCTIONS_CHARS)
    break
  }

  const packageManagers: string[] = []
  for (const entry of entries) {
    const manager = LOCKFILE_TO_MANAGER.get(entry)
    if (manager && !packageManagers.includes(manager)) {
      packageManagers.push(manager)
    }
  }

  const scripts = entries.includes('package.json')
    ? parsePackageScripts(await deps.readTextFile(join(deps.cwd, 'package.json')))
    : []

  const configFileNames = entries
    .filter(entry => CONFIG_FILE_RE.test(entry))
    .slice(0, MAX_CONFIG_NAMES)

  return {
    directoryName: basename(deps.cwd),
    instructionsFile,
    instructionsExcerpt,
    packageManagers,
    scripts,
    configFileNames,
  }
}

export function parsePackageScripts(
  packageJson: string | null,
): { name: string; command: string }[] {
  if (!packageJson) return []
  try {
    const parsed: unknown = JSON.parse(packageJson)
    if (typeof parsed !== 'object' || parsed === null) return []
    const scripts = (parsed as Record<string, unknown>).scripts
    if (typeof scripts !== 'object' || scripts === null) return []
    return Object.entries(scripts as Record<string, unknown>)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      )
      .slice(0, MAX_SCRIPTS)
      .map(([name, command]) => ({
        name,
        command: command.slice(0, MAX_SCRIPT_CHARS),
      }))
  } catch {
    // A malformed package.json is the project's problem, not the scan's.
    return []
  }
}

async function collectRepo(
  deps: CollectSignalsDeps,
): Promise<EnvironmentSignals['repo']> {
  const insideWorkTree = await deps.git(['rev-parse', '--is-inside-work-tree'])
  if (insideWorkTree?.trim() !== 'true') {
    return {
      isGitRepo: false,
      remote: null,
      currentBranch: null,
      hasCustomHooks: false,
    }
  }

  const [remote, branch, hooksDir] = await Promise.all([
    deps.git(['remote', 'get-url', 'origin']),
    deps.git(['rev-parse', '--abbrev-ref', 'HEAD']),
    deps.listDir(join(deps.cwd, '.git', 'hooks')),
  ])

  return {
    isGitRepo: true,
    remote: remote?.trim() || null,
    currentBranch: branch?.trim() || null,
    hasCustomHooks: hooksDir.some(entry => !entry.endsWith('.sample')),
  }
}

async function collectSessions(
  deps: CollectSignalsDeps,
): Promise<EnvironmentSignals['sessions']> {
  const files = (await deps.listSessionFiles()).slice(0, MAX_SESSION_FILES)
  const toolNames: string[] = []
  const commandHeads: (string | null)[] = []

  let budget = MAX_SESSION_BYTES_TOTAL
  let filesScanned = 0
  for (const file of files) {
    if (budget <= 0) break
    const text = await deps.tail(file, Math.min(MAX_SESSION_BYTES_PER_FILE, budget))
    budget -= text.length
    if (!text) continue
    filesScanned += 1
    const extracted = extractToolUsesFromTranscript(text)
    toolNames.push(...extracted.toolNames)
    commandHeads.push(...extracted.commandHeads)
  }

  return {
    filesScanned,
    tools: buildHistogram(toolNames, TOP_TOOLS),
    commands: buildHistogram(commandHeads, TOP_COMMANDS),
  }
}

async function collectShellHistory(
  deps: CollectSignalsDeps,
): Promise<EnvironmentSignals['shellHistory']> {
  const mounts = await deps.readMounts()
  if (isNetworkHome(mounts, deps.homeDir)) {
    return { commands: [], skipped: 'home directory is on a network filesystem' }
  }

  const heads: (string | null)[] = []
  let found = false
  for (const relative of SHELL_HISTORY_FILES) {
    const text = await deps.tail(join(deps.homeDir, relative), MAX_HISTORY_BYTES)
    if (!text) continue
    found = true
    const commands = parseShellHistory(text).slice(-MAX_HISTORY_ENTRIES)
    for (const command of commands) {
      heads.push(extractCommandHead(command))
    }
  }

  if (!found) {
    return { commands: [], skipped: 'no shell history file found' }
  }
  return { commands: buildHistogram(heads, TOP_COMMANDS), skipped: null }
}

// ── default IO ──────────────────────────────────────────────────────────────

async function safeReadTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`auto-mode-setup: cannot read ${path}`)
    }
    return null
  }
}

async function safeListDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

async function safeTail(path: string, maxBytes: number): Promise<string> {
  try {
    const result = await tailFile(path, maxBytes)
    return result.content
  } catch {
    return ''
  }
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  const result = await execFileNoThrowWithCwd('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    preserveOutputOnError: false,
  })
  return result.code === 0 ? result.stdout : null
}

/**
 * Session transcripts for this project, newest first, with each path confirmed
 * to still resolve inside the project directory — a symlink planted in the
 * projects dir must not turn the scan into a reader of arbitrary files.
 */
async function listProjectSessionFiles(cwd: string): Promise<string[]> {
  const projectDir = getProjectDir(cwd)
  let resolvedProjectDir: string
  try {
    resolvedProjectDir = await realpath(projectDir)
  } catch {
    return []
  }

  const filesWithMtime = await getSessionFilesWithMtime(projectDir)
  const sorted = [...filesWithMtime.values()].sort((a, b) => b.mtime - a.mtime)

  const paths: string[] = []
  for (const file of sorted) {
    try {
      const resolved = await realpath(file.path)
      if (!resolved.startsWith(`${resolvedProjectDir}/`)) continue
      paths.push(resolved)
    } catch {
      continue
    }
  }
  return paths
}

/** Render the collected signals as the user message the analysis receives. */
export function renderSignals(signals: EnvironmentSignals): string {
  const lines: string[] = []

  lines.push(`<posture>${signals.posture}</posture>`)

  lines.push('<project>')
  lines.push(`directory: ${signals.project.directoryName}`)
  if (signals.project.packageManagers.length) {
    lines.push(`package managers: ${signals.project.packageManagers.join(', ')}`)
  }
  if (signals.project.configFileNames.length) {
    lines.push(`config files: ${signals.project.configFileNames.join(', ')}`)
  }
  for (const script of signals.project.scripts) {
    lines.push(`script ${script.name}: ${script.command}`)
  }
  lines.push('</project>')

  lines.push('<repository>')
  lines.push(`git repository: ${signals.repo.isGitRepo ? 'yes' : 'no'}`)
  if (signals.repo.remote) lines.push(`origin: ${signals.repo.remote}`)
  if (signals.repo.currentBranch) {
    lines.push(`branch: ${signals.repo.currentBranch}`)
  }
  lines.push(`custom git hooks: ${signals.repo.hasCustomHooks ? 'yes' : 'no'}`)
  lines.push('</repository>')

  if (signals.project.instructionsExcerpt) {
    lines.push(`<project_instructions file="${signals.project.instructionsFile}">`)
    lines.push(signals.project.instructionsExcerpt)
    lines.push('</project_instructions>')
  }

  lines.push('<always_allow_rules>')
  lines.push(
    signals.permissionsAllow.length
      ? signals.permissionsAllow.join('\n')
      : '(none)',
  )
  lines.push('</always_allow_rules>')

  lines.push(`<sessions files="${signals.sessions.filesScanned}">`)
  for (const tool of signals.sessions.tools) {
    lines.push(`tool ${tool.command}: ${tool.count}`)
  }
  for (const command of signals.sessions.commands) {
    lines.push(`command ${command.command}: ${command.count}`)
  }
  lines.push('</sessions>')

  lines.push('<shell_history>')
  if (signals.shellHistory.skipped) {
    lines.push(`skipped: ${signals.shellHistory.skipped}`)
  }
  for (const command of signals.shellHistory.commands) {
    lines.push(`${command.command}: ${command.count}`)
  }
  lines.push('</shell_history>')

  return lines.join('\n')
}
