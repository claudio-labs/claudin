import { feature } from 'bun:bundle'
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from 'src/shared/constants/xml.js'
import { isCoordinatorMode } from 'src/agent/coordinator/coordinatorMode.js'
import type {
  AssistantMessage,
  Message as MessageType,
} from 'src/shared/types/message.js'
import { logForDebugging } from 'src/shared/debug.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import {
  buildClipStub,
  buildClipStubWithHead,
  isClipStubContent,
} from 'src/agent/compact/stableStubState.js'
import {
  WORKTREE_STASH_WARNING,
  WORKTREE_WRITE_SCOPE_NOTE,
} from 'src/shared/constants/worktreeSafety.js'
import type { BuiltInAgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

/**
 * Fork subagent feature gate.
 *
 * When enabled:
 * - `subagent_type` becomes optional on the Agent tool schema
 * - Omitting `subagent_type` triggers an implicit fork: the child inherits
 *   the parent's full conversation context and system prompt
 * - Fork does NOT force async — spawns run inline unless run_in_background or
 *   the auto-background toggle routes them to the background
 * - `/fork <directive>` slash command is available
 *
 * Mutually exclusive with coordinator mode — coordinator already owns the
 * orchestration role and has its own delegation model.
 *
 * Independent of `autoBackgroundAgentsEnabled`. Fork is about *context
 * inheritance* (the child sees the parent's conversation and shares its prompt
 * cache); backgrounding is about *when the report arrives*. Gating fork on the
 * background toggle made "stop backgrounding my agents" also mean "lose context
 * inheritance" — the two are split so the toggle only moves execution mode.
 */
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false
    // No config read: this getter runs at tool-schema build time (Agent
    // inputSchema), before enableConfigs() unlocks config reads.
    return true
  }
  return false
}

/** Synthetic agent type name used for analytics when the fork path fires. */
export const FORK_SUBAGENT_TYPE = 'fork'

/**
 * Synthetic agent definition for the fork path.
 *
 * Not registered in builtInAgents — used only when `!subagent_type` and the
 * experiment is active. `tools: ['*']` with `useExactTools` means the fork
 * child receives the parent's exact tool pool (for cache-identical API
 * prefixes). `permissionMode: 'bubble'` surfaces permission prompts to the
 * parent terminal. `model: 'inherit'` keeps the parent's model for context
 * length parity.
 *
 * The getSystemPrompt here is unused: the fork path passes
 * `override.systemPrompt` with the parent's already-rendered system prompt
 * bytes, threaded via `toolUseContext.renderedSystemPrompt`. Reconstructing
 * by re-calling getSystemPrompt() can diverge (GrowthBook cold→warm) and
 * bust the prompt cache; threading the rendered bytes is byte-exact.
 */
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  whenToUse:
    'Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type when the fork experiment is active.',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
} satisfies BuiltInAgentDefinition

/**
 * Guard against recursive forking. Fork children keep the Agent tool in their
 * tool pool for cache-identical tool definitions, so we reject fork attempts
 * at call time by detecting the fork boilerplate tag in conversation history.
 */
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}

/** Placeholder text used for all tool_result blocks in the fork prefix.
 * Must be identical across all fork children for prompt cache sharing. */
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

