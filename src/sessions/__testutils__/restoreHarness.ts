/**
 * The world the session-restore characterization suites run in: a temp
 * CLAUDIN_CONFIG_DIR and project, transcripts written through the session
 * storage API, the loader `--continue` uses, and real git worktrees.
 *
 * `useRestoreSandbox()` registers its setup and teardown in the calling test
 * file, so each file owns them. Everything the restore path changes for the
 * whole process (the working directory, the session id, the agent and model,
 * the cost counters, the caches keyed to the directory) is put back.
 */
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import { randomUUID, type UUID } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import {
  addToTotalSessionCost,
  resetCostState,
  resetCostStateOwnerForTesting,
  saveCurrentSessionCosts,
} from 'src/agent/cost-tracker.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { getPlansDirectory } from 'src/agent/plans/plans.js'
import {
  clearSystemPromptSections,
  resolveSystemPromptSections,
  systemPromptSection,
} from 'src/agent/prompts/systemPromptSections.js'
import {
  __resetForTests as resetToolResultCache,
  getCached,
  setCached,
} from 'src/agent/tools/toolResultCache.js'
import { clearMemoryFileCaches, getMemoryFiles } from 'src/memory/instructions/claudemd.js'
import {
  getCwdState,
  getIsNonInteractiveSession,
  getMainLoopModelOverride,
  getMainThreadAgentType,
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
  regenerateSessionId,
  setCwdState,
  setIsInteractive,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import { resetHooksConfigSnapshot } from 'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { clearPluginHookCache } from 'src/plugins/loadPluginHooks.js'
import { envSnapshot, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import { loadConversationForResume } from 'src/sessions/conversationRecovery.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getProject,
  linkSessionToPR,
  reAppendSessionMetadata,
  recordFileHistorySnapshot,
  recordTranscript,
  resetProjectForTesting,
  saveAgentColor,
  saveAgentName,
  saveAgentSetting,
  saveCustomTitle,
  saveTag,
  saveWorktreeState,
} from 'src/sessions/sessionStorage.js'
import { asSessionId } from 'src/shared/types/ids.js'
import type { PersistedWorktreeSession } from 'src/shared/types/logs.js'
import type { Message } from 'src/shared/types/message.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from 'src/tools/AgentTool/loadAgentsDir.js'
import { restoreWorktreeSession } from 'src/vcs/git/worktree.js'

const PRICED_MODEL = 'claude-sonnet-4-5-20250514'

/** Variables the restore path reads; each test starts with them unset. */
const RESTORE_ENV = [
  'CLAUDIN_SKIP_PROMPT_HISTORY',
  'CLAUDIN_SIMPLE',
  'CLAUDIN_ENABLE_TASKS',
  'CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDIN_DISABLE_FILE_CHECKPOINTING',
] as const

/** In-memory state that outlives a test unless dropped: singletons, memos, caches. */
const PROCESS_CACHES: ReadonlyArray<() => unknown> = [
  resetProjectForTesting,
  clearSessionMessagesCache,
  resetToolResultCache,
  clearSystemPromptSections,
  clearMemoryFileCaches,
  () => getPlansDirectory.cache.clear?.(),
]

/** How every test's session starts: headless, no agent, no model pick, no worktree. */
const NEUTRAL_SESSION: ReadonlyArray<() => void> = [
  () => setIsInteractive(false),
  () => setMainThreadAgentType(undefined),
  () => setMainLoopModelOverride(undefined),
  () => restoreWorktreeSession(null),
]

/** Settings, hook snapshot and in-memory global config, read afresh per test. */
const CONFIGURATION: ReadonlyArray<() => unknown> = [
  resetSettingsCache,
  resetHooksConfigSnapshot,
  resetGlobalConfigForTests,
]

export type RestoreSandbox = {
  readonly root: string
  readonly configDir: string
  readonly projectDir: string
}

/** Make `dir` the project this process runs in. */
export function enterProject(dir: string): void {
  process.chdir(dir)
  for (const place of [setOriginalCwd, setCwdState, setProjectRoot]) place(dir)
}

export function useRestoreSandbox(): RestoreSandbox {
  let env: EnvSnapshot
  let putBack: () => void
  let putDirectoriesBack: () => void
  const paths = { root: '', configDir: '', projectDir: '' }

  beforeAll(() => {
    env = envSnapshot(['CLAUDIN_CONFIG_DIR', 'TEST_ENABLE_SESSION_PERSISTENCE', ...RESTORE_ENV])
    const processCwd = process.cwd()
    const where = { original: getOriginalCwd(), cwd: getCwdState(), root: getProjectRoot() }
    putDirectoriesBack = () => {
      process.chdir(processCwd)
      setOriginalCwd(where.original)
      setCwdState(where.cwd)
      setProjectRoot(where.root)
      restoreWorktreeSession(null)
    }
    const who = {
      session: getSessionId(),
      agent: getMainThreadAgentType(),
      model: getMainLoopModelOverride(),
      interactive: !getIsNonInteractiveSession(),
    }
    putBack = () => {
      switchSession(asSessionId(who.session))
      setMainThreadAgentType(who.agent)
      setMainLoopModelOverride(who.model)
      setIsInteractive(who.interactive)
    }
  })

  beforeEach(() => {
    paths.root = realpathSync(mkdtempSync(join(tmpdir(), 'lifecycle-restore-')))
    paths.configDir = join(paths.root, 'config')
    paths.projectDir = join(paths.root, 'project')
    for (const dir of [paths.configDir, paths.projectDir]) mkdirSync(dir)
    process.env.CLAUDIN_CONFIG_DIR = paths.configDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    for (const key of RESTORE_ENV) delete process.env[key]
    for (const reset of CONFIGURATION) reset()
    enterProject(paths.projectDir)
    for (const settle of NEUTRAL_SESSION) settle()
    for (const drop of PROCESS_CACHES) drop()
  })

  afterEach(async () => {
    await flushSessionStorage()
    putDirectoriesBack()
    for (const drop of PROCESS_CACHES) drop()
    env.restore()
    rmSync(paths.root, { recursive: true, force: true })
  })

  afterAll(() => {
    env.restore()
    putBack()
    resetCostState()
    resetCostStateOwnerForTesting()
    for (const reset of CONFIGURATION) reset()
    clearPluginHookCache()
  })

  return {
    get root() {
      return paths.root
    },
    get configDir() {
      return paths.configDir
    },
    get projectDir() {
      return paths.projectDir
    },
  }
}

// --- transcripts ------------------------------------------------------------

export type SessionSpec = {
  title?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  pr?: { number: number; url: string; repository: string }
  worktree?: PersistedWorktreeSession | null
  costUSD?: number
  /** The `todos` input of each TodoWrite call, in order. */
  todoWrites?: unknown[]
  /** Absolute paths one file-history snapshot tracks. */
  trackedFiles?: string[]
}

export type WrittenSession = { id: UUID; transcript: string }

function conversation(todoWrites: unknown[] = []): { opening: Message; messages: Message[] } {
  const opening = createUserMessage({ content: 'Let us fix the parser.' })
  const messages: Message[] = [opening, createAssistantMessage({ content: 'On it.' })]
  todoWrites.forEach((todos, index) => {
    const toolUseId = `toolu_todo_${index}`
    const call = { type: 'tool_use', id: toolUseId, name: 'TodoWrite', input: { todos } }
    const answer = { type: 'tool_result' as const, tool_use_id: toolUseId, content: 'Todos updated' }
    messages.push(
      createAssistantMessage({ content: [call] as never }),
      createUserMessage({ content: [answer] }),
    )
  })
  messages.push(createAssistantMessage({ content: 'That is all for now.' }))
  return { opening, messages }
}

function spend(dollars: number): void {
  const zeroed = (...fields: string[]) => Object.fromEntries(fields.map(field => [field, 0]))
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    ...zeroed('cache_read_input_tokens', 'cache_creation_input_tokens'),
  }
  addToTotalSessionCost(dollars, usage as Parameters<typeof addToTotalSessionCost>[1], PRICED_MODEL)
  saveCurrentSessionCosts()
}

