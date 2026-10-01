import type {
  BetaContextManagementResponse,
  BetaMessageParam,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createPatch } from 'diff'
import { appendFile, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { gzipSync } from 'zlib'
import type { AgentId } from 'src/shared/types/ids.js'
import type { Message } from 'src/shared/types/message.js'
import { logForDebugging } from 'src/shared/debug.js'
import { djb2Hash } from 'src/shared/data/hash.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'
import { logError } from 'src/shared/log.js'
import { getClaudeTempDir } from 'src/platform/tmpdir.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import type { QuerySource } from 'src/agent/prompts/querySource.js'
import { formatCompactNumber } from 'src/providers/cache/cacheMetrics.js'
import { recordCacheBreak } from 'src/providers/cache/cacheStatsTracker.js'
import { getCacheTrackingKey } from 'src/providers/cache/trackingKey.js'

function getCacheBreakDiffPath(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return join(getClaudeTempDir(), `cache-break-${suffix}.diff`)
}

type PreviousState = {
  systemHash: number
  toolsHash: number
  /** Hash of system blocks WITH cache_control intact. Catches scope/TTL flips
   *  (global↔org, 1h↔5m) that stripCacheControl erases from systemHash. */
  cacheControlHash: number
  toolNames: string[]
  /** Per-tool schema hash. Diffed to name which tool's description changed
   *  when toolSchemasChanged but added=removed=0 (77% of tool breaks per
   *  BQ 2026-03-22). AgentTool/SkillTool embed dynamic agent/command lists. */
  perToolHashes: Record<string, number>
  systemCharCount: number
  model: string
  fastMode: boolean
  /** 'tool_based' | 'system_prompt' | 'none' — flips when MCP tools are
   *  discovered/removed. */
  globalCacheStrategy: string
  /** Sorted beta header list. Diffed to show which headers were added/removed. */
  betas: string[]
  /** AFK_MODE_BETA_HEADER presence — should NOT break cache anymore
   *  (sticky-on latched in claude.ts). Tracked to verify the fix. */
  autoModeActive: boolean
  /** Overage state flip — no longer affects cache TTL (subscriber-eligibility
   *  gate was removed from should1hCacheTTL; TTL now keys off latched
   *  large-system-prompt detection). Tracked for diagnostics only. */
  isUsingOverage: boolean
  /** Resolved effort (env → options → model default). Goes into output_config
   *  or anthropic_internal.effort_override. */
  effortValue: string
  /** Hash of getExtraBodyParams() — catches CLAUDIN_EXTRA_BODY and
   *  anthropic_internal changes. */
  extraBodyHash: number
  callCount: number
  pendingChanges: PendingChanges | null
  prevCacheReadTokens: number | null
  /** Set when a compaction step legitimately drops the cached prefix
   *  (e.g. time-based microcompact). Next read drop is expected, not a break. */
  cacheDeletionsPending: boolean
  /** Which client mechanism announced the pending drop (for the log line). */
  cacheDeletionReason: string | null
  buildDiffableContent: () => string
  /** Per-message hash of the previous request's rendered `messages` array
   *  (cache_control stripped). The system/tools hashes above cannot see a
   *  byte changing INSIDE the history — a rewritten tool_result, a dropped
   *  block — which is exactly the rewrite that read as "server-side, prompt
   *  unchanged" for two 180k/250k re-bills in one session (2026-09-04). */
  msgHashes: number[]
  /** The rendered JSON behind each hash, kept so a mutation can be diffed
   *  message-by-message. ~1 MB per tracked source at a 200k context, so it is
   *  kept for the main thread only (see recordRenderedMessages). */
  msgJson: string[]
  pendingMessageMutation: MessageMutation | null
  /** How far the message marker moved on this request, in the API's lookback
   *  positions, and whether the lagging marker was placed to cover it. */
  pendingMarkerAdvance: MarkerAdvance | null
  /** The thinking blocks the server dropped from the previous response's
   *  request (readThinkingDrops). It drops them again on every later request
   *  while their prefix stays changed, so only paths not in here are news. */
  thinkingDropPaths: Set<string>
}

/** The first message whose rendered bytes changed behind the previous
 *  request's tail — a client-side prefix rewrite, whatever caused it. */
export type MessageMutation = {
  /** 0-based index into the rendered `messages` array. */
  index: number
  /** Length of the PREVIOUS request's array (the prefix that was cached). */
  total: number
  role: string
  /** Block types of the mutated message, e.g. `tool_result` or `text,tool_use`. */
  blockTypes: string
  prevJson: string
  newJson: string
}

/**
 * The marker placement of one request, as `addCacheBreakpoints` reports it.
 * The API resolves a breakpoint by checking at most CACHE_LOOKBACK_POSITIONS
 * positions behind it; a marker that advanced further than that past the
 * previous request's write misses the entry and the history is rewritten
 * from the system breakpoint — with every client-side hash unchanged. The
 * lagging marker (`shims/claude/lagCacheMarker.ts`) exists to catch exactly
 * that; when it was placed and the read still collapsed, the miss is the
 * server's.
 */
export type MarkerAdvance = {
  positions: number
  lagPlaced: boolean
}

/** Mirrors CACHE_LOOKBACK_POSITIONS in lagCacheMarker.ts — the detector must
 *  not import the renderer. */
const LOOKBACK_POSITIONS = 20

const THINKING_DROP_MESSAGE_RE = /^messages\.(\d+)\./

type PendingChanges = {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  addedBetas: string[]
  removedBetas: string[]
  prevEffortValue: string
  newEffortValue: string
  buildPrevDiffableContent: () => string
}

const previousStateBySource = new Map<string, PreviousState>()

// Cap the number of tracked sources to prevent unbounded memory growth: every
// sub-agent keys on its own agentId. A finished agent's entry is dropped by
// cleanupAgentTracking (runAgent.ts), so the cap bounds the LIVE set, and it
// has to hold a fan-out. At 10, with eviction by insertion order, a batch of
// 10–12 concurrent sub-agents evicted the main thread first, and every state
// recreated after an eviction skips its next call: session 501d7261
// (2026-09-28) put 9 of ~40 sub-agent rewrites on the `[Cache:]` line.
// recordPromptState refreshes recency on every request, so the entry evicted
// is the one that went quiet longest.
const MAX_TRACKED_SOURCES = 32

// Minimum absolute token drop required to trigger a cache break warning.
// Small drops (e.g., a few thousand tokens) can happen due to normal variation
// and aren't worth alerting on.
const MIN_CACHE_MISS_TOKENS = 2_000

/** System block 0 on the first-party lane (getAttributionHeader). */
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'

// Anthropic's server-side prompt cache TTL thresholds to test.
// Cache breaks after these durations are likely due to TTL expiration
// rather than client-side changes.
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000

// Models to exclude from cache break detection (e.g., haiku has different caching behavior)
function isExcludedModel(model: string): boolean {
  return model.includes('haiku')
}

// The key is shared with the lagging marker so both agree on which requests
// share one server-side prefix; see trackingKey.ts for the rules.
const getTrackingKey = getCacheTrackingKey

function stripCacheControl(
  items: ReadonlyArray<Record<string, unknown>>,
): unknown[] {
  return items.map(item => {
    if (!('cache_control' in item)) return item
    const { cache_control: _, ...rest } = item
    return rest
  })
}

type WireBlock = Record<string, unknown> & { type?: string; content?: unknown }

/**
 * A message as the prompt cache sees it: the wire bytes minus the
 * `cache_control` markers, which move every turn by design
 * (defer-cache-marker), with a string `content` written as the one text block
 * it stands for. addCacheBreakpoints turns the marked message's string into a
 * block to carry the marker, and the next request sends a string again — the
 * same prompt: count_tokens measured a user message and a tool_result either
 * way at the same size, with no thinking dropped (2026-10-01), while one
 * changed character drops it.
 */
export function canonicalWireMessage(message: BetaMessageParam): unknown {
  const content =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : (message.content as unknown as WireBlock[]).map(block =>
          block.type === 'tool_result' && typeof block.content === 'string'
            ? { ...block, content: [{ type: 'text', text: block.content }] }
            : block,
        )
  return { ...message, content: stripCacheControl(content) }
}

function describeBlockTypes(message: BetaMessageParam): string {
  if (!Array.isArray(message.content)) return 'text'
  const seen: string[] = []
  for (const block of message.content) {
    const type = (block as { type?: string }).type ?? 'unknown'
    if (!seen.includes(type)) seen.push(type)
  }
  return seen.join(',')
}

function computeHash(data: unknown): number {
  const str = jsonStringify(data)
  if (typeof Bun !== 'undefined') {
    const hash = Bun.hash(str)
    // Bun.hash can return bigint for large inputs; convert to number safely
    return typeof hash === 'bigint' ? Number(hash & 0xffffffffn) : hash
  }
  // Fallback for non-Bun runtimes (e.g. Node.js via npm global install)
  return djb2Hash(str)
}

/** MCP tool names are user-controlled (server config) and may leak filepaths.
 *  Collapse them to 'mcp'; built-in names are a fixed vocabulary. */
function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}