/**
 * Build the forked conversation messages for the child agent.
 *
 * For prompt cache sharing, all fork children must produce byte-identical
 * API request prefixes. This function:
 * 1. Keeps the full parent assistant message (all tool_use blocks, thinking, text)
 * 2. Builds a single user message with tool_results for every tool_use block
 *    using an identical placeholder, then appends a per-child directive text block
 *
 * Result: [...history, assistant(all_tool_uses), user(placeholder_results..., directive)]
 * Only the final text block differs per child, maximizing cache hits.
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // Clone the assistant message to avoid mutating the original, keeping all
  // content blocks (thinking, text, and every tool_use)
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content],
    },
  }

  // Collect all tool_use blocks from the assistant message
  const toolUseBlocks = assistantMessage.message.content.filter(
    (block): block is BetaToolUseBlock => block.type === 'tool_use',
  )

  if (toolUseBlocks.length === 0) {
    logForDebugging(
      `No tool_use blocks found in assistant message for fork directive: ${directive.slice(0, 50)}...`,
      { level: 'error' },
    )
    return [
      createUserMessage({
        content: [
          { type: 'text' as const, text: buildChildMessage(directive) },
        ],
      }),
    ]
  }

  // Build tool_result blocks for every tool_use, all with identical placeholder text
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: [
      {
        type: 'text' as const,
        text: FORK_PLACEHOLDER_RESULT,
      },
    ],
  }))

  // Build a single user message: all placeholder tool_results + the per-child directive
  // TODO(smoosh): this text sibling creates a [tool_result, text] pattern on the wire
  // (renders as </function_results>\n\nHuman:<text>). One-off per-child construction,
  // not a repeated teacher, so low-priority. If we ever care, use smooshIntoToolResult
  // from src/agent/messages/messages.ts to fold the directive into the last tool_result.content.
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      {
        type: 'text' as const,
        text: buildChildMessage(directive),
      },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}

export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT \u2014 that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * Notice injected into FORK children running in an isolated worktree.
 * Tells the child to translate paths from the inherited context, re-read
 * potentially stale files, and what isolation does and does not cover.
 * A named sub-agent has no inherited context to translate — it gets
 * `buildAgentWorktreeNotice` instead.
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. ${WORKTREE_WRITE_SCOPE_NOTE} ${WORKTREE_STASH_WARNING}`
}

/**
 * Notice injected into NAMED sub-agents running in an isolated worktree.
 *
 * Same isolation facts minus the context translation, which only a fork needs.
 * Before this existed, an `isolation:"worktree"` agent that was not a fork got
 * no worktree guidance at all: the env block a sub-agent renders
 * (`computeEnvInfo`) has no worktree branch, and the main session's worktree
 * lines hang off a process-global that only EnterWorktree sets.
 */
export function buildAgentWorktreeNotice(worktreeCwd: string): string {
  return `You are operating in an isolated git worktree at ${worktreeCwd} — same repository as the parent, same relative file structure, separate working copy. Run all commands from this directory. ${WORKTREE_WRITE_SCOPE_NOTE} ${WORKTREE_STASH_WARNING}`
}

/**
 * Fork history clipping — EXPERIMENT, OFF by default.
 *
 * `CLAUDIN_FORK_CLIP_HISTORY=1` makes a fork child inherit the parent's
 * history with the old, clearable tool_results already rewritten to the
 * stable clip stubs (`stableStubState.ts`), instead of the full bytes. The
 * child's prefix then diverges from the parent's at the first clipped result:
 * system, tools and the early turns are still shared, everything after is a
 * one-time write of the smaller history.
 *
 * Why it is off: the 2026-09-04..08 census put forks at 156k average
 * inherited context and $22 of cache reads for the week, but a 1h cache write
 * costs 20× (Opus 5) to 80× (Fable 5.1) a cache read, so the clip only pays
 * once the child makes ~20 (Opus) / ~80 (Fable) calls — census forks ran
 * 5–51. `scripts/bench/ab/fork-clip-ab.ts` measures total (parent + child)
 * cost per arm. Measured 2026-09-09 (Sonnet 5, N=3, parent ≈204k, child 11
 * calls): the clip landed (child first request 122k vs 204k) and answers
 * stayed correct, but total cost ROSE $1.46 → $1.62 (+11%, ranges disjoint)
 * — the ~90k diverged-prefix write outweighed ten turns of cheaper reads.
 * The flag stays as bench instrumentation; re-run the A/B before promoting
 * if fork call counts or cache prices change.
 *
 * The rewrite happens on the child's OWN message array (a copy built by
 * runAgent), never through the clipped-id registry: that registry is keyed on
 * the session for a plain sub-agent (`stableStubState.ts::currentKey` only
 * adds a teammate id), so `addClippedIds` from the child would clip the
 * PARENT's next wire render too — a prefix rewrite the parent pays for, the
 * exact invariant cache.md §1 forbids. Rewriting the child's copy leaves the
 * parent's array, cache entry and registries untouched.
 *
 * Thresholds: `CLAUDIN_FORK_CLIP_MIN_PARENT_TOKENS` (default 100k — below it
 * the shared prefix is worth more than the clip) and
 * `CLAUDIN_FORK_CLIP_KEEP_TURNS` (default 4 — the newest turns are what the
 * directive usually refers to).
 */
const FORK_CLIP_DEFAULT_MIN_PARENT_TOKENS = 100_000
const FORK_CLIP_DEFAULT_KEEP_TURNS = 4
// Mirrors stableStubState's private MIN_STUB_TOKENS / HEAD_STUB_MIN_SAVINGS_CHARS:
// a stub only replaces content when it saves something, and the head form only
// when it meaningfully truncates. Same numbers so the child's stubs take the
// same shape the wire path would have produced for the same content.
const FORK_CLIP_MIN_TOKENS = 100
const FORK_CLIP_HEAD_MIN_SAVINGS_CHARS = 500

