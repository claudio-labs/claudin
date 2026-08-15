/**
 * Capability probe for auto mode on non-Claude providers.
 *
 * The auto-mode classifier (yoloClassifier.ts) hard-requires the model to honor
 * forced tool-choice (`tool_choice: {type:'tool'}`) and return a well-formed
 * `tool_use` block — Claude does; non-Claude providers reach the API through
 * the openaiShim translation layer, where that round-trip is unvalidated.
 * This probe tests exactly that requirement, on the main-loop model (the same
 * model the classifier uses at runtime), and persists the result so the
 * auto-mode gate can stay synchronous.
 *
 * It sends the classifier's REAL tool schema (YOLO_CLASSIFIER_TOOL_SCHEMA) and
 * forced tool_choice, not a stripped-down probe tool — a provider that chokes
 * on the classifier's actual (multi-field, string+boolean) schema must fail the
 * probe, not pass a trivial one-field stand-in and then break at runtime.
 *
 * Deliberately format-only: it does NOT judge the classifier's decisions —
 * a provider that returns a well-formed block passes. With GrowthBook stubbed,
 * `tengu_iron_gate_closed` defaults to fail-CLOSED in auto mode, so letting an
 * incapable provider in would deny-loop the session, not just annoy.
 */

import { isAbortError } from 'src/utils/errors.js'
import { logError } from 'src/utils/log.js'
import { sideQuery } from 'src/utils/sideQuery.js'
import { extractToolUseBlock } from 'src/services/permissions/classifierShared.js'
import {
  classifierProbeKey,
  readClassifierProbe,
  writeClassifierProbe,
  type ClassifierProbeEntry,
} from 'src/services/permissions/classifierProbeStore.js'
import {
  YOLO_CLASSIFIER_TOOL_NAME,
  YOLO_CLASSIFIER_TOOL_SCHEMA,
} from 'src/services/permissions/yoloClassifier.js'

export type ClassifierProbeResult = { ok: boolean; detail?: string }

/**
 * Builds the cache key for the current probe target. Callers pass provider,
 * baseUrl, and model explicitly so the key reflects what was actually probed
 * (the resolved request shape), not what the profile claims.
 */
export function getClassifierProbeKey(input: {
  provider: string
  baseUrl: string
  model: string
}): string {
  return classifierProbeKey(input)
}

/** Reads the cached probe result for a key without probing. */
export function getCachedClassifierProbe(
  key: string,
): ClassifierProbeEntry | undefined {
  return readClassifierProbe(key)
}

/**
 * Probes whether `model` honors forced tool-choice and persists the result
 * under `key`. One sideQuery, max_tokens low, temperature 0, thinking off —
 * mirrors the classifier's own call shape (yoloClassifier.ts), using its real
 * tool schema so a provider that rejects that schema fails here too.
 */
export async function probeClassifierCapability(input: {
  key: string
  model: string
  signal?: AbortSignal
}): Promise<ClassifierProbeResult> {
  const { key, model, signal } = input
  let result: ClassifierProbeResult
  try {
    const response = await sideQuery({
      querySource: 'bash_classifier',
      model,
      system:
        'You are a security classifier capability probe. Respond only by calling the provided tool — never answer with plain text.',
      messages: [
        {
          role: 'user',
          content: `Call the ${YOLO_CLASSIFIER_TOOL_NAME} tool to allow this benign action (shouldBlock=false).`,
        },
      ],
      tools: [YOLO_CLASSIFIER_TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: YOLO_CLASSIFIER_TOOL_NAME },
      // Match the real classifier's budget (yoloClassifier.ts) so a model that
      // emits a little text before the forced call isn't truncated into a false
      // "no tool_use block" — that would wrongly exclude a capable provider.
      max_tokens: 4096,
      temperature: 0,
      thinking: false,
      maxRetries: 1,
      signal,
    })
    const block = extractToolUseBlock(response.content, YOLO_CLASSIFIER_TOOL_NAME)
    result = block
      ? { ok: true }
      : { ok: false, detail: 'no tool_use block in probe response' }
  } catch (e) {
    if (isAbortError(e)) throw e
    logError(new Error('classifier-probe: probe request failed', { cause: e }))
    result = {
      ok: false,
      detail: `probe request failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  writeClassifierProbe(key, { ...result, at: new Date().toISOString() })
  return result
}
