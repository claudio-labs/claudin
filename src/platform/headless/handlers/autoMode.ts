/**
 * Auto mode subcommand handlers — dump default/merged classifier rules and
 * critique user-written rules. Dynamically imported when `claude auto-mode ...` runs.
 */

import { errorMessage } from 'src/shared/errors.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from 'src/providers/model/model.js'
import {
  type AutoModeRules,
  buildDefaultExternalSystemPrompt,
  getDefaultExternalAutoModeRules,
  isClassifierBundled,
} from 'src/permissions/yoloClassifier.js'
import {
  getAutoModeConfig,
  getAutoModeConfigWithNotes,
  getRelativeSettingsFilePathForSource,
} from 'src/platform/settings/settings.js'
import {
  expandDefaults,
  hasDefaultsSentinel,
} from 'src/permissions/autoModeRules.js'
import { sideQuery } from 'src/agent/sideQuery.js'
import { jsonStringify } from 'src/platform/slowOperations.js'

function writeRules(rules: AutoModeRules): void {
  process.stdout.write(jsonStringify(rules, null, 2) + '\n')
}

const CLASSIFIER_NOT_BUNDLED_MSG =
  'Auto-mode classifier prompts are not bundled in this build.\n' +
  'Effective behavior at runtime: auto-allow for non-allowlisted tools.\n' +
  'Add prompt templates at src/permissions/yolo-classifier-prompts/ ' +
  'and rebuild to enable.\n'

export function autoModeDefaultsHandler(): void {
  if (!isClassifierBundled()) {
    process.stdout.write(CLASSIFIER_NOT_BUNDLED_MSG)
    return
  }
  writeRules(getDefaultExternalAutoModeRules())
}

/**
 * Dump the effective auto mode config: user settings where provided, external
 * defaults otherwise. Resolution matches buildYoloSystemPrompt exactly: an
 * empty section falls through to the defaults, a section carrying the
 * `$defaults` sentinel splices them in at that position, and a section without
 * it replaces them. Entries dropped by sanitization, and autoMode blocks
 * ignored because they live in the repository, are reported after the JSON.
 */
export function autoModeConfigHandler(): void {
  if (!isClassifierBundled()) {
    process.stdout.write(CLASSIFIER_NOT_BUNDLED_MSG)
    return
  }
  const { config, dropped, ignoredSources } = getAutoModeConfigWithNotes()
  const defaults = getDefaultExternalAutoModeRules()
  writeRules({
    allow: expandDefaults(config?.allow ?? [], defaults.allow),
    soft_deny: expandDefaults(config?.soft_deny ?? [], defaults.soft_deny),
    environment: expandDefaults(config?.environment ?? [], defaults.environment),
  })
  for (const drop of dropped) {
    process.stderr.write(
      `note: dropped one ${drop.section} entry — ${drop.reason}\n`,
    )
  }
  for (const source of ignoredSources) {
    const file = getRelativeSettingsFilePathForSource(
      source as 'projectSettings' | 'localSettings',
    )
    process.stderr.write(
      `note: autoMode in ${file} was ignored — settings inside the repository cannot configure auto mode\n`,
    )
  }
}

const CRITIQUE_SYSTEM_PROMPT =
  'You are an expert reviewer of auto mode classifier rules for Claude Code.\n' +
  '\n' +
  'Claude Code has an "auto mode" that uses an AI classifier to decide whether ' +
  'tool calls should be auto-approved or require user confirmation. Users can ' +
  'write custom rules in three categories:\n' +
  '\n' +
  '- **allow**: Actions the classifier should auto-approve\n' +
  '- **soft_deny**: Actions the classifier should block (require user confirmation)\n' +
  "- **environment**: Context about the user's setup that helps the classifier make decisions\n" +
  '\n' +
  "Your job is to critique the user's custom rules for clarity, completeness, " +
  'and potential issues. The classifier is an LLM that reads these rules as ' +
  'part of its system prompt.\n' +
  '\n' +
  'For each rule, evaluate:\n' +
  '1. **Clarity**: Is the rule unambiguous? Could the classifier misinterpret it?\n' +
  "2. **Completeness**: Are there gaps or edge cases the rule doesn't cover?\n" +
  '3. **Conflicts**: Do any of the rules conflict with each other?\n' +
  '4. **Actionability**: Is the rule specific enough for the classifier to act on?\n' +
  '\n' +
  'Be concise and constructive. Only comment on rules that could be improved. ' +
  'If all rules look good, say so.'

export async function autoModeCritiqueHandler(options: {
  model?: string
}): Promise<void> {
  if (!isClassifierBundled()) {
    process.stdout.write(CLASSIFIER_NOT_BUNDLED_MSG)
    return
  }
  const config = getAutoModeConfig()
  const hasCustomRules =
    (config?.allow?.length ?? 0) > 0 ||
    (config?.soft_deny?.length ?? 0) > 0 ||
    (config?.environment?.length ?? 0) > 0

  if (!hasCustomRules) {
    process.stdout.write(
      'No custom auto mode rules found.\n\n' +
        'Add rules to your settings file under autoMode.{allow, soft_deny, environment}.\n' +
        'Run `claude auto-mode defaults` to see the default rules for reference.\n',
    )
    return
  }

  const model = options.model
    ? parseUserSpecifiedModel(options.model)
    : getMainLoopModel()

  const defaults = getDefaultExternalAutoModeRules()
  const classifierPrompt = buildDefaultExternalSystemPrompt()

  const userRulesSummary =
    formatRulesForCritique('allow', config?.allow ?? [], defaults.allow) +
    formatRulesForCritique(
      'soft_deny',
      config?.soft_deny ?? [],
      defaults.soft_deny,
    ) +
    formatRulesForCritique(
      'environment',
      config?.environment ?? [],
      defaults.environment,
    )

  process.stdout.write('Analyzing your auto mode rules…\n\n')

  let response
  try {
    response = await sideQuery({
      querySource: 'auto_mode_critique',
      model,
      system: CRITIQUE_SYSTEM_PROMPT,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content:
            'Here is the full classifier system prompt that the auto mode classifier receives:\n\n' +
            '<classifier_system_prompt>\n' +
            classifierPrompt +
            '\n</classifier_system_prompt>\n\n' +
            "Here are the user's custom rules. A section listing `$defaults` " +
            'keeps the shipped rules and adds to them; a section without it ' +
            'replaces them entirely:\n\n' +
            userRulesSummary +
            '\nPlease critique these custom rules.',
        },
      ],
    })
  } catch (error) {
    process.stderr.write(
      'Failed to analyze rules: ' + errorMessage(error) + '\n',
    )
    process.exitCode = 1
    return
  }

  const textBlock = response.content.find(block => block.type === 'text')
  if (textBlock?.type === 'text') {
    process.stdout.write(textBlock.text + '\n')
  } else {
    process.stdout.write('No critique was generated. Please try again.\n')
  }
}

function formatRulesForCritique(
  section: string,
  userRules: string[],
  defaultRules: string[],
): string {
  if (userRules.length === 0) return ''
  const extendsDefaults = hasDefaultsSentinel(userRules)
  const customLines = userRules.map(r => '- ' + r).join('\n')
  const defaultLines = defaultRules.map(r => '- ' + r).join('\n')
  return (
    '## ' +
    section +
    (extendsDefaults
      ? ' (custom rules, added to the defaults)\n'
      : ' (custom rules REPLACING the defaults)\n') +
    'Custom:\n' +
    customLines +
    '\n\n' +
    (extendsDefaults ? 'Defaults kept:\n' : 'Defaults being replaced:\n') +
    defaultLines +
    '\n\n'
  )
}
