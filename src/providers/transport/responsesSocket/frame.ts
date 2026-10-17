/**
 * Whether a Responses request can go over an open socket as a delta, the way
 * Codex CLI's `get_incremental_items` decides it (codex-rs/core/src/client.rs).
 *
 * With `store: false` the server keeps only the last response, in the
 * connection's own cache, so a frame may name it as `previous_response_id`
 * and send just the items after it. That holds only when nothing else
 * changed: every body field outside `input` is the same, the new input starts
 * with the previous request's input, and the next items are the previous
 * response's output, in order. Claudin's history is not append-only (stubs,
 * clips, compaction rewrite older items), so the check runs on every request
 * and anything else goes out as a full frame.
 *
 * The chain keeps the FULL input as Claudin rendered it, never the delta that
 * went on the wire: a later change to an old item then breaks the chain on the
 * next request instead of drifting from the server's copy unnoticed.
 */
import { stableStringify } from 'src/shared/data/stableStringify.js'

export type ResponsesChain = {
  settingsKey: string
  inputKeys: string[]
  responseId: string
  outputIds: string[]
}

type FrameReason =
  | 'incremental'
  | 'no-chain'
  | 'settings-changed'
  | 'input-rewritten'
  | 'output-mismatch'
  | 'nothing-new'

export type FramePlan = {
  frame: Record<string, unknown>
  incremental: boolean
  reason: FrameReason
  settingsKey: string
  inputKeys: string[]
}

type Item = { id?: unknown }

function settingsKeyOf(body: Record<string, unknown>): string {
  const { input: _input, ...settings } = body
  return stableStringify(settings)
}

function full(body: Record<string, unknown>, reason: FrameReason, settingsKey: string, inputKeys: string[]): FramePlan {
  return { frame: { type: 'response.create', ...body }, incremental: false, reason, settingsKey, inputKeys }
}

export function planResponseFrame(chain: ResponsesChain | undefined, body: Record<string, unknown>): FramePlan {
  const input = Array.isArray(body.input) ? (body.input as Item[]) : []
  const settingsKey = settingsKeyOf(body)
  const inputKeys = input.map(item => stableStringify(item))
  if (!chain) return full(body, 'no-chain', settingsKey, inputKeys)
  if (settingsKey !== chain.settingsKey) return full(body, 'settings-changed', settingsKey, inputKeys)

  const prefix = chain.inputKeys.length
  if (inputKeys.length < prefix || chain.inputKeys.some((key, i) => key !== inputKeys[i])) {
    return full(body, 'input-rewritten', settingsKey, inputKeys)
  }
  if (chain.outputIds.some((id, j) => input[prefix + j]?.id !== id)) {
    return full(body, 'output-mismatch', settingsKey, inputKeys)
  }
  const delta = input.slice(prefix + chain.outputIds.length)
  if (delta.length === 0) return full(body, 'nothing-new', settingsKey, inputKeys)
  return {
    frame: { type: 'response.create', ...body, previous_response_id: chain.responseId, input: delta },
    incremental: true,
    reason: 'incremental',
    settingsKey,
    inputKeys,
  }
}

/**
 * The chain a completed response leaves on its socket, or undefined when the
 * next request could not be checked against it: no response id, or an output
 * item without an id.
 */
export function nextChain(plan: FramePlan, response: Record<string, unknown> | undefined): ResponsesChain | undefined {
  const responseId = response?.id
  if (typeof responseId !== 'string') return undefined
  const output = Array.isArray(response?.output) ? (response.output as Item[]) : []
  const outputIds: string[] = []
  for (const item of output) {
    if (typeof item?.id !== 'string') return undefined
    outputIds.push(item.id)
  }
  return { settingsKey: plan.settingsKey, inputKeys: plan.inputKeys, responseId, outputIds }
}