function computePerToolHashes(
  strippedTools: ReadonlyArray<unknown>,
  names: string[],
): Record<string, number> {
  const hashes: Record<string, number> = {}
  for (let i = 0; i < strippedTools.length; i++) {
    hashes[names[i] ?? `__idx_${i}`] = computeHash(strippedTools[i])
  }
  return hashes
}

function getSystemCharCount(system: TextBlockParam[]): number {
  let total = 0
  for (const block of system) {
    total += block.text.length
  }
  return total
}

function buildDiffableContent(
  system: TextBlockParam[],
  tools: BetaToolUnion[],
  model: string,
): string {
  const systemText = system.map(b => b.text).join('\n\n')
  const toolDetails = tools
    .map(t => {
      if (!('name' in t)) return 'unknown'
      const desc = 'description' in t ? t.description : ''
      const schema = 'input_schema' in t ? jsonStringify(t.input_schema) : ''
      return `${t.name}\n  description: ${desc}\n  input_schema: ${schema}`
    })
    .sort()
    .join('\n\n')
  return `Model: ${model}\n\n=== System Prompt ===\n\n${systemText}\n\n=== Tools (${tools.length}) ===\n\n${toolDetails}\n`
}

/** Extended tracking snapshot — everything that could affect the server-side
 *  cache key that we can observe from the client. All fields are optional so
 *  the call site can add incrementally; undefined fields compare as stable. */
export type PromptStateSnapshot = {
  system: TextBlockParam[]
  toolSchemas: BetaToolUnion[]
  querySource: QuerySource
  model: string
  agentId?: AgentId
  fastMode?: boolean
  globalCacheStrategy?: string
  betas?: readonly string[]
  autoModeActive?: boolean
  isUsingOverage?: boolean
  effortValue?: string | number
  extraBodyParams?: unknown
}

/**
 * Phase 1 (pre-call): Record the current prompt/tool state and detect what changed.
 * Does NOT fire events — just stores pending changes for phase 2 to use.
 */
