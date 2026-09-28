/**
 * The prompt a skill produces when it runs. Callers can observe the order of
 * its steps, so the order lives here, in one function.
 */
import { substituteArguments } from 'src/commands/argumentSubstitution.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import type { FrontmatterShell } from 'src/shared/frontmatterParser.js'
import { executeShellCommandsInPrompt } from 'src/shared/proc/promptShellExecution.js'
import type { CommandBase } from 'src/shared/types/command.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

/** What the prompt is built from, in the order the steps use it. */
type SkillPromptSource = {
  markdownContent: string
  baseDir: string | undefined
  argumentNames: string[]
  loadedFrom: CommandBase['loadedFrom']
  skillName: string
  allowedTools: string[]
  shell: FrontmatterShell | undefined
}

export type SkillPromptDeps = {
  sessionId: () => string
  /** Runs the inline !`cmd` and the ```! blocks, each through the permission check. */
  runEmbeddedShell: (
    text: string,
    context: ToolUseContext,
    commandName: string,
    shell: FrontmatterShell | undefined,
  ) => Promise<string>
}

export const skillPromptDeps: SkillPromptDeps = {
  sessionId: getSessionId,
  runEmbeddedShell: executeShellCommandsInPrompt,
}

type AppState = ReturnType<ToolUseContext['getAppState']>

const SKILL_DIR_VARIABLE = '${CLAUDIN_SKILL_DIR}'
const SESSION_ID_VARIABLE = '${CLAUDIN_SESSION_ID}'
const BACKSLASH_RE = /\\/g

export async function buildSkillPrompt(
  skill: SkillPromptSource,
  args: string,
  context: ToolUseContext,
  deps: SkillPromptDeps,
): Promise<string> {
  // Arguments are filled before the variables and before the shell pass, so
  // text in them is treated like the author's. That is a known finding, kept
  // on purpose: skills in the wild put $ARGUMENTS inside an embedded command,
  // and the fix needs a design of its own (the spec's Security requirements).
  let text = withBaseDirectory(skill.markdownContent, skill.baseDir)
  text = substituteArguments(text, args, true, skill.argumentNames)
  if (skill.baseDir) {
    text = replaceLiterally(text, SKILL_DIR_VARIABLE, pathForPrompt(skill.baseDir))
  }
  text = replaceLiterally(text, SESSION_ID_VARIABLE, deps.sessionId())
  // MCP skill markdown is remote and untrusted: its shell syntax stays text.
  if (skill.loadedFrom === 'mcp') return text
  return deps.runEmbeddedShell(
    text,
    withAllowedTools(context, skill.allowedTools),
    `/${skill.skillName}`,
    skill.shell,
  )
}

function withBaseDirectory(body: string, baseDir: string | undefined): string {
  return baseDir ? `Base directory for this skill: ${baseDir}\n\n${body}` : body
}

/**
 * A function replacer inserts the value as it is. As a replacement string,
 * a `$&` or `$$` in a path would be expanded instead.
 */
function replaceLiterally(text: string, variable: string, value: string): string {
  return text.replaceAll(variable, () => value)
}

function pathForPrompt(baseDir: string): string {
  // Skills use the path in shell commands, and bash reads a backslash as an
  // escape character.
  return process.platform === 'win32' ? baseDir.replace(BACKSLASH_RE, '/') : baseDir
}

/**
 * For the shell pass only, the permission check sees the skill's allowed
 * tools as the always-allow rules of the `command` source.
 */
function withAllowedTools(
  context: ToolUseContext,
  allowedTools: string[],
): ToolUseContext {
  const getAppState = (): AppState => {
    const appState = context.getAppState()
    const permissions = appState.toolPermissionContext
    return {
      ...appState,
      toolPermissionContext: {
        ...permissions,
        alwaysAllowRules: { ...permissions.alwaysAllowRules, command: allowedTools },
      },
    }
  }
  return { ...context, getAppState }
}
