/**
 * The analysis step of /auto-mode-setup: one side query that turns the
 * collected signals into a proposed `autoMode` config.
 *
 * Written on the assumption that the model's answer is untrusted input.
 * `validateProposal` is the gate everything passes through, and it is pure so
 * the rules it enforces can be tested without a network call:
 *
 * - every section must carry the `$defaults` sentinel, so a proposal can never
 *   silently drop the shipped rules (this is the one failure worth a retry —
 *   the model is told what it got wrong and asked once more)
 * - every entry is sanitized, so nothing that could forge a bullet or hide
 *   text reaches the classifier prompt
 * - allow entries broad enough to bypass the classifier are dropped and
 *   reported as notes rather than honored
 *
 * Structured output uses a forced tool call, not `output_format`: no provider
 * shim in this fork translates `output_format`, so it would silently degrade to
 * prose on every non-Anthropic provider.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages.js'
import { z } from 'zod/v4'

import {
  DEFAULTS_SENTINEL,
  describeDropReason,
  filterBroadAllowEntries,
  hasDefaultsSentinel,
  sanitizeRuleEntries,
} from 'src/permissions/autoModeRules.js'
import {
  type AutoModeRules,
  buildDefaultExternalSystemPrompt,
} from 'src/permissions/yoloClassifier.js'
import { extractToolUseBlock } from 'src/permissions/classifierShared.js'
import { getMainLoopModel } from 'src/providers/model/model.js'
import { sideQuery } from 'src/agent/sideQuery.js'
import { logError } from 'src/shared/log.js'
import {
  type EnvironmentSignals,
  renderSignals,
} from 'src/commands/auto-mode-setup/collectSignals.js'

export const AUTO_MODE_SETUP_TOOL_NAME = 'propose_auto_mode_rules'

const MAX_PROPOSAL_TOKENS = 4096

export type ProposedRules = AutoModeRules & {
  /** Model-written rationale, plus every note this module added. */
  notes: string[]
}

export type ValidationResult = {
  rules: ProposedRules | null
  /** Non-empty means the proposal was refused; these are sent back on retry. */
  problems: string[]
}

const proposalSchema = z.object({
  allow: z.array(z.string()),
  soft_deny: z.array(z.string()),
  environment: z.array(z.string()),
  notes: z.array(z.string()).optional(),
})

export const AUTO_MODE_SETUP_TOOL_SCHEMA: BetaToolUnion = {
  type: 'custom',
  name: AUTO_MODE_SETUP_TOOL_NAME,
  description:
    'Report the proposed auto mode classifier rules for this environment',
  input_schema: {
    type: 'object',
    properties: {
      allow: {
        type: 'array',
        items: { type: 'string' },
        description: `Actions safe to auto-approve here. MUST start with the entry "${DEFAULTS_SENTINEL}", which stands for the shipped default rules.`,
      },
      soft_deny: {
        type: 'array',
        items: { type: 'string' },
        description: `Actions that must never be auto-approved here. MUST start with the entry "${DEFAULTS_SENTINEL}".`,
      },
      environment: {
        type: 'array',
        items: { type: 'string' },
        description: `Facts about this environment that help the classifier judge an action. MUST start with the entry "${DEFAULTS_SENTINEL}".`,
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Short explanations of the additions, shown to the user before anything is written.',
      },
    },
    required: ['allow', 'soft_deny', 'environment'],
  },
}

export function buildAnalysisSystemPrompt(): string {
  return (
    'You tailor the auto mode classifier of Claudin, a coding-agent CLI, to one ' +
    "developer's environment.\n\n" +
    'Auto mode runs an LLM classifier over each tool call the agent wants to ' +
    'make and decides whether to auto-approve it. Three sections of that ' +
    "classifier's system prompt are user-configurable:\n\n" +
    '- allow: actions to auto-approve\n' +
    '- soft_deny: actions to block even when the agent argues for them\n' +
    "- environment: facts about the user's setup that inform every decision\n\n" +
    'You are given signals collected from the machine: the project, its scripts ' +
    'and config files, the git repository, the rules the user has already ' +
    'chosen to always allow, and counted command shapes from past sessions and ' +
    'shell history. Command arguments are deliberately absent — reason from the ' +
    'shapes.\n\n' +
    'Rules for your answer:\n' +
    `1. Every array MUST contain the literal entry "${DEFAULTS_SENTINEL}" as its ` +
    'first element. It expands to the shipped defaults. Omitting it deletes ' +
    'them, which is never what the user wants.\n' +
    '2. Add only entries justified by the signals. Five precise additions beat ' +
    'twenty generic ones; an empty section (sentinel only) is a fine answer.\n' +
    '3. Write each entry as one line of plain prose describing the action, in ' +
    'the voice of the existing rules. No newlines, no markdown bullets.\n' +
    '4. Never propose a blanket allow (any command, any bash, `Bash(*)`); it ' +
    'would disable the classifier and will be discarded.\n' +
    '5. Prefer soft_deny entries that name this environment specifically — the ' +
    'production target, the protected branch, the directory holding secrets.\n\n' +
    'Here is the full classifier system prompt with its default rules, so you ' +
    'can see what your entries join:\n\n' +
    '<classifier_system_prompt>\n' +
    buildDefaultExternalSystemPrompt() +
    '\n</classifier_system_prompt>'
  )
}