/**
 * Record a session the way a running CLI does, then leave the process as a
 * new one would find it: a fresh session id, nothing cached, zero cost.
 */
export async function writeSession(spec: SessionSpec = {}): Promise<WrittenSession> {
  const id = randomUUID()
  resetCostStateOwnerForTesting()
  switchSession(asSessionId(id))
  resetCostState()
  resetProjectForTesting()

  const { opening, messages } = conversation(spec.todoWrites)
  await recordTranscript(messages)

  if (spec.title) await saveCustomTitle(id, spec.title)
  if (spec.tag) await saveTag(id, spec.tag)
  if (spec.agentName) await saveAgentName(id, spec.agentName)
  if (spec.agentColor) await saveAgentColor(id, spec.agentColor)
  if (spec.agentSetting) saveAgentSetting(spec.agentSetting)
  if (spec.pr) await linkSessionToPR(id, spec.pr.number, spec.pr.url, spec.pr.repository)
  if (spec.worktree !== undefined) saveWorktreeState(spec.worktree)
  if (spec.trackedFiles) {
    const at = new Date('2026-09-28T10:00:00.000Z')
    const backups = spec.trackedFiles.map((path, index) => [
      path,
      { backupFileName: `backup-${index}@v1`, version: 1, backupTime: at },
    ])
    const snapshot = {
      messageId: opening.uuid,
      trackedFileBackups: Object.fromEntries(backups),
      timestamp: at,
    }
    await recordFileHistorySnapshot(opening.uuid, snapshot, false)
  }
  if (spec.costUSD !== undefined) spend(spec.costUSD)
  await flushSessionStorage()
  // The exit stamp: metadata held only in memory (the agent setting) reaches the file.
  reAppendSessionMetadata()
  const transcript = getProject().sessionFile
  if (!transcript) throw new Error('the session never materialized a transcript')

  // A new process: its own session, nothing cached, nothing spent.
  resetProjectForTesting()
  clearSessionMessagesCache()
  resetCostState()
  regenerateSessionId()
  return { id, transcript }
}