export function recordPromptState(snapshot: PromptStateSnapshot): void {
  try {
    const {
      system,
      toolSchemas,
      querySource,
      model,
      agentId,
      fastMode,
      globalCacheStrategy = '',
      betas = [],
      autoModeActive = false,
      isUsingOverage = false,
      effortValue,
      extraBodyParams,
    } = snapshot
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    // The billing header is not part of the cached prompt: a request whose
    // header carried another fingerprint read the whole prefix back
    // (2026-10-01), and the fingerprint does move between a session's first
    // request and the next. Hashing it reported a system change that was not.
    const cachedSystem = system.filter(b => !b.text.startsWith(BILLING_HEADER_PREFIX))
    const strippedSystem = stripCacheControl(
      cachedSystem as unknown as ReadonlyArray<Record<string, unknown>>,
    )
    const strippedTools = stripCacheControl(
      toolSchemas as unknown as ReadonlyArray<Record<string, unknown>>,
    )

    const systemHash = computeHash(strippedSystem)
    const toolsHash = computeHash(strippedTools)
    // Hash the full system array INCLUDING cache_control — this catches
    // scope flips (global↔org/none) and TTL flips (1h↔5m) that the stripped
    // hash can't see because the text content is identical.
    const cacheControlHash = computeHash(
      cachedSystem.map(b => ('cache_control' in b ? b.cache_control : null)),
    )
    const toolNames = toolSchemas.map(t => ('name' in t ? t.name : 'unknown'))
    // Only compute per-tool hashes when the aggregate changed — common case
    // (tools unchanged) skips N extra jsonStringify calls.
    const computeToolHashes = () =>
      computePerToolHashes(strippedTools, toolNames)
    const systemCharCount = getSystemCharCount(cachedSystem)
    const lazyDiffableContent = () =>
      buildDiffableContent(system, toolSchemas, model)
    const isFastMode = fastMode ?? false
    const sortedBetas = [...betas].sort()
    const effortStr = effortValue === undefined ? '' : String(effortValue)
    const extraBodyHash =
      extraBodyParams === undefined ? 0 : computeHash(extraBodyParams)

    const prev = previousStateBySource.get(key)

    if (!prev) {
      // Evict oldest entries if map is at capacity
      while (previousStateBySource.size >= MAX_TRACKED_SOURCES) {
        const oldest = previousStateBySource.keys().next().value
        if (oldest !== undefined) previousStateBySource.delete(oldest)
      }

      previousStateBySource.set(key, {
        systemHash,
        toolsHash,
        cacheControlHash,
        toolNames,
        systemCharCount,
        model,
        fastMode: isFastMode,
        globalCacheStrategy,
        betas: sortedBetas,
        autoModeActive,
        isUsingOverage,
        effortValue: effortStr,
        extraBodyHash,
        callCount: 1,
        pendingChanges: null,
        prevCacheReadTokens: null,
        cacheDeletionsPending: false,
        cacheDeletionReason: null,
        buildDiffableContent: lazyDiffableContent,
        perToolHashes: computeToolHashes(),
        msgHashes: [],
        msgJson: [],
        pendingMessageMutation: null,
        pendingMarkerAdvance: null,
        thinkingDropPaths: new Set(),
      })
      return
    }

    // Least recently used goes first: re-insert so a Map's insertion order
    // tracks the last request, not the first.
    previousStateBySource.delete(key)
    previousStateBySource.set(key, prev)
    prev.callCount++

    const systemPromptChanged = systemHash !== prev.systemHash
    const toolSchemasChanged = toolsHash !== prev.toolsHash
    const modelChanged = model !== prev.model
    const fastModeChanged = isFastMode !== prev.fastMode
    const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
    const globalCacheStrategyChanged =
      globalCacheStrategy !== prev.globalCacheStrategy
    const betasChanged =
      sortedBetas.length !== prev.betas.length ||
      sortedBetas.some((b, i) => b !== prev.betas[i])
    const autoModeChanged = autoModeActive !== prev.autoModeActive
    const overageChanged = isUsingOverage !== prev.isUsingOverage
    const effortChanged = effortStr !== prev.effortValue
    const extraBodyChanged = extraBodyHash !== prev.extraBodyHash

    if (
      systemPromptChanged ||
      toolSchemasChanged ||
      modelChanged ||
      fastModeChanged ||
      cacheControlChanged ||
      globalCacheStrategyChanged ||
      betasChanged ||
      autoModeChanged ||
      overageChanged ||
      effortChanged ||
      extraBodyChanged
    ) {
      const prevToolSet = new Set(prev.toolNames)
      const newToolSet = new Set(toolNames)
      const prevBetaSet = new Set(prev.betas)
      const newBetaSet = new Set(sortedBetas)
      const addedTools = toolNames.filter(n => !prevToolSet.has(n))
      const removedTools = prev.toolNames.filter(n => !newToolSet.has(n))
      const changedToolSchemas: string[] = []
      if (toolSchemasChanged) {
        const newHashes = computeToolHashes()
        for (const name of toolNames) {
          if (!prevToolSet.has(name)) continue
          if (newHashes[name] !== prev.perToolHashes[name]) {
            changedToolSchemas.push(name)
          }
        }
        prev.perToolHashes = newHashes
      }
      prev.pendingChanges = {
        systemPromptChanged,
        toolSchemasChanged,
        modelChanged,
        fastModeChanged,
        cacheControlChanged,
        globalCacheStrategyChanged,
        betasChanged,
        autoModeChanged,
        overageChanged,
        effortChanged,
        extraBodyChanged,
        addedToolCount: addedTools.length,
        removedToolCount: removedTools.length,
        addedTools,
        removedTools,
        changedToolSchemas,
        systemCharDelta: systemCharCount - prev.systemCharCount,
        previousModel: prev.model,
        newModel: model,
        prevGlobalCacheStrategy: prev.globalCacheStrategy,
        newGlobalCacheStrategy: globalCacheStrategy,
        addedBetas: sortedBetas.filter(b => !prevBetaSet.has(b)),
        removedBetas: prev.betas.filter(b => !newBetaSet.has(b)),
        prevEffortValue: prev.effortValue,
        newEffortValue: effortStr,
        buildPrevDiffableContent: prev.buildDiffableContent,
      }
    } else {
      prev.pendingChanges = null
    }

    prev.systemHash = systemHash
    prev.toolsHash = toolsHash
    prev.cacheControlHash = cacheControlHash
    prev.toolNames = toolNames
    prev.systemCharCount = systemCharCount
    prev.model = model
    prev.fastMode = isFastMode
    prev.globalCacheStrategy = globalCacheStrategy
    prev.betas = sortedBetas
    prev.autoModeActive = autoModeActive
    prev.isUsingOverage = isUsingOverage
    prev.effortValue = effortStr
    prev.extraBodyHash = extraBodyHash
    prev.buildDiffableContent = lazyDiffableContent
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * Phase 1b (pre-call, after the wire render): remember each rendered message
 * and find the first one whose bytes differ from the previous request's copy
 * at the same index. Only indices the previous request already had can be a
 * mutation — the tail is new by definition — so a pure append records
 * nothing. Must run on the array that goes on the wire (after stable stubs
 * and cache breakpoints), not on the REPL's message array.
 */
export function recordRenderedMessages(
  querySource: QuerySource,
  agentId: AgentId | undefined,
  renderedMessages: readonly BetaMessageParam[],
): void {
  try {
    const key = getTrackingKey(querySource, agentId)
    if (!key) return
    const state = previousStateBySource.get(key)
    if (!state) return

    const msgJson = renderedMessages.map(m =>
      jsonStringify(canonicalWireMessage(m)),
    )
    const msgHashes = msgJson.map(computeHash)
    // The same request rendered again (a withRetry attempt) is not a new
    // request: compared with itself it finds nothing, and recording that
    // would erase the mutation the first render found. Same rule as the lag
    // marker's retry (lagCacheMarker.ts).
    if (
      msgHashes.length === state.msgHashes.length &&
      msgHashes.every((h, i) => h === state.msgHashes[i])
    ) {
      return
    }
    // A sub-agent's mutation is still named by index, role and block types;
    // only the diff file loses its "before" side. Its JSON copy (~2 MB at a
    // 500k context) times a fan-out's live set is memory the diagnosis does
    // not need.
    const keepJson = agentId === undefined

    let mutation: MessageMutation | null = null
    const comparable = Math.min(state.msgHashes.length, msgHashes.length)
    for (let i = 0; i < comparable; i++) {
      if (msgHashes[i] === state.msgHashes[i]) continue
      const message = renderedMessages[i]!
      mutation = {
        index: i,
        total: state.msgHashes.length,
        role: message.role,
        blockTypes: describeBlockTypes(message),
        prevJson: state.msgJson[i] ?? '',
        newJson: msgJson[i] ?? '',
      }
      break
    }

    state.pendingMessageMutation = mutation
    state.msgHashes = msgHashes
    state.msgJson = keepJson ? msgJson : []
    if (isCacheStrict()) reportStrictViolation(key, state, mutation)
  } catch (e: unknown) {
    logError(e)
  }
}

// ---------------------------------------------------------------------------
// Strict mode — CLAUDIN_CACHE_STRICT=1, off by default.
//
// Turns the request-side half of the detector into an assertion, for the
// end-to-end suites and the benches that drive the built CLI: a request that
// changes bytes the previous one sent — a message behind the tail, the system
// prompt, the tools array — without a client mechanism having announced it
// (notifyCacheDeletion: the relief clip) writes `[PROMPT CACHE STRICT] …` to
// stderr, one line per offending request. The line is the signal, not the exit
// code: headless ends through gracefulShutdown(0), which sets its own, and
// src/shared/ may not import the detector to change it. A model switch is a
// different cache and does not count; /clear and /compact reset the tracking.
//
// It needs no server: the verdict is on the bytes sent, not on a cache read
// dropping, so it works against a mock that never reports one.
// ---------------------------------------------------------------------------

export const CACHE_STRICT_MARKER = '[PROMPT CACHE STRICT]'

function isCacheStrict(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_CACHE_STRICT)
}

/** What a strict-mode request changed that it should not have, or null. */
function describeStrictViolation(
  changes: PendingChanges | null,
  mutation: MessageMutation | null,
  announced: boolean,
): string | null {
  if (announced || changes?.modelChanged) return null
  const parts: string[] = []
  if (mutation) {
    let at = 0
    while (at < mutation.prevJson.length && mutation.prevJson[at] === mutation.newJson[at]) at++
    const around = (s: string) => JSON.stringify(s.slice(Math.max(0, at - 60), at + 100))
    parts.push(
      `messages mutated at ${mutation.index}/${mutation.total} (${mutation.role}: ${mutation.blockTypes})` +
        (mutation.prevJson ? `: sent ${around(mutation.prevJson)}, resent ${around(mutation.newJson)}` : ''),
    )
  }
  if (changes?.systemPromptChanged) {
    parts.push(`system prompt changed (${changes.systemCharDelta >= 0 ? '+' : ''}${changes.systemCharDelta} chars)`)
  }
  if (changes?.toolSchemasChanged) {
    const detail = [
      ...changes.addedTools.map(t => `+${t}`),
      ...changes.removedTools.map(t => `-${t}`),
      ...changes.changedToolSchemas.map(t => `~${t}`),
    ].join(' ')
    parts.push(`tools changed${detail ? ` (${detail})` : ''}`)
  }
  return parts.length > 0 ? parts.join('; ') : null
}

function reportStrictViolation(
  key: string,
  state: PreviousState,
  mutation: MessageMutation | null,
): void {
  const violation = describeStrictViolation(
    state.pendingChanges,
    mutation,
    state.cacheDeletionsPending,
  )
  if (!violation) return
  process.stderr.write(`${CACHE_STRICT_MARKER} [${key}] call #${state.callCount}: ${violation}\n`)
}

export function _getPendingMessageMutationForTesting(
  querySource: QuerySource,
  agentId?: AgentId,
): MessageMutation | null {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  return state?.pendingMessageMutation ?? null
}

/**
 * Phase 1c (pre-call, from `addCacheBreakpoints`): remember how far the
 * message marker advanced on this request so a break with every hash
 * unchanged can be named a lookback miss instead of "server-side".
 */
export function recordMarkerAdvance(
  querySource: QuerySource,
  agentId: AgentId | undefined,
  advance: MarkerAdvance | null,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) state.pendingMarkerAdvance = advance
}

