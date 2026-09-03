import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { SHELL_TOOL_NAMES } from 'src/platform/shell/shellToolUtils.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { getCacheProfile } from 'src/agent/cache/cacheProfile.js'

// docs: https://docs.google.com/document/d/1oCT4evvWTh3P6z-kcfNQwWTCxAhkoFndSaNS9Gm40uw/edit?tab=t.0

// Default values for context management strategies
// Match client-side microcompact token values
const DEFAULT_MAX_INPUT_TOKENS = 180_000 // Typical warning threshold
const DEFAULT_TARGET_INPUT_TOKENS = 40_000 // Keep last 40k tokens like client-side

/**
 * Fallback `clear_tool_inputs` list, used only when the caller doesn't hand
 * over the pool-derived list. The live list comes from
 * `clearableToolNamesFromPool` — tools opt in with `clearableResult: true`
 * (`src/tools/Tool.ts`) so a new tool can't be forgotten here. This constant
 * mirrors the pre-flag set so the shim paths that don't build a pool keep
 * their previous behavior.
 */
export const TOOLS_CLEARABLE_RESULTS = [
  ...SHELL_TOOL_NAMES,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
]

/**
 * Derive the `clear_tool_inputs` list from the tools actually in the pool.
 * Sorted so the list is byte-stable across requests regardless of pool
 * order (context_management is not part of the cached prefix, but a
 * stable body keeps request diffs readable).
 */
export function clearableToolNamesFromPool(
  tools: ReadonlyArray<{ name: string; clearableResult?: boolean }>,
): string[] {
  return tools
    .filter(t => t.clearableResult === true)
    .map(t => t.name)
    .sort()
}

const TOOLS_CLEARABLE_USES = [
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  APPLY_PATCH_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]

// Context management strategy types matching API documentation
export type ContextEditStrategy =
  | {
      type: 'clear_tool_uses_20250919'
      trigger?: {
        type: 'input_tokens'
        value: number
      }
      keep?: {
        type: 'tool_uses'
        value: number
      }
      clear_tool_inputs?: boolean | string[]
      exclude_tools?: string[]
      clear_at_least?: {
        type: 'input_tokens'
        value: number
      }
    }
  | {
      type: 'clear_thinking_20251015'
      keep: { type: 'thinking_turns'; value: number } | 'all'
    }

// Context management configuration wrapper
export type ContextManagementConfig = {
  edits: ContextEditStrategy[]
}