/** What `claudin --continue` loads: the most recent session of the project. */
export async function loadLatest() {
  const loaded = await loadConversationForResume(undefined, undefined)
  if (!loaded) throw new Error('nothing to continue')
  return loaded
}

export type TranscriptEntry = Record<string, unknown> & { type: string }

export function transcriptEntries(transcript: string): TranscriptEntry[] {
  return readFileSync(transcript, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as TranscriptEntry)
}

// --- agents and the resume context ----------------------------------------------

export function agent(agentType: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType,
    whenToUse: `when ${agentType} fits`,
    source: 'userSettings',
    getSystemPrompt: () => `You are ${agentType}.`,
    ...extra,
  } as AgentDefinition
}

/** Definitions where `active` are the agents in effect and `inactive` are only defined. */
export function definitions(
  active: AgentDefinition[],
  inactive: AgentDefinition[] = [],
): AgentDefinitionsResult {
  return { activeAgents: active, allAgents: [...active, ...inactive] }
}

export function resumeContext(
  currentCwd: string,
  overrides: {
    agentDefinitions?: AgentDefinitionsResult
    mainThreadAgentDefinition?: AgentDefinition
    initialState?: AppState
  } = {},
) {
  return {
    modeApi: null,
    mainThreadAgentDefinition: overrides.mainThreadAgentDefinition,
    agentDefinitions: overrides.agentDefinitions ?? definitions([]),
    currentCwd,
    cliAgents: [],
    initialState: overrides.initialState ?? getDefaultAppState(),
  }
}

// --- git worktrees ------------------------------------------------------------

function git(home: string, cwd: string, ...args: string[]): string {
  const identity = { name: 'Lifecycle Test', email: 'lifecycle@example.test' }
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: identity.name,
      GIT_COMMITTER_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_EMAIL: identity.email,
    },
  })
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`)
  }
  return run.stdout.toString().trim()
}

export type RepositoryWithWorktree = {
  repo: string
  worktree: string
  session: PersistedWorktreeSession
}

/**
 * A repository with one commit and a linked worktree on its own branch, both
 * under `root`. The worktree's AGENTS.md is edited, so the instructions read
 * there differ from the repository's.
 */
export function repositoryWithWorktree(root: string): RepositoryWithWorktree {
  const repo = join(root, 'repo')
  const worktree = join(root, 'worktrees', 'parser-fix')
  mkdirSync(repo)
  mkdirSync(dirname(worktree))
  const run = (...args: string[]) => git(root, repo, ...args)
  run('init', '--quiet', '--initial-branch=main')
  writeFileSync(join(repo, 'AGENTS.md'), 'Instructions for the main checkout.\n')
  run('add', 'AGENTS.md')
  run('commit', '--quiet', '-m', 'start')
  run('worktree', 'add', '--quiet', '-b', 'parser-fix', worktree)
  writeFileSync(join(worktree, 'AGENTS.md'), 'Instructions for the worktree.\n')
  return {
    repo,
    worktree,
    session: {
      originalCwd: repo,
      worktreePath: worktree,
      worktreeName: 'parser-fix',
      worktreeBranch: 'parser-fix',
      originalBranch: 'main',
      originalHeadCommit: run('rev-parse', 'HEAD'),
      sessionId: randomUUID(),
    },
  }
}

// --- caches keyed to the working directory ------------------------------------

const PROBE_SECTION = 'lifecycle-probe'
const PROBE_GLOB = { pattern: '**/*.ts' }

/** Fill the caches that answer for the current working directory. */
export async function primeDirectoryCaches(): Promise<void> {
  setCached('Glob', PROBE_GLOB, { filenames: ['src/a.ts'] })
  await resolveSystemPromptSections([systemPromptSection(PROBE_SECTION, () => 'computed before')])
  getPlansDirectory()
  await getMemoryFiles()
}

/** What those caches answer now. */
export async function directoryCaches() {
  const [promptSection] = await resolveSystemPromptSections([
    systemPromptSection(PROBE_SECTION, () => 'computed after'),
  ])
  const instructionFiles = (await getMemoryFiles()).map(file => file.path)
  return {
    toolResultCached: getCached('Glob', PROBE_GLOB) !== undefined,
    promptSection,
    plansDirectory: getPlansDirectory(),
    instructionFiles,
  }
}