export function _getPendingMarkerAdvanceForTesting(
  querySource: QuerySource,
  agentId?: AgentId,
): MarkerAdvance | null {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  return state?.pendingMarkerAdvance ?? null
}

/**
 * Summarize the server-side context_management edits applied to a response.
 * Returns undefined when nothing was cleared, so a `{ applied_edits: [] }`
 * envelope (the common case under the beta) reads as "no server edit".
 */
export function summarizeAppliedContextEdits(
  contextManagement: BetaContextManagementResponse | null | undefined,
): { clearedInputTokens: number; clearedToolUses: number } | undefined {
  const edits = contextManagement?.applied_edits
  if (!edits || edits.length === 0) return undefined
  let clearedInputTokens = 0
  let clearedToolUses = 0
  for (const edit of edits) {
    clearedInputTokens += edit.cleared_input_tokens ?? 0
    if ('cleared_tool_uses' in edit) {
      clearedToolUses += edit.cleared_tool_uses ?? 0
    }
  }
  if (clearedInputTokens === 0 && clearedToolUses === 0) return undefined
  return { clearedInputTokens, clearedToolUses }
}

/**
 * The server's own answer to "why did this request miss the cache", returned
 * when the request carried `diagnostics.previous_message_id`
 * (cache-diagnosis-2026-04-07). Claude Code 2.1.280 knows these `type` values:
 * - model_changed, system_changed, tools_changed, messages_changed
 * - previous_message_not_found, unavailable
 *
 * The field is kept as a string so a new value still reads.
 */
