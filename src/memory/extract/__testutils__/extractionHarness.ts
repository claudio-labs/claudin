/**
 * Shared set-up for the memory-extraction characterization suites.
 *
 * One boundary is replaced: the forked agent. `runForkedAgent` answers from a
 * script the test picks and records every request the unit sends it; the
 * rest of that module stays genuine. Everything else runs for real, inside a
 * scratch directory that holds the config home, HOME and the project.
 *
 * The `use…` functions register their hooks in the scope of the file that
 * calls them, so each suite puts back what it changed (see "Process-global
 * state a test file must put back" in .claudin/rules/testing.md).
 */
import { afterAll, afterEach, beforeEach, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as forkedAgentModule from 'src/agent/coordinator/forkedAgent.js'
import type {
  ForkedAgentParams,
  ForkedAgentResult,
} from 'src/agent/coordinator/forkedAgent.js'
import {
  createAssistantMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import { asSystemPrompt } from 'src/agent/systemPromptType.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import {
  getCwdState,
  getOriginalCwd,
  getProjectRoot,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import type { REPLHookContext } from 'src/platform/lifecycleHooks/postSamplingHooks.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { EMPTY_USAGE } from 'src/providers/usage/emptyUsage.js'
import type { Message } from 'src/shared/types/message.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

/** Taken before any stub exists, as a plain copy: what the double hands back. */
const genuineForkedAgent = { ...forkedAgentModule }

/** Every variable the unit reads, itself or through the gates it consults. */
const SCENE_VARIABLES = [
  'HOME',
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_EXTRACT_MEMORIES',
  'CLAUDIN_EXTRACT_MEMORIES_EVERY',
  'CLAUDIN_DISABLE_AUTO_MEMORY',
  'CLAUDIN_SIMPLE',
  'CLAUDIN_LOOP_MEMORY_TRIGGER',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
] as const

export type Scene = {
  /** Scratch root, deleted after the test. */
  root: string
  /** CLAUDIN_CONFIG_DIR for the test. */
  configDir: string
  /** Project root, original cwd and cwd for the test. Not a git repository. */
  projectDir: string
  /** The auto-memory directory the project resolves to, with its trailing separator. */
  memoryDir: string
}

/**
 * A fresh scratch world per test: config home, HOME and project inside a new
 * temp directory, the memory switches cleared, settings re-read.
 */
export function useScene(): () => Scene {
  const variablesBefore = new Map<string, string | undefined>()
  let directoriesBefore: { cwd: string; original: string; project: string } | undefined
  let announceBefore: boolean | undefined
  let scene: Scene | undefined

  beforeEach(() => {
    for (const name of SCENE_VARIABLES) {
      variablesBefore.set(name, process.env[name])
      delete process.env[name]
    }
    directoriesBefore = {
      cwd: getCwdState(),
      original: getOriginalCwd(),
      project: getProjectRoot(),
    }
    announceBefore = getGlobalConfig().notifyMemorySaved

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'extract-char-')))
    const configDir = join(root, 'config')
    const projectDir = join(root, 'project')
    const home = join(root, 'home')
    for (const dir of [configDir, projectDir, home]) mkdirSync(dir, { recursive: true })

    process.env.HOME = home
    process.env.CLAUDIN_CONFIG_DIR = configDir
    setProjectRoot(projectDir)
    setOriginalCwd(projectDir)
    setCwdState(projectDir)
    resetSettingsCache()
    scene = { root, configDir, projectDir, memoryDir: getAutoMemPath() }
  })

  afterEach(() => {
    if (directoriesBefore) {
      setCwdState(directoriesBefore.cwd)
      setOriginalCwd(directoriesBefore.original)
      setProjectRoot(directoriesBefore.project)
    }
    saveGlobalConfig(config => ({ ...config, notifyMemorySaved: announceBefore }))
    for (const [name, value] of variablesBefore) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetSettingsCache()
    if (scene) rmSync(scene.root, { recursive: true, force: true })
    scene = undefined
  })

  return () => {
    if (!scene) throw new Error('the scene only exists while a test runs')
    return scene
  }
}

