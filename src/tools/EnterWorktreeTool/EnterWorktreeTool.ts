import { z } from 'zod/v4'
import { getSessionId, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { clearSystemPromptSections } from 'src/constants/systemPromptSections.js'
import { logEvent } from 'src/platform/analytics/index.js'
import type { Tool } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { clearMemoryFileCaches } from 'src/services/instructions/claudemd.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { findCanonicalGitRoot } from 'src/services/git/git.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { getPlanSlug, getPlansDirectory } from 'src/utils/plans.js'
import { setCwd } from 'src/shared/proc/Shell.js'
import { saveWorktreeState } from 'src/services/session/sessionStorage.js'
import {
  attachExistingWorktree,
  createWorktreeForSession,
  getCurrentWorktreeSession,
  validateWorktreeSlug,
} from 'src/services/git/worktree.js'
import { ENTER_WORKTREE_TOOL_NAME } from 'src/tools/EnterWorktreeTool/constants.js'
import { getEnterWorktreeToolPrompt } from 'src/tools/EnterWorktreeTool/prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from 'src/tools/EnterWorktreeTool/UI.js'

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      name: z
        .string()
        .superRefine((s, ctx) => {
          try {
            validateWorktreeSlug(s)
          } catch (e) {
            ctx.addIssue({ code: 'custom', message: (e as Error).message })
          }
        })
        .optional()
        .describe(
          'Optional name for a new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with `path`.',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Path to an existing worktree of the current repository to enter instead of creating one. Must appear in `git worktree list` for the current repo. Mutually exclusive with `name`.',
        ),
    })
    .superRefine((input, ctx) => {
      if (input.name !== undefined && input.path !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            '`name` and `path` are mutually exclusive: pass `name` to create a new worktree, or `path` to enter an existing one.',
        })
      }
    }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: 'create an isolated git worktree and switch into it',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Creates an isolated worktree (via git or configured hooks) and switches the session into it'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Creating worktree'
  },
  shouldDefer: true,
  toAutoClassifierInput(input) {
    return input.name ?? ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    // Validate not already in a worktree created by this session
    if (getCurrentWorktreeSession()) {
      throw new Error('Already in a worktree session')
    }

    // Resolve to main repo root so worktree creation / listing works from
    // within a worktree.
    const mainRepoRoot = findCanonicalGitRoot(getCwd())
    if (mainRepoRoot && mainRepoRoot !== getCwd()) {
      process.chdir(mainRepoRoot)
      setCwd(mainRepoRoot)
    }

    // `path` enters a pre-existing worktree (attach); otherwise create a new one.
    const worktreeSession =
      input.path !== undefined
        ? await attachExistingWorktree(input.path, getSessionId())
        : await createWorktreeForSession(
            getSessionId(),
            input.name ?? getPlanSlug(),
          )

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    saveWorktreeState(worktreeSession)
    // Clear cached system prompt sections so env_info_simple recomputes with worktree context
    clearSystemPromptSections()
    // Clear memoized caches that depend on CWD
    clearMemoryFileCaches()
    getPlansDirectory.cache.clear?.()

    logEvent('tengu_worktree_created', {
      mid_session: true,
    })

    const branchInfo = worktreeSession.worktreeBranch
      ? ` on branch ${worktreeSession.worktreeBranch}`
      : ''

    const message = worktreeSession.attached
      ? `Entered existing worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in it. Use ExitWorktree (action: "keep") to return to the original directory — ExitWorktree will not remove a worktree entered this way.`
      : `Created worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`

    return {
      data: {
        worktreePath: worktreeSession.worktreePath,
        worktreeBranch: worktreeSession.worktreeBranch,
        message,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