export type ServerCacheMissReason = {
  type: string
  cacheMissedInputTokens?: number
}

/**
 * Reads `diagnostics.cache_miss_reason` from a message_start message or a
 * message_delta event. Returns null for anything else, including a cache hit.
 */
export function readServerCacheMissReason(
  source: unknown,
): ServerCacheMissReason | null {
  if (typeof source !== 'object' || source === null) return null
  const diagnostics = (source as { diagnostics?: unknown }).diagnostics
  if (typeof diagnostics !== 'object' || diagnostics === null) return null
  const reason = (diagnostics as { cache_miss_reason?: unknown })
    .cache_miss_reason
  if (typeof reason !== 'object' || reason === null) return null
  const type = (reason as { type?: unknown }).type
  if (typeof type !== 'string' || type.length === 0) return null
  const tokens = (reason as { cache_missed_input_tokens?: unknown })
    .cache_missed_input_tokens
  return typeof tokens === 'number'
    ? { type, cacheMissedInputTokens: tokens }
    : { type }
}

function describeServerCacheMissReason(
  reason: ServerCacheMissReason,
): string {
  const tokens = reason.cacheMissedInputTokens
  const size =
    tokens !== undefined && tokens > 0
      ? ` (${formatCompactNumber(tokens)} missed)`
      : ''
  return `server: ${reason.type.replaceAll('_', ' ')}${size}`
}

/**
 * Paths of the thinking blocks the server dropped from this request, from
 * `message_start.message.input_transformations` (`thinking_dropped`), e.g.
 * `messages.193.content.0`. Opus 5.5 binds every thinking block to the bytes
 * of system, tools and the messages before it; when those changed, a request
 * carrying `block_binding: drop_block` gets the block — and every later one —
 * dropped instead of a 400, and the cached prefix is written again from the
 * first of them. It is the server's own account of a rewrite the client hash
 * may not see. Empty for anything else.
 */
export function readThinkingDrops(message: unknown): string[] {
  if (typeof message !== 'object' || message === null) return []
  const transformations = (message as { input_transformations?: unknown })
    .input_transformations
  if (!Array.isArray(transformations)) return []
  const paths: string[] = []
  for (const t of transformations) {
    if (typeof t !== 'object' || t === null) continue
    const { type, path } = t as { type?: unknown; path?: unknown }
    if (type === 'thinking_dropped' && typeof path === 'string') paths.push(path)
  }
  return paths
}

function describeThinkingDrops(paths: readonly string[]): string {
  const first = Math.min(
    ...paths.map(p => Number(THINKING_DROP_MESSAGE_RE.exec(p)?.[1] ?? Infinity)),
  )
  const where = Number.isFinite(first) ? ` from messages.${first}` : ''
  return `server dropped ${paths.length} thinking block${paths.length === 1 ? '' : 's'}${where}`
}

