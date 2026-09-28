/**
 * Fields to Command: the prompt command a skill becomes, whatever it was
 * loaded from, and what listing it costs in context.
 */
import type { Command, CommandBase, PromptCommand } from 'src/shared/types/command.js'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import type { SkillFrontmatterFields } from 'src/skills/loading/frontmatterFields.js'
import { buildSkillPrompt, skillPromptDeps } from 'src/skills/loading/skillPrompt.js'

export type LoadedFrom = NonNullable<CommandBase['loadedFrom']>

/**
 * A skill is always a prompt command. Typing it that way still satisfies
 * every `Command` consumer, and spares the loader a narrowing step.
 */
export type SkillCommand = CommandBase & PromptCommand

/**
 * The parsed fields, plus what only the loader knows. A field that lands on
 * the Command unchanged has the type of the Command field it lands on.
 */
type SkillCommandParams = Omit<SkillFrontmatterFields, 'executionContext'> & {
  executionContext: SkillCommand['context']
  skillName: string
  markdownContent: string
  source: SkillCommand['source']
  baseDir: SkillCommand['skillRoot']
  loadedFrom: LoadedFrom
  paths: SkillCommand['paths']
}

export function createSkillCommand(params: SkillCommandParams): SkillCommand {
  return {
    type: 'prompt',
    name: params.skillName,
    description: params.description,
    hasUserSpecifiedDescription: params.hasUserSpecifiedDescription,
    allowedTools: params.allowedTools,
    argumentHint: params.argumentHint,
    argNames: params.argumentNames.length > 0 ? params.argumentNames : undefined,
    whenToUse: params.whenToUse,
    version: params.version,
    model: params.model,
    disableModelInvocation: params.disableModelInvocation,
    userInvocable: params.userInvocable,
    isHidden: !params.userInvocable,
    context: params.executionContext,
    agent: params.agent,
    effort: params.effort,
    paths: params.paths,
    hooks: params.hooks,
    contentLength: params.markdownContent.length,
    progressMessage: 'running',
    source: params.source,
    loadedFrom: params.loadedFrom,
    skillRoot: params.baseDir,
    userFacingName: () => params.displayName || params.skillName,
    async getPromptForCommand(args, context) {
      const text = await buildSkillPrompt(params, args, context, skillPromptDeps)
      return [{ type: 'text', text }]
    },
  }
}

/** The name, description and when-to-use; the body loads only when the skill runs. */
export function estimateSkillFrontmatterTokens(skill: Command): number {
  const frontmatter = [skill.name, skill.description, skill.whenToUse]
    .filter(Boolean)
    .join(' ')
  return roughTokenCountEstimation(frontmatter)
}
