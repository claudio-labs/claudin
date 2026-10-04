/**
 * Bash command semantic classifier — matches a concrete shell command against
 * the natural-language descriptions in the user's `Bash(prompt: <description>)`
 * permission rules.
 *
 * Two flavors of classification:
 *
 * - **classifyBashCommand**: given a command + a list of descriptions + a
 *   behavior bucket (allow/deny/ask), asks an LLM whether the command matches
 *   any description. Drives the auto-approve fast-path in BashTool when the
 *   user has prompt-shaped allow rules, and the deny/ask gates downstream.
 *
 * - **generateGenericDescription**: takes a specific command (`git push origin
 *   feature/foo`) plus the user's draft description and returns a more reusable
 *   form (`git push a feature branch`) so the resulting allow rule covers
 *   future variants.
 *
 * Both are guarded by `isClassifierPermissionsEnabled()`, which short-circuits
 * to a no-op when the BASH_CLASSIFIER build flag is off so external builds
 * without classifier prompts don't attempt API calls.
 */
import { feature } from 'bun:bundle'
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages.js'
import { z } from 'zod/v4'
import { getDefaultMaxRetries } from 'src/providers/transport/withRetry.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { errorMessage } from 'src/shared/errors.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getMainLoopModel } from 'src/providers/model/model.js'
import { permissionRuleValueFromString } from 'src/permissions/permissionRuleParser.js'
import { sideQuery, type SideQueryOptions } from 'src/agent/sideQuery.js'
import {
  extractToolUseBlock,
  parseClassifierResponse,
} from 'src/permissions/classifierShared.js'

export const PROMPT_PREFIX = 'prompt:'

