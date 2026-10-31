/**
 * Auto mode with a model running on the user's own machine.
 *
 * The auto-mode classifier runs on the main loop model (classifierConfig.ts),
 * so with Ollama or another local server the model judges its own actions.
 * The capability probe only checks that it can make a forced tool call, not
 * that it judges well, and a small local model does not: on 2026-10-31 a qwen
 * 3B-active MoE denied a Portainer MCP call citing a `cat` from the previous
 * response. Each verdict is also a full prefill on the same GPU the session
 * runs on. So such a call skips the classifier and is asked like outside auto
 * mode; reads, allow rules and the acceptEdits fast path still go through.
 *
 * A Claude model behind a local proxy (LiteLLM and the like) is still a
 * capable classifier and keeps it.
 */
import { isLocalProviderUrl } from 'src/providers/presets/providerConfig.js'

// `claude-…`, `anthropic/claude-…`, a Bedrock region prefix `us.anthropic.claude-…`.
const ANTHROPIC_MODEL_NAME_RE = /(?:^|[/.:])claude-/i

export function classifierWouldRunLocally(
  model: string,
  baseUrl: string | undefined,
): boolean {
  return isLocalProviderUrl(baseUrl) && !ANTHROPIC_MODEL_NAME_RE.test(model)
}

export const LOCAL_CLASSIFIER_NOTICE =
  'Auto mode with a local model: actions it would classify ask for confirmation'

let noticeShown = false

/** The notice the first time this process takes the local path, then null. */
export function takeLocalClassifierNotice(): string | null {
  if (noticeShown) return null
  noticeShown = true
  return LOCAL_CLASSIFIER_NOTICE
}

export function _resetLocalClassifierNoticeForTesting(): void {
  noticeShown = false
}