export function buildAnalysisUserMessage(
  signals: EnvironmentSignals,
  current: AutoModeRules | null,
): string {
  const currentBlock = current
    ? '<current_rules>\n' +
      JSON.stringify(current, null, 2) +
      '\n</current_rules>\n\n' +
      'These are the rules already in effect. Keep what still fits, drop what ' +
      'the signals contradict, and say what you changed in notes.\n\n'
    : ''
  return (
    'Signals collected from this environment:\n\n' +
    '<signals>\n' +
    renderSignals(signals) +
    '\n</signals>\n\n' +
    currentBlock +
    `Call ${AUTO_MODE_SETUP_TOOL_NAME} with the proposed configuration.`
  )
}

/**
 * Turn the model's tool input into rules that are safe to write, or refuse it.
 * Pure: the caller decides whether to retry.
 */
export function validateProposal(raw: unknown): ValidationResult {
  const parsed = proposalSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      rules: null,
      problems: [
        'The tool input did not match the schema: allow, soft_deny and environment must each be an array of strings.',
      ],
    }
  }

  const problems: string[] = []
  for (const section of ['allow', 'soft_deny', 'environment'] as const) {
    if (!hasDefaultsSentinel(parsed.data[section])) {
      problems.push(
        `The "${section}" array is missing the required "${DEFAULTS_SENTINEL}" entry, which would delete the shipped default rules.`,
      )
    }
  }
  if (problems.length > 0) return { rules: null, problems }

  const notes = [...(parsed.data.notes ?? [])]

  const allowSanitized = sanitizeRuleEntries(parsed.data.allow)
  const allowFiltered = filterBroadAllowEntries(allowSanitized.entries)
  const denySanitized = sanitizeRuleEntries(parsed.data.soft_deny)
  const envSanitized = sanitizeRuleEntries(parsed.data.environment)

  for (const [section, dropped] of [
    ['allow', [...allowSanitized.dropped, ...allowFiltered.dropped]],
    ['soft_deny', denySanitized.dropped],
    ['environment', envSanitized.dropped],
  ] as const) {
    for (const drop of dropped) {
      notes.push(
        `Dropped a proposed ${section} entry — ${describeDropReason(drop.reason)}.`,
      )
    }
  }

  return {
    rules: {
      allow: allowFiltered.entries,
      soft_deny: denySanitized.entries,
      environment: envSanitized.entries,
      notes,
    },
    problems: [],
  }
}

export type AnalyzeRulesDeps = {
  runQuery(
    messages: Anthropic.MessageParam[],
    system: string,
    signal?: AbortSignal,
  ): Promise<unknown>
}

export function defaultAnalyzeRulesDeps(): AnalyzeRulesDeps {
  return {
    async runQuery(messages, system, signal) {
      const response = await sideQuery({
        querySource: 'auto_mode_setup',
        model: getMainLoopModel(),
        system,
        max_tokens: MAX_PROPOSAL_TOKENS,
        messages,
        tools: [AUTO_MODE_SETUP_TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: AUTO_MODE_SETUP_TOOL_NAME },
        signal,
      })
      const block = extractToolUseBlock(
        response.content,
        AUTO_MODE_SETUP_TOOL_NAME,
      )
      return block?.input ?? null
    },
  }
}

export class AutoModeProposalError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message)
    this.name = 'AutoModeProposalError'
  }
}

/**
 * Ask the model for a configuration and validate it. One repair retry: the
 * refusal reasons are handed back so the model can correct the same answer,
 * which is what a missing sentinel usually needs.
 */
export async function proposeRules(
  signals: EnvironmentSignals,
  current: AutoModeRules | null,
  options: { signal?: AbortSignal } = {},
  deps: AnalyzeRulesDeps = defaultAnalyzeRulesDeps(),
): Promise<ProposedRules> {
  const system = buildAnalysisSystemPrompt()
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildAnalysisUserMessage(signals, current) },
  ]

  let lastProblems: string[] = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw: unknown
    try {
      raw = await deps.runQuery(messages, system, options.signal)
    } catch (error) {
      logError(error)
      throw new AutoModeProposalError(
        'The analysis could not be completed. Try again, or configure autoMode by hand.',
      )
    }

    const { rules, problems } = validateProposal(raw)
    if (rules) return rules

    lastProblems = problems
    messages.push(
      { role: 'assistant', content: JSON.stringify(raw ?? {}) },
      {
        role: 'user',
        content:
          'That proposal was rejected:\n' +
          problems.map(problem => `- ${problem}`).join('\n') +
          `\n\nCall ${AUTO_MODE_SETUP_TOOL_NAME} again with the problems fixed.`,
      },
    )
  }

  throw new AutoModeProposalError(
    'The proposed configuration was rejected twice.',
    lastProblems,
  )
}