/** Turns the "memory saved" notice on or off for the rest of the test. */
export function announceSavedMemories(on: boolean): void {
  saveGlobalConfig(config => ({ ...config, notifyMemorySaved: on }))
}

export type ForkScript = (request: ForkedAgentParams) => Promise<ForkedAgentResult>

export type ForkDouble = {
  /** Every request the unit sent to the forked agent, oldest first. */
  readonly requests: ForkedAgentParams[]
  /** How the next forks answer. Each test starts with a fork that writes nothing. */
  answer(script: ForkScript): void
}

/** Replaces `runForkedAgent` for this file, and hands the genuine one back afterwards. */
export function useForkDouble(): ForkDouble {
  const requests: ForkedAgentParams[] = []
  const silent: ForkScript = async () => forkReturns([])
  let script: ForkScript = silent

  mock.module('src/agent/coordinator/forkedAgent.js', () => ({
    ...genuineForkedAgent,
    runForkedAgent: (request: ForkedAgentParams) => {
      requests.push(request)
      return script(request)
    },
  }))

  beforeEach(() => {
    requests.length = 0
    script = silent
  })

  afterAll(() => {
    script = genuineForkedAgent.runForkedAgent
    mock.module('src/agent/coordinator/forkedAgent.js', () => genuineForkedAgent)
  })

  return {
    requests,
    answer(next) {
      script = next
    },
  }
}

/** What a fork hands back: its messages, and no usage. */
export function forkReturns(messages: Message[]): ForkedAgentResult {
  return { messages, totalUsage: { ...EMPTY_USAGE } }
}

type AssistantBlocks = Parameters<typeof createAssistantMessage>[0]['content']

let blockSerial = 0

/** A fresh tool-use id, unique within the run. */
export function nextToolUseId(): string {
  blockSerial += 1
  return `toolu_characterization_${blockSerial}`
}

/** A human turn. */
export function humanSays(text: string): Message {
  return createUserMessage({ content: text })
}

/** A plain assistant reply. */
export function assistantSays(text: string): Message {
  return createAssistantMessage({ content: text })
}

export type ToolUse = { tool: string; input: Record<string, unknown>; id?: string }

/** One assistant message carrying the given tool calls, in order. */
export function assistantCalls(...uses: ToolUse[]): Message {
  const blocks = uses.map(use => ({
    type: 'tool_use',
    id: use.id ?? nextToolUseId(),
    name: use.tool,
    input: use.input,
  }))
  return createAssistantMessage({ content: blocks as unknown as AssistantBlocks })
}

/** The user message that carries a tool's result back to the model. */
export function toolAnswers(toolUseId: string, text: string, failed: boolean): Message {
  return createUserMessage({
    content: [
      { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: failed },
    ],
    toolUseResult: text,
  })
}

/** The context the stop hook hands the unit when a main-thread turn ends. */
export function turnEnded(
  messages: Message[],
  toolUse: Partial<ToolUseContext> = {},
): REPLHookContext {
  return {
    messages,
    systemPrompt: asSystemPrompt(['the parent system prompt']),
    userContext: { claudeMd: 'the parent user context' },
    systemContext: { gitStatus: 'the parent system context' },
    toolUseContext: { ...toolUse } as ToolUseContext,
    querySource: 'repl_main_thread',
  }
}

/** Polls until `ready()` holds, failing after two seconds. */
export async function eventually(ready: () => boolean, what: string): Promise<void> {
  const giveUpAt = Date.now() + 2_000
  while (!ready()) {
    if (Date.now() > giveUpAt) throw new Error(`still waiting for ${what}`)
    await Bun.sleep(1)
  }
}

/** The checkout this file belongs to: the nearest directory holding bunfig.toml. */
export function checkoutRoot(): string {
  let dir = import.meta.dir
  while (!existsSync(join(dir, 'bunfig.toml'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('no bunfig.toml above the extraction suites')
    dir = parent
  }
  return dir
}