/**
 * Human-readable cause for a detected cache break. Pure — exported so the
 * labeling can be pinned without driving the whole detector.
 *
 * Precedence: a server-side context edit we can SEE (the response reports
 * cleared tokens) wins, then client-side prompt changes, then TTL guesses.
 * Post PR #19823 BQ analysis (bq-queries/prompt-caching/cache_break_pr19823_analysis.sql):
 * when all client-side flags are false and the gap is under TTL, ~90% of
 * breaks are server-side routing/eviction or billed/inference disagreement —
 * label accordingly instead of implying a CC bug hunt.
 */
export function buildCacheBreakReason(
  changes: PendingChanges | null,
  serverEdit: ReturnType<typeof summarizeAppliedContextEdits>,
  timeSinceLastAssistantMsg: number | null,
  messageMutation: MessageMutation | null = null,
  markerAdvance: MarkerAdvance | null = null,
): string {
  const parts: string[] = []
  if (changes) {
    if (changes.modelChanged) {
      parts.push(
        `model changed (${changes.previousModel} → ${changes.newModel})`,
      )
    }
    if (changes.systemPromptChanged) {
      const charDelta = changes.systemCharDelta
      const charInfo =
        charDelta === 0
          ? ''
          : charDelta > 0
            ? ` (+${charDelta} chars)`
            : ` (${charDelta} chars)`
      parts.push(`system prompt changed${charInfo}`)
    }
    if (changes.toolSchemasChanged) {
      // Name the moved tools (capped) — a deferred tool entering the
      // array is the discovery-driven break, and the name says so.
      const names = [
        ...changes.addedTools.map(n => `+${n}`),
        ...changes.removedTools.map(n => `-${n}`),
      ]
      const namesInfo =
        names.length > 0
          ? `: ${names.slice(0, 4).join(',')}${names.length > 4 ? ',…' : ''}`
          : ''
      const toolDiff =
        changes.addedToolCount > 0 || changes.removedToolCount > 0
          ? ` (+${changes.addedToolCount}/-${changes.removedToolCount} tools${namesInfo})`
          : ' (tool prompt/schema changed, same tool set)'
      parts.push(`tools changed${toolDiff}`)
    }
    if (changes.fastModeChanged) {
      parts.push('fast mode toggled')
    }
    if (changes.globalCacheStrategyChanged) {
      parts.push(
        `global cache strategy changed (${changes.prevGlobalCacheStrategy || 'none'} → ${changes.newGlobalCacheStrategy || 'none'})`,
      )
    }
    if (
      changes.cacheControlChanged &&
      !changes.globalCacheStrategyChanged &&
      !changes.systemPromptChanged
    ) {
      // Only report as standalone cause if nothing else explains it —
      // otherwise the scope/TTL flip is a consequence, not the root cause.
      parts.push('cache_control changed (scope or TTL)')
    }
    if (changes.betasChanged) {
      const added = changes.addedBetas.length
        ? `+${changes.addedBetas.join(',')}`
        : ''
      const removed = changes.removedBetas.length
        ? `-${changes.removedBetas.join(',')}`
        : ''
      const diff = [added, removed].filter(Boolean).join(' ')
      parts.push(`betas changed${diff ? ` (${diff})` : ''}`)
    }
    if (changes.autoModeChanged) {
      parts.push('auto mode toggled')
    }
    if (changes.overageChanged) {
      parts.push('overage state changed (TTL latched, no flip)')
    }
    if (changes.effortChanged) {
      parts.push(
        `effort changed (${changes.prevEffortValue || 'default'} → ${changes.newEffortValue || 'default'})`,
      )
    }
    if (changes.extraBodyChanged) {
      parts.push('extra body params changed')
    }
  }

  const lastAssistantMsgOver5minAgo =
    timeSinceLastAssistantMsg !== null &&
    timeSinceLastAssistantMsg > CACHE_TTL_5MIN_MS
  const lastAssistantMsgOver1hAgo =
    timeSinceLastAssistantMsg !== null &&
    timeSinceLastAssistantMsg > CACHE_TTL_1HOUR_MS

  // A server-side context_management edit is the one server cause we CAN
  // see: the response says how much it cleared. Under the retain profile
  // that is the expected clear_tool_uses trigger, not a regression.
  if (serverEdit) {
    const tokensK = Math.round(serverEdit.clearedInputTokens / 1000)
    const base = `server clear_tool_uses (cleared ${serverEdit.clearedToolUses} tool uses, -${tokensK}k tokens, expected)`
    return parts.length > 0 ? `${base}, also: ${parts.join(', ')}` : base
  }
  // A byte changing inside the message history is a client-side rewrite
  // regardless of what the system/tools hashes say — name the message so
  // the mechanism can be found, instead of falling through to "server-side".
  if (messageMutation) {
    parts.push(
      `messages mutated at ${messageMutation.index}/${messageMutation.total} (${messageMutation.role}: ${messageMutation.blockTypes}) — client-side prefix rewrite`,
    )
  }
  // Every hash unchanged and the marker moved past the lookback window: the
  // server could not find the previous write from the new breakpoint. With
  // the lag marker placed that path is covered, so a collapse there is a
  // genuine server miss — say which.
  if (
    parts.length === 0 &&
    markerAdvance &&
    markerAdvance.positions >= LOOKBACK_POSITIONS
  ) {
    parts.push(
      markerAdvance.lagPlaced
        ? `marker advanced ${markerAdvance.positions} positions past the last write with the lag marker placed — server-side miss`
        : `marker advanced ${markerAdvance.positions} positions past the last write (lookback window is ${LOOKBACK_POSITIONS}) — client-side placement`,
    )
  }
  if (parts.length > 0) return parts.join(', ')
  if (lastAssistantMsgOver1hAgo) return 'possible 1h TTL expiry (prompt unchanged)'
  if (lastAssistantMsgOver5minAgo) return 'possible 5min TTL expiry (prompt unchanged)'
  if (timeSinceLastAssistantMsg !== null) {
    return 'likely server-side (prompt unchanged, <5min gap)'
  }
  return 'unknown cause'
}