export type ClassifierResult = {
  matches: boolean
  matchedDescription?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

export type ClassifierBehavior = 'deny' | 'ask' | 'allow'

const BASH_TOOL_NAME = 'Bash'

/**
 * Pull the description out of a Bash(prompt: ...) ruleContent.
 * Returns null for rules that are not prompt-shaped (e.g. "npm install:*").
 */
export function extractPromptDescription(
  ruleContent: string | undefined,
): string | null {
  if (!ruleContent) return null
  const trimmed = ruleContent.trimStart()
  if (!trimmed.toLowerCase().startsWith(PROMPT_PREFIX)) return null
  return trimmed.slice(PROMPT_PREFIX.length).trim() || null
}

export function createPromptRuleContent(description: string): string {
  return `${PROMPT_PREFIX} ${description.trim()}`
}

// Test hatch: bun test runs source files without the build-time
// preprocessor, so feature('BASH_CLASSIFIER') always returns false in tests
// and short-circuits classifyBashCommand before sideQuery is invoked. Tests
// flip this to true via __setBashClassifierEnabledForTests so adversarial
// test cases can exercise the real call path. Kept outside the production
// gate so production behavior is unchanged.
let __testForceEnabled: boolean | undefined

/** @internal - test-only override; do not call from production code */
export function __setBashClassifierEnabledForTests(
  v: boolean | undefined,
): void {
  __testForceEnabled = v
}

/**
 * Whether the bash prompt-rule classifier is wired up in this build.
 * Gated on the BASH_CLASSIFIER feature flag. The bash classifier carries its
 * own prompts inline (no .txt template dependency), so it works independently
 * of the auto-mode classifier's bundled-prompts state.
 */
export function isClassifierPermissionsEnabled(): boolean {
  if (__testForceEnabled !== undefined) return __testForceEnabled
  return feature('BASH_CLASSIFIER') ? true : false
}

function collectPromptDescriptions(
  rulesBySource: ToolPermissionContext['alwaysAllowRules'],
): string[] {
  const found = new Set<string>()
  for (const rules of Object.values(rulesBySource)) {
    for (const rule of rules ?? []) {
      const { toolName, ruleContent } = permissionRuleValueFromString(rule)
      if (toolName !== BASH_TOOL_NAME) continue
      const description = extractPromptDescription(ruleContent)
      if (description !== null) found.add(description)
    }
  }
  return [...found]
}

export function getBashPromptDenyDescriptions(
  context: ToolPermissionContext,
): string[] {
  return collectPromptDescriptions(context.alwaysDenyRules)
}

export function getBashPromptAskDescriptions(
  context: ToolPermissionContext,
): string[] {
  return collectPromptDescriptions(context.alwaysAskRules)
}

export function getBashPromptAllowDescriptions(
  context: ToolPermissionContext,
): string[] {
  return collectPromptDescriptions(context.alwaysAllowRules)
}

/** A tool the model is forced to call, every one of whose fields is required. */
function forcedTool(name: string, description: string, fields: Record<string, Record<string, unknown>>): BetaTool {
  return {
    type: 'custom',
    name,
    description,
    input_schema: { type: 'object', properties: fields, required: Object.keys(fields) },
  }
}

const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const

const MATCH_TOOL = forcedTool('classify_match', 'Report whether the shell command matches one of the listed descriptions', {
  matchedIndex: {
    type: ['integer', 'null'],
    description: 'Zero-based index of the description the command matches, or null if no description matches',
  },
  confidence: {
    type: 'string',
    enum: [...CONFIDENCE_LEVELS],
    description:
      "Confidence in the match. 'high' means the command unambiguously falls under the description; 'low' means a plausible but uncertain interpretation.",
  },
  reason: { type: 'string', description: 'Brief one-sentence explanation of the match (or non-match)' },
})

const matchAnswer = z.object({
  matchedIndex: z.number().int().nullable(),
  confidence: z.enum(CONFIDENCE_LEVELS),
  reason: z.string(),
})

type ForcedCallOutcome<T> = { kind: 'answer'; input: T } | { kind: 'no-call' } | { kind: 'malformed' }

/**
 * One forced tool call: the validated input, or why there is none. A failed
 * request throws; the callers decide what an error means.
 */
async function askForcedTool<T extends z.ZodType>(
  tool: BetaTool,
  answer: T,
  request: Pick<SideQueryOptions, 'system' | 'messages' | 'max_tokens' | 'temperature' | 'signal'>,
): Promise<ForcedCallOutcome<z.infer<T>>> {
  const response = await sideQuery({
    ...request,
    model: getMainLoopModel(),
    thinking: false,
    maxRetries: getDefaultMaxRetries(),
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  })
  const call = extractToolUseBlock(response.content, tool.name)
  if (call === null) return { kind: 'no-call' }
  const input = parseClassifierResponse(call, answer)
  return input === null ? { kind: 'malformed' } : { kind: 'answer', input }
}

const ALLOW_BEHAVIOR_INSTRUCTIONS =
  'You are deciding whether a shell command should be auto-approved. ' +
  'Match against the descriptions only. A match means the command, AS WRITTEN, ' +
  'falls clearly under what the description authorizes. ' +
  "Be strict: if the command does more than the description says (extra flags, " +
  'pipes into another command, network calls the description did not mention), ' +
  "treat it as no-match. Confidence 'high' is reserved for unambiguous matches."

const DENY_BEHAVIOR_INSTRUCTIONS =
  'You are deciding whether a shell command falls under a deny rule. ' +
  'Match against the descriptions only. A match means the command, AS WRITTEN, ' +
  'unambiguously matches what the description forbids. ' +
  'Be precise: do not deny a command that merely shares a prefix with a denied ' +
  "pattern but has different semantics. Confidence 'high' is reserved for " +
  'unambiguous matches.'

const ASK_BEHAVIOR_INSTRUCTIONS =
  'You are deciding whether a shell command requires the user to be asked ' +
  'because it falls under an ask rule. Match against the descriptions only. ' +
  'A match means the command falls within the area the description scopes. ' +
  "Confidence 'high' is reserved for unambiguous matches."

function getBehaviorInstructions(behavior: ClassifierBehavior): string {
  switch (behavior) {
    case 'allow':
      return ALLOW_BEHAVIOR_INSTRUCTIONS
    case 'deny':
      return DENY_BEHAVIOR_INSTRUCTIONS
    case 'ask':
      return ASK_BEHAVIOR_INSTRUCTIONS
  }
}

function buildBashClassifierUserPrompt(
  command: string,
  cwd: string,
  descriptions: string[],
): string {
  const numbered = descriptions
    .map((d, i) => `[${i}] ${d}`)
    .join('\n')
  return [
    `<cwd>${cwd}</cwd>`,
    '',
    '<descriptions>',
    numbered,
    '</descriptions>',
    '',
    '<command>',
    command,
    '</command>',
    '',
    'Report your classification via the classify_match tool.',
  ].join('\n')
}

/**
 * Match a concrete shell command against a list of natural-language
 * descriptions from the user's permission rules.
 *
 * Returns `{ matches: false }` early when the classifier is disabled or there
 * are no descriptions to match against — both no-op cases avoid a wasted API
 * call.
 *
 * On API error: returns `{ matches: false, confidence: 'low' }`. We do not
 * fall back to "match" on error — that would silently auto-approve commands
 * the classifier did not actually evaluate.
 */
export async function classifyBashCommand(
  command: string,
  cwd: string,
  descriptions: string[],
  behavior: ClassifierBehavior,
  signal: AbortSignal,
  _isNonInteractiveSession: boolean,
): Promise<ClassifierResult> {
  if (!isClassifierPermissionsEnabled()) {
    return { matches: false, confidence: 'high', reason: 'classifier disabled' }
  }
  if (descriptions.length === 0) {
    return { matches: false, confidence: 'high', reason: 'no descriptions to match against' }
  }

  let outcome: ForcedCallOutcome<z.infer<typeof matchAnswer>>
  try {
    outcome = await askForcedTool(MATCH_TOOL, matchAnswer, {
      system: getBehaviorInstructions(behavior),
      messages: [{ role: 'user', content: buildBashClassifierUserPrompt(command, cwd, descriptions) }],
      max_tokens: 512,
      temperature: 0,
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    logForDebugging(`Bash prompt-rule classifier failed: ${errorMessage(error)}`, { level: 'warn' })
    return { matches: false, confidence: 'low', reason: `classifier error: ${errorMessage(error)}` }
  }

  if (outcome.kind === 'no-call') {
    return { matches: false, confidence: 'low', reason: 'classifier returned no tool_use block' }
  }
  if (outcome.kind === 'malformed') {
    return { matches: false, confidence: 'low', reason: 'classifier returned malformed response' }
  }
  const { matchedIndex, confidence, reason } = outcome.input
  const matched = matchedIndex === null ? undefined : descriptions[matchedIndex]
  // A negative or out-of-range index finds nothing here, so it can never match.
  if (matched === undefined) return { matches: false, confidence, reason }
  return { matches: true, matchedDescription: matched, confidence, reason }
}

const PROPOSE_TOOL = forcedTool(
  'propose_description',
  'Propose a reusable natural-language description for a class of shell commands',
  {
    description: {
      type: 'string',
      description:
        'A short description of the command class, in the imperative — e.g. "list git remotes" or "run jest tests".',
    },
  },
)

const proposalAnswer = z.object({ description: z.string().min(1) })

const GENERIC_DESCRIPTION_SYSTEM_PROMPT =
  'You generalize a specific shell command into a short reusable description ' +
  'that the user can save as a permission rule. ' +
  'Output a single sentence in the imperative, naming the class of action ' +
  '(verbs and category, not exact arguments). ' +
  'If the user already provided a draft description, refine it; do not replace ' +
  "it with something narrower. If the command is too narrow to generalize " +
  '(e.g. just `ls`), return the user\'s draft unchanged.'

/**
 * Generalize a specific shell command into a reusable description for use as
 * a `Bash(prompt: ...)` rule. Returns null on error so the caller falls back
 * to the user's literal draft.
 */
export async function generateGenericDescription(
  command: string,
  specificDescription: string | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  const fallback = specificDescription || null
  if (!isClassifierPermissionsEnabled()) return fallback

  const prompt = [
    '<command>',
    command,
    '</command>',
    '',
    `<user_draft>${specificDescription ?? ''}</user_draft>`,
    '',
    'Propose the description via the propose_description tool.',
  ].join('\n')
  try {
    const outcome = await askForcedTool(PROPOSE_TOOL, proposalAnswer, {
      system: GENERIC_DESCRIPTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
      signal,
    })
    const proposal = outcome.kind === 'answer' ? outcome.input.description.trim() : ''
    return proposal === '' ? fallback : proposal
  } catch (error) {
    if (signal.aborted) throw error
    logForDebugging(`Bash rule generalization failed: ${errorMessage(error)}`, { level: 'warn' })
    return fallback
  }
}