export function isForkClipHistoryEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_FORK_CLIP_HISTORY)
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

export function forkClipMinParentTokens(): number {
  return positiveIntEnv(
    'CLAUDIN_FORK_CLIP_MIN_PARENT_TOKENS',
    FORK_CLIP_DEFAULT_MIN_PARENT_TOKENS,
  )
}

export function forkClipKeepTurns(): number {
  return positiveIntEnv(
    'CLAUDIN_FORK_CLIP_KEEP_TURNS',
    FORK_CLIP_DEFAULT_KEEP_TURNS,
  )
}

type ForkClipToolResult = {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

function isToolResultBlock(block: unknown): block is ForkClipToolResult {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'tool_result' &&
    typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
  )
}

/** Index of the first message inside the protected window: the message
 * holding the `keepTurns`-th assistant turn from the end. Everything before
 * it is old enough to clip. 0 when the history is shorter than the window. */
function forkClipCutoffIndex(
  messages: readonly MessageType[],
  keepTurns: number,
): number {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.type !== 'assistant') continue
    seen++
    if (seen >= keepTurns) return i
  }
  return 0
}

function toolResultTokens(content: unknown): number {
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const item of content as Array<{ type?: string; text?: string }>) {
    if (item && item.type === 'text' && typeof item.text === 'string') {
      total += roughTokenCountEstimation(item.text)
    }
  }
  return total
}

function containsImage(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      item =>
        item && typeof item === 'object' && (item as { type?: string }).type === 'image',
    )
  )
}

/**
 * Pure: which tool_results in the inherited history a fork child should
 * receive as stubs. Oldest first; only results older than the last
 * `keepTurns` assistant turns, from tools `isClearableTool` accepts, that are
 * non-empty, not errors, not image-bearing, not already stubs and worth at
 * least `FORK_CLIP_MIN_TOKENS`.
 */
export function selectForkClipIds(
  messages: readonly MessageType[],
  keepTurns: number,
  isClearableTool: (toolName: string) => boolean,
): string[] {
  const cutoff = forkClipCutoffIndex(messages, keepTurns)
  if (cutoff <= 0) return []
  const toolNames = new Map<string, string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name)
    }
  }
  const ids: string[] = []
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i]!
    if (msg.type !== 'user') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isToolResultBlock(block)) continue
      const existing = block.content
      if (existing == null || existing === '') continue
      if (Array.isArray(existing) && existing.length === 0) continue
      if (typeof existing === 'string' && isClipStubContent(existing)) continue
      if (block.is_error) continue
      if (containsImage(existing)) continue
      if (!isClearableTool(toolNames.get(block.tool_use_id) ?? '')) continue
      if (toolResultTokens(existing) < FORK_CLIP_MIN_TOKENS) continue
      ids.push(block.tool_use_id)
    }
  }
  return ids
}

/**
 * Pure: the inherited history with the selected tool_results rewritten to
 * clip stubs (head-preserving when `stubKeepHeadChars` > 0 and the content
 * is long enough, pure otherwise — same shapes as the wire path). Every
 * touched message and block is a NEW object; untouched ones keep their
 * identity, and the input array is never mutated.
 */
export function clipForkHistory(
  messages: readonly MessageType[],
  ids: ReadonlySet<string>,
  stubKeepHeadChars: number,
): MessageType[] {
  if (ids.size === 0) return [...messages]
  const toolNames = new Map<string, string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name)
    }
  }
  return messages.map(msg => {
    if (msg.type !== 'user') return msg
    const content = msg.message.content
    if (!Array.isArray(content)) return msg
    let touched = false
    const newContent = content.map(block => {
      if (!isToolResultBlock(block) || !ids.has(block.tool_use_id)) return block
      const existing = block.content
      const toolName = toolNames.get(block.tool_use_id) ?? 'tool'
      const tokens = toolResultTokens(existing)
      const stub =
        stubKeepHeadChars > 0 &&
        typeof existing === 'string' &&
        existing.length > stubKeepHeadChars + FORK_CLIP_HEAD_MIN_SAVINGS_CHARS
          ? buildClipStubWithHead(
              toolName,
              tokens,
              existing.slice(0, stubKeepHeadChars),
            )
          : buildClipStub(toolName, tokens)
      touched = true
      return { ...block, content: stub }
    })
    if (!touched) return msg
    return {
      ...msg,
      message: { ...msg.message, content: newContent },
    } as MessageType
  })
}
