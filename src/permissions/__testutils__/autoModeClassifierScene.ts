/**
 * Shared scene for the auto-mode classifier characterization suites.
 *
 * The only thing faked is the model. A suite installs `modelDouble.sideQuery`
 * in place of the real side-query function (taking its own copy of the real
 * module first), queues the replies it wants the "model" to give, and then
 * reads back every request the unit sent. Everything else runs for real:
 * settings, the temp dir, the session id, the bootstrap state.
 */
import { afterAll, beforeAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getCachedClaudeMdContent,
  getMainLoopModelOverride,
  setCachedClaudeMdContent,
  setLastClassifierRequests,
  setMainLoopModelOverride,
} from 'src/platform/bootstrap/state.js'
import { enableConfigs } from 'src/platform/config/config.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getClaudeTempDir } from 'src/platform/tmpdir.js'
import type { Message } from 'src/shared/types/message.js'
import type { ToolPermissionContext, Tools } from 'src/tools/Tool.js'

// ── the model double ────────────────────────────────────────────────────────

/** What a request looked like when it reached the model boundary. */
export type SentRequest = {
  model: string
  max_tokens: number
  temperature?: number
  thinking?: unknown
  stop_sequences?: string[]
  tools?: Array<{ name: string }>
  tool_choice?: { type: string; name: string }
  maxRetries?: number
  signal: AbortSignal
  system: string | Array<{ type: string; text: string; cache_control?: unknown }>
  messages: Array<{
    role: string
    content: string | Array<{ type: string; text?: string; cache_control?: unknown }>
  }>
}

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

/** One answer the double hands back, or what it does instead of answering. */
export type Reply = (request: SentRequest) => Promise<unknown>

function abortError(): Error {
  const error = new Error('Request was aborted.')
  error.name = 'AbortError'
  return error
}

function reply(
  content: unknown[],
  extra: { stop?: string | null; usage?: Usage; requestId?: string } = {},
): Reply {
  return async request => {
    if (request.signal.aborted) throw abortError()
    return {
      id: 'msg_double',
      type: 'message',
      role: 'assistant',
      model: request.model,
      content,
      stop_reason: extra.stop === undefined ? 'end_turn' : extra.stop,
      usage: {
        input_tokens: extra.usage?.input ?? 10,
        output_tokens: extra.usage?.output ?? 3,
        ...(extra.usage?.cacheRead !== undefined && { cache_read_input_tokens: extra.usage.cacheRead }),
        ...(extra.usage?.cacheWrite !== undefined && { cache_creation_input_tokens: extra.usage.cacheWrite }),
      },
      ...(extra.requestId !== undefined && { _request_id: extra.requestId }),
    }
  }
}

/** The model answers with plain text (the XML classifier's channel). */
export function says(text: string, extra?: Parameters<typeof reply>[1]): Reply {
  return reply([{ type: 'text', text }], extra)
}

/** The model answers with several content blocks of any kind. */
export function answers(blocks: unknown[], extra?: Parameters<typeof reply>[1]): Reply {
  return reply(blocks, extra)
}

/** The model answers by calling a tool (the tool_use classifier's channel). */
export function callsTool(name: string, input: unknown, extra?: Parameters<typeof reply>[1]): Reply {
  return reply([{ type: 'tool_use', id: 'toolu_double', name, input }], extra)
}

/** The request fails with this error. */
export function fails(error: unknown): Reply {
  return async request => {
    if (request.signal.aborted) throw abortError()
    throw error
  }
}

/** The request never answers; it rejects only once its signal is aborted. */
export function hangs(): Reply {
  return request =>
    new Promise((_resolve, reject) => {
      if (request.signal.aborted) {
        reject(abortError())
        return
      }
      request.signal.addEventListener('abort', () => reject(abortError()), { once: true })
    })
}