// API-based microcompact implementation that uses native context management
export function getAPIContextManagement(options?: {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
  clearAllThinking?: boolean
  /** Pool-derived `clear_tool_inputs` list; falls back to TOOLS_CLEARABLE_RESULTS. */
  clearableToolNames?: string[]
}): ContextManagementConfig | undefined {
  const {
    hasThinking = false,
    isRedactThinkingActive = false,
    clearAllThinking = false,
    clearableToolNames,
  } = options ?? {}

  const strategies: ContextEditStrategy[] = []
  const profile = getCacheProfile()

  // Preserve thinking blocks in previous assistant turns. Skip when
  // redact-thinking is active — redacted blocks have no model-visible content.
  // When clearAllThinking is set (>1h idle = cache miss), keep only the last
  // thinking turn — the API schema requires value >= 1, and omitting the edit
  // falls back to the model-policy default (often "all"), which wouldn't clear.
  //
  // Profile-gated like the client-side strips (historyRedactionEnabled):
  // clear_thinking is history redaction running SERVER-side, with the same
  // keep-window pathology — every new thinking turn rotates the window,
  // mutates the effective prompt deep inside the cached prefix and forces a
  // full re-cache (measured: a 61k re-write + TTL-bucket flip the moment the
  // model thought again mid-session). Under retain, old thinking is
  // byte-stable and reads at 0.1×; clearing it is a strictly losing trade.
  // Exception: clearAllThinking fires on >1h idle when the cache is already
  // expired — that clear is free, keep it even under retain.
  if (
    hasThinking &&
    !isRedactThinkingActive &&
    (profile.historyRedactionEnabled || clearAllThinking)
  ) {
    strategies.push({
      type: 'clear_thinking_20251015',
      // value:2 — keep last two thinking turns to preserve immediate reasoning
      // context while preventing unbounded accumulation across long sessions.
      keep: clearAllThinking
        ? { type: 'thinking_turns', value: 1 }
        : { type: 'thinking_turns', value: 2 },
    })
  }

  // Server-side tool clearing: env opt-in (any profile) or automatic under
  // the retain profile. Under retain the client never age-clips, so the only
  // context relief left near the window ceiling was the client microcompact
  // at estimated 75% — and token-estimate drift made it fire too late
  // (autocompact hit first in the bench). The server triggers on REAL input
  // token counts, clears by exact budget, and costs one bounded cache break —
  // strictly better than wipe-plus-re-reads. First-party only (the beta
  // header is already gated by shouldIncludeFirstPartyOnlyBetas upstream).
  const useClearToolResults =
    isEnvTruthy(process.env.USE_API_CLEAR_TOOL_RESULTS) ||
    profile.serverToolClearEnabled
  const useClearToolUses = isEnvTruthy(process.env.USE_API_CLEAR_TOOL_USES)

  // If no tool clearing strategy is enabled, return early
  if (!useClearToolResults && !useClearToolUses) {
    return strategies.length > 0 ? { edits: strategies } : undefined
  }

  if (useClearToolResults) {
    // Retain profile: the server trigger is the reliable near-ceiling
    // backstop — it fires on REAL input tokens, while the client microcompact
    // (0.75 of estimated window) and autocompact (~92% of effective window)
    // both run on drift-prone estimates. 140k sits safely below both for a
    // 200k window, and keeps a 60k working set. Env overrides win.
    const profileTrigger = profile.serverToolClearEnabled
      ? 140_000
      : DEFAULT_MAX_INPUT_TOKENS
    const profileTarget = profile.serverToolClearEnabled
      ? 60_000
      : DEFAULT_TARGET_INPUT_TOKENS
    const triggerThreshold = process.env.API_MAX_INPUT_TOKENS
      ? parseInt(process.env.API_MAX_INPUT_TOKENS)
      : profileTrigger
    const keepTarget = process.env.API_TARGET_INPUT_TOKENS
      ? parseInt(process.env.API_TARGET_INPUT_TOKENS)
      : profileTarget

    const strategy: ContextEditStrategy = {
      type: 'clear_tool_uses_20250919',
      trigger: {
        type: 'input_tokens',
        value: triggerThreshold,
      },
      clear_at_least: {
        type: 'input_tokens',
        value: triggerThreshold - keepTarget,
      },
      clear_tool_inputs:
        clearableToolNames && clearableToolNames.length > 0
          ? clearableToolNames
          : TOOLS_CLEARABLE_RESULTS,
    }

    strategies.push(strategy)
  }

  if (useClearToolUses) {
    const triggerThreshold = process.env.API_MAX_INPUT_TOKENS
      ? parseInt(process.env.API_MAX_INPUT_TOKENS)
      : DEFAULT_MAX_INPUT_TOKENS
    const keepTarget = process.env.API_TARGET_INPUT_TOKENS
      ? parseInt(process.env.API_TARGET_INPUT_TOKENS)
      : DEFAULT_TARGET_INPUT_TOKENS

    const strategy: ContextEditStrategy = {
      type: 'clear_tool_uses_20250919',
      trigger: {
        type: 'input_tokens',
        value: triggerThreshold,
      },
      clear_at_least: {
        type: 'input_tokens',
        value: triggerThreshold - keepTarget,
      },
      exclude_tools: TOOLS_CLEARABLE_USES,
    }

    strategies.push(strategy)
  }

  return strategies.length > 0 ? { edits: strategies } : undefined
}
