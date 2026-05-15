import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Command } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import { executeShellCommandsInPrompt } from '../../utils/promptShellExecution.js'
import { buildAutofixPrompt } from './prompt.js'
import { assertAutofixPreconditions } from './shared.js'

const WHITESPACE_RE = /\s+/

const ALLOWED_TOOLS = [
  // Read paths shared by both modes.
  'Bash(gh pr view:*)',
  'Bash(gh api:*)',
  'Bash(jq:*)',
  'Bash(base64:*)',
  // Write paths used by the default (fix → commit → push → reply) mode.
  'Bash(git add:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git log:*)',
  'Bash(git reset --soft:*)',
  'Bash(bun run typecheck:*)',
  'Bash(bun test:*)',
]

function parseArgs(args: string): { dryRun: boolean; rest: string } {
  const flag = '--dry-run'
  const trimmed = args.trim()
  if (!trimmed) return { dryRun: false, rest: '' }
  const tokens = trimmed.split(WHITESPACE_RE)
  const idx = tokens.indexOf(flag)
  if (idx === -1) return { dryRun: false, rest: trimmed }
  tokens.splice(idx, 1)
  return { dryRun: true, rest: tokens.join(' ') }
}

const command = {
  type: 'prompt',
  name: 'autofix-pr',
  description: 'Address open review feedback on the current PR',
  allowedTools: ALLOWED_TOOLS,
  contentLength: 0,
  progressMessage: 'autofixing PR comments',
  source: 'builtin',
  isEnabled: () => true,
  async getPromptForCommand(
    args: string,
    context: ToolUseContext,
  ): Promise<ContentBlockParam[]> {
    const { prNumber, branch, defaultBranch } =
      await assertAutofixPreconditions()
    const { dryRun, rest } = parseArgs(args ?? '')

    const promptText = buildAutofixPrompt({
      mode: dryRun ? 'dry-run' : 'default',
      prNumber,
      branch,
      defaultBranch,
      args: rest,
    })

    const finalContent = await executeShellCommandsInPrompt(
      promptText,
      {
        ...context,
        getAppState() {
          const appState = context.getAppState()
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                command: ALLOWED_TOOLS,
              },
            },
          }
        },
      },
      '/autofix-pr',
    )
    return [{ type: 'text', text: finalContent }]
  },
} satisfies Command

export default command