/**
 * Phase 2 (post-call): Check the API response's cache tokens to determine
 * if a cache break actually occurred. If it did, use the pending changes
 * from phase 1 to explain why.
 */
export async function checkResponseForCacheBreak(
  querySource: QuerySource,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: AgentId,
  requestId?: string | null,
  contextManagement?: BetaContextManagementResponse | null,
  serverMissReason?: ServerCacheMissReason | null,
  thinkingDropPaths: readonly string[] = [],
): Promise<void> {
  try {
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    const state = previousStateBySource.get(key)
    if (!state) return

    // Logged whether or not the client-side threshold below calls it a
    // break: a small miss the heuristic ignores is still the server's answer.
    if (serverMissReason) {
      logForDebugging(
        `[PROMPT CACHE] ${describeServerCacheMissReason(serverMissReason)} [source=${querySource}]`,
      )
    }
    const newThinkingDrops = thinkingDropPaths.filter(
      p => !state.thinkingDropPaths.has(p),
    )
    state.thinkingDropPaths = new Set(thinkingDropPaths)
    if (newThinkingDrops.length > 0) {
      logForDebugging(
        `[PROMPT CACHE] ${describeThinkingDrops(newThinkingDrops)} [source=${querySource}]`,
      )
    }

    // Skip excluded models (e.g., haiku has different caching behavior)
    if (isExcludedModel(state.model)) return

    const prevCacheRead = state.prevCacheReadTokens
    state.prevCacheReadTokens = cacheReadTokens

    // Calculate time since last call for TTL detection by finding the most recent
    // assistant message timestamp in the messages array (before the current response)
    const lastAssistantMessage = messages.findLast(m => m.type === 'assistant')
    const timeSinceLastAssistantMsg = lastAssistantMessage
      ? Date.now() - new Date(lastAssistantMessage.timestamp).getTime()
      : null

    // Skip the first call — no previous value to compare against
    if (prevCacheRead === null) return

    const changes = state.pendingChanges
    const messageMutation = state.pendingMessageMutation
    state.pendingMessageMutation = null
    const markerAdvance = state.pendingMarkerAdvance
    state.pendingMarkerAdvance = null

    // Cache deletions via cached microcompact intentionally reduce the cached
    // prefix. The drop in cache read tokens is expected — reset the baseline
    // so we don't false-positive on the next call.
    if (state.cacheDeletionsPending) {
      state.cacheDeletionsPending = false
      const why = state.cacheDeletionReason ?? 'client-side clip/eviction'
      state.cacheDeletionReason = null
      logForDebugging(
        `[PROMPT CACHE] expected drop: ${why}, cache read: ${prevCacheRead} → ${cacheReadTokens}, creation: ${cacheCreationTokens}`,
      )
      // Don't flag as a break — the remaining state is still valid
      state.pendingChanges = null
      return
    }

    // Detect a cache break: cache read dropped >5% from previous AND
    // the absolute drop exceeds the minimum threshold.
    const tokenDrop = prevCacheRead - cacheReadTokens
    if (
      cacheReadTokens >= prevCacheRead * 0.95 ||
      tokenDrop < MIN_CACHE_MISS_TOKENS
    ) {
      state.pendingChanges = null
      return
    }

    // Check if time gap suggests TTL expiration
    const lastAssistantMsgOver5minAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_5MIN_MS
    const lastAssistantMsgOver1hAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_1HOUR_MS

    const serverEdit = summarizeAppliedContextEdits(contextManagement)
    const clientReason = buildCacheBreakReason(
      changes,
      serverEdit,
      timeSinceLastAssistantMsg,
      messageMutation,
      markerAdvance,
    )
    // The server's own account leads — its diagnosis when the request asked
    // for one, and the thinking it dropped: the causes here that are not an
    // inference.
    const serverParts = [
      ...(serverMissReason ? [describeServerCacheMissReason(serverMissReason)] : []),
      ...(newThinkingDrops.length > 0 ? [describeThinkingDrops(newThinkingDrops)] : []),
    ]
    const reason =
      serverParts.length > 0
        ? `${serverParts.join('; ')}; ${clientReason}`
        : clientReason
    // The `[Cache: …]` line is persisted to the transcript, so this is the
    // record that survives a session without `--debug`.
    recordCacheBreak(
      `${reason} — read ${formatCompactNumber(prevCacheRead)}→${formatCompactNumber(cacheReadTokens)}, rewrote ${formatCompactNumber(cacheCreationTokens)}`,
    )


    // Write diff file for ant debugging via --debug. The path is included in
    // the summary log so ants can find it (DevBar UI removed — event data
    // flows reliably to BQ for analytics).
    let diffPath: string | undefined
    if (changes?.buildPrevDiffableContent) {
      diffPath = await writeCacheBreakDiff(
        changes.buildPrevDiffableContent(),
        state.buildDiffableContent(),
      )
    } else if (messageMutation) {
      // Nothing in system/tools moved: diff the one message that did.
      diffPath = await writeCacheBreakDiff(
        messageMutation.prevJson,
        messageMutation.newJson,
        `messages[${messageMutation.index}]`,
      )
    }

    const diffSuffix = diffPath ? `, diff: ${diffPath}` : ''
    const dumpStem = await writeWireBodyDump(key, {
      at: new Date().toISOString(),
      querySource,
      requestId: requestId ?? null,
      reason,
      prevCacheRead,
      cacheRead: cacheReadTokens,
      cacheCreation: cacheCreationTokens,
      gapMs: timeSinceLastAssistantMsg,
    })
    const dumpSuffix = dumpStem ? `, bodies: ${dumpStem}.{prev,cur}.json.gz` : ''
    const summary = `[PROMPT CACHE BREAK] ${reason} [source=${querySource}, call #${state.callCount}, cache read: ${prevCacheRead} → ${cacheReadTokens}, creation: ${cacheCreationTokens}${diffSuffix}${dumpSuffix}]`

    logForDebugging(summary, { level: 'warn' })

    state.pendingChanges = null
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * Call when a compaction step legitimately reduces the cached prefix.
 * The next API response will have lower cache read tokens — that's
 * expected, not a cache break. `reason` names the mechanism (display-cap
 * eviction, stable-stub clip, byte-guard, …) so the debug line can
 * attribute the rewrite instead of logging an anonymous "expected drop".
 */
export function notifyCacheDeletion(
  querySource: QuerySource,
  agentId?: AgentId,
  reason?: string,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.cacheDeletionsPending = true
    if (reason) {
      state.cacheDeletionReason = state.cacheDeletionReason
        ? `${state.cacheDeletionReason} + ${reason}`
        : reason
    }
  }
}

/**
 * Call after compaction to reset the cache read baseline.
 * Compaction legitimately reduces message count, so cache read tokens
 * will naturally drop on the next call — that's not a break.
 */
export function notifyCompaction(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    state.prevCacheReadTokens = null
  }
}