/** The request answers after `ms`, whatever happens to its signal meanwhile. */
export function answersLate(ms: number, then: Reply): Reply {
  return async request => {
    await Bun.sleep(ms)
    return then({ ...request, signal: new AbortController().signal })
  }
}

export type ModelDouble = {
  /** Drop-in for the real side-query function. */
  sideQuery: (request: SentRequest) => Promise<unknown>
  /** Every request received, in order. */
  sent: SentRequest[]
  /** Queue the next replies, consumed one per request. */
  queue: (...replies: Reply[]) => void
  /** Forget the queue and the record. */
  reset: () => void
}

export function createModelDouble(): ModelDouble {
  const sent: SentRequest[] = []
  let pending: Reply[] = []
  return {
    sent,
    sideQuery: request => {
      sent.push(request)
      const next = pending.shift()
      if (!next) return Promise.reject(new Error('the model double has no reply queued'))
      return next(request)
    },
    queue: (...replies) => {
      pending.push(...replies)
    },
    reset: () => {
      sent.length = 0
      pending = []
    },
  }
}

// ── requests, read back ─────────────────────────────────────────────────────

/** The system text of a request, whatever form it was sent in. */
export function systemText(request: SentRequest): string {
  return typeof request.system === 'string'
    ? request.system
    : request.system.map(block => block.text).join('')
}

/** The content blocks of the last message of a request. */
export function lastUserBlocks(request: SentRequest): Array<{ type: string; text?: string; cache_control?: unknown }> {
  const last = request.messages.at(-1)
  if (!last || typeof last.content === 'string') return []
  return last.content
}

/** The text of the last message of a request, all blocks joined. */
export function lastUserText(request: SentRequest): string {
  const last = request.messages.at(-1)
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  return last.content.map(block => block.text ?? '').join('')
}

// ── inputs ──────────────────────────────────────────────────────────────────

type FakeTool = {
  name: string
  aliases?: string[]
  toAutoClassifierInput: (input: Record<string, unknown>) => unknown
}

/** A tool list as the classifier sees it: a name, aliases and a projection. */
export function toolbox(...tools: FakeTool[]): Tools {
  return tools as unknown as Tools
}

/** A shell tool whose projection is the command string. */
export const shellTool: FakeTool = {
  name: 'Bash',
  aliases: ['Shell'],
  toAutoClassifierInput: input => String(input.command ?? ''),
}

/** A tool that declares nothing worth classifying. */
export const silentTool: FakeTool = {
  name: 'Quiet',
  toAutoClassifierInput: () => '',
}

/** A tool whose projection is a structured object. */
export const structuredTool: FakeTool = {
  name: 'Deploy',
  toAutoClassifierInput: input => ({ target: input.target, force: input.force === true }),
}

/** A tool whose projection gives nothing back, so the raw input is used. */
export const passThroughTool: FakeTool = {
  name: 'Raw',
  toAutoClassifierInput: () => undefined,
}

/** A tool whose projection throws on the input it is handed. */
export const brittleTool: FakeTool = {
  name: 'Brittle',
  toAutoClassifierInput: input => {
    if (!Array.isArray(input.paths)) throw new TypeError('paths must be an array')
    return input.paths.join(' ')
  },
}

export function userSays(text: string, origin?: Record<string, unknown>): Message {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    ...(origin && { origin }),
  } as unknown as Message
}

export function userBlocks(blocks: unknown[]): Message {
  return { type: 'user', message: { role: 'user', content: blocks } } as unknown as Message
}

export function assistantDoes(blocks: unknown[]): Message {
  return { type: 'assistant', message: { role: 'assistant', content: blocks } } as unknown as Message
}

export function toolUse(name: string, input: unknown): Record<string, unknown> {
  return { type: 'tool_use', id: `toolu_${name}`, name, input }
}

export function queuedPrompt(prompt: unknown, origin?: Record<string, unknown>): Message {
  return {
    type: 'attachment',
    attachment: { type: 'queued_command', prompt, ...(origin && { origin }) },
  } as unknown as Message
}

