/**
 * The first message of the fresh context that a clear-context approval starts.
 * It carries the plan and points at the transcript the plan was made in,
 * because the cleared conversation is otherwise gone for the model.
 */
import { TEAM_CREATE_TOOL_NAME } from 'src/tools/TeamCreateTool/constants.js'

export type ClearContextPromptParts = {
  plan: string
  /** The transcript of the session the plan was made in, read before the clear. */
  transcriptPath: string
  teamsEnabled: boolean
  /** Already trimmed; empty when nothing was typed. */
  feedback: string
}

export function clearContextPrompt({ plan, transcriptPath, teamsEnabled, feedback }: ClearContextPromptParts): string {
  const sections = [
    `Implement the following plan:\n\n${plan}`,
    'The conversation that produced this plan has been cleared. When you need its details again (exact code snippets, ' +
      `error messages, or content generated earlier), read the full transcript at: ${transcriptPath}`,
  ]
  if (teamsEnabled) {
    sections.push(
      'If the work can be broken down into multiple independent tasks, consider splitting it up, ' +
        `using the ${TEAM_CREATE_TOOL_NAME} tool to create a team that works on them in parallel.`,
    )
  }
  if (feedback) sections.push(`User feedback on this plan: ${feedback}`)
  return sections.join('\n\n')
}