export function cleanupAgentTracking(agentId: AgentId): void {
  previousStateBySource.delete(agentId)
  wireBodies.delete(agentId)
}

export function resetPromptCacheBreakDetection(): void {
  previousStateBySource.clear()
  wireBodies.clear()
}

export function _getSourceCountForTesting(): number {
  return previousStateBySource.size
}

// ---------------------------------------------------------------------------
// Break flight recorder — CLAUDIN_CACHE_BREAK_DUMP, off by default.
//
// The detector compares what the CLIENT rendered. A rewrite the server calls
// `messages changed` while every client hash matched cannot be explained from
// here: the 2026-09-26..28 census found them on the first request after a
// long turn (a third of turns past 100 calls), with the prompt SHRINKING.
// With the switch on, the last two wire bodies of each tracked key are kept as
// the JSON that was sent, and every detected break writes both, gzipped, with
// a line in `index.jsonl` — the pair a byte diff or a replay needs.
//
//   CLAUDIN_CACHE_BREAK_DUMP=1      <claude temp>/cache-break-dumps/
//   CLAUDIN_CACHE_BREAK_DUMP=<dir>  that directory
//
// Costs one serialization of the body per request while on. The files hold
// the whole conversation, so they are written owner-only.
// ---------------------------------------------------------------------------

const wireBodies = new Map<string, { previous: string | null; current: string }>()

function cacheBreakDumpDir(): string | null {
  const value = process.env.CLAUDIN_CACHE_BREAK_DUMP
  if (!value || isEnvDefinedFalsy(value)) return null
  return isEnvTruthy(value) ? join(getClaudeTempDir(), 'cache-break-dumps') : value
}

/** Pre-call, with the exact params about to be sent. */
export function recordWireBody(
  querySource: QuerySource,
  agentId: AgentId | undefined,
  body: unknown,
): void {
  if (cacheBreakDumpDir() === null) return
  try {
    const key = getTrackingKey(querySource, agentId)
    if (!key) return
    const json = jsonStringify(body)
    const held = wireBodies.get(key)
    // A retry re-sends the same body; rotating would lose the previous one.
    if (held?.current === json) return
    wireBodies.delete(key)
    while (wireBodies.size >= MAX_TRACKED_SOURCES) {
      const oldest = wireBodies.keys().next().value
      if (oldest === undefined) break
      wireBodies.delete(oldest)
    }
    wireBodies.set(key, { previous: held?.current ?? null, current: json })
  } catch (e: unknown) {
    logError(e)
  }
}

async function writeWireBodyDump(
  key: string,
  entry: Record<string, unknown>,
): Promise<string | undefined> {
  const dir = cacheBreakDumpDir()
  const bodies = wireBodies.get(key)
  if (dir === null || !bodies?.previous) return undefined
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const stem = join(dir, `${stamp}-${key.replace(/[^\w.-]/g, '_')}`)
    const prev = `${stem}.prev.json.gz`
    const cur = `${stem}.cur.json.gz`
    await writeFile(prev, gzipSync(bodies.previous), { mode: 0o600 })
    await writeFile(cur, gzipSync(bodies.current), { mode: 0o600 })
    await appendFile(
      join(dir, 'index.jsonl'),
      `${jsonStringify({ ...entry, key, prev, cur })}\n`,
      { mode: 0o600 },
    )
    return stem
  } catch (e: unknown) {
    logError(e)
    return undefined
  }
}

export function _getWireBodiesForTesting(
  querySource: QuerySource,
  agentId?: AgentId,
): { previous: string | null; current: string } | undefined {
  const key = getTrackingKey(querySource, agentId)
  return key ? wireBodies.get(key) : undefined
}

async function writeCacheBreakDiff(
  prevContent: string,
  newContent: string,
  fileName = 'prompt-state',
): Promise<string | undefined> {
  try {
    const diffPath = getCacheBreakDiffPath()
    await mkdir(getClaudeTempDir(), { recursive: true })
    const patch = createPatch(
      fileName,
      prevContent,
      newContent,
      'before',
      'after',
    )
    await writeFile(diffPath, patch)
    return diffPath
  } catch {
    return undefined
  }
}