export function permissionContext(
  overrides: Partial<{
    mode: string
    allow: string[]
    deny: string[]
    ask: string[]
  }> = {},
): ToolPermissionContext {
  return {
    mode: overrides.mode ?? 'auto',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: overrides.allow ? { userSettings: overrides.allow } : {},
    alwaysDenyRules: overrides.deny ? { userSettings: overrides.deny } : {},
    alwaysAskRules: overrides.ask ? { userSettings: overrides.ask } : {},
    isBypassPermissionsModeAvailable: false,
  } as unknown as ToolPermissionContext
}

// ── prompt templates the suites inject ──────────────────────────────────────

/** A base prompt with the placeholder and the tool-use closing line. */
export const BASE_TEMPLATE = [
  'You review actions an autonomous agent wants to take.',
  '<permissions_template>',
  'Use the classify_result tool to report your classification.',
].join('\n')

/** One `<name>` section wrapping a defaults block, as the shipped template lays them out. */
function rulesSection(name: string, tag: string, defaults: string[]): string {
  const bullets = defaults.map(rule => `- ${rule}`).join('\n')
  return `<${name}>\n<${tag}>\n${bullets}\n</${tag}>\n</${name}>`
}

/** A permissions template with one defaults block per section. */
export const RULES_TEMPLATE = [
  rulesSection('allow', 'user_allow_rules_to_replace', ['read files in the repository', 'run the test suite']),
  rulesSection('deny', 'user_deny_rules_to_replace', ['push to the default branch']),
  rulesSection('environment', 'user_environment_to_replace', ['the trusted remote is github.com/acme/app']),
].join('\n')

// ── the process-wide state a suite borrows ──────────────────────────────────

const BORROWED_ENV = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_TMPDIR', 'CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS', 'CLAUDIN_MAX_RETRIES'] as const

export type ClassifierScene = {
  root: string
  configDir: string
  tempBase: string
  /** Point the main-loop model (and so the classifier) at this model. */
  useModel: (model: string) => void
}

/**
 * Temp config dir and temp dir, a pinned model, configs enabled; everything
 * put back afterwards in this file's scope.
 */
export function useClassifierScene(initialModel = 'claude-sonnet-4-6'): () => ClassifierScene {
  let scene: ClassifierScene | undefined
  const savedEnv = new Map<string, string | undefined>()
  let savedModel: ReturnType<typeof getMainLoopModelOverride>
  let savedClaudeMd: string | null = null

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'auto-mode-classifier-'))
    const configDir = join(root, 'config')
    const tempBase = join(root, 'tmp')
    mkdirSync(configDir)
    mkdirSync(tempBase)
    for (const key of BORROWED_ENV) savedEnv.set(key, process.env[key])
    process.env.CLAUDIN_CONFIG_DIR = configDir
    process.env.CLAUDIN_TMPDIR = tempBase
    delete process.env.CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS
    process.env.CLAUDIN_MAX_RETRIES = '0'
    getClaudeTempDir.cache.clear?.()
    resetSettingsCache()
    enableConfigs()
    savedModel = getMainLoopModelOverride()
    savedClaudeMd = getCachedClaudeMdContent()
    setCachedClaudeMdContent(null)
    setMainLoopModelOverride(initialModel)
    scene = {
      root,
      configDir,
      tempBase,
      useModel: model => setMainLoopModelOverride(model),
    }
  })

  afterAll(() => {
    setMainLoopModelOverride(savedModel)
    setCachedClaudeMdContent(savedClaudeMd)
    setLastClassifierRequests(null)
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    getClaudeTempDir.cache.clear?.()
    resetSettingsCache()
    if (scene) rmSync(scene.root, { recursive: true, force: true })
  })

  return () => {
    if (!scene) throw new Error('the classifier scene is only ready inside a test')
    return scene
  }
}
