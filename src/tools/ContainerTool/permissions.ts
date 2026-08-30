// Permission delegation, mirroring GitTool/permissions.ts.
//
// Every op is checked by `bashToolHasPermission` against the exact command
// `buildContainerCommand` produced — the same string the runner will execute as
// argv. Re-implementing any of that ~900-line pipeline (tree-sitter parse,
// sandbox auto-allow, exact/prefix/wildcard rules, the classifier, injection
// checks) would be a security regression, and delegating means a user's
// existing `Bash(docker compose up:*)` rules keep working with no migration and
// no second namespace to maintain.

import type { ToolUseContext } from 'src/tools/Tool.js'
import type { PermissionResult } from 'src/shared/types/permissions.js'
import { bashToolHasPermission } from 'src/tools/BashTool/bashPermissions.js'
import {
  buildContainerCommand,
  ContainerCommandError,
  type BuildCommandContext,
} from 'src/tools/ContainerTool/buildCommand.js'
import {
  isAlwaysAskCommand,
  type BuiltCommand,
  type ContainerToolInput,
} from 'src/tools/ContainerTool/types.js'

/**
 * Decide whether this op may run.
 *
 * Two rules on top of the delegation:
 *
 *  - `prune`, `rm`, `rmi` and any command carrying a data-deleting flag NEVER
 *    return `allow` on their own. They delete data that no `git checkout`
 *    brings back, so an always-allow rule must not be able to wave them
 *    through — the user sees the dialog every time. That decision reads the
 *    BUILT argv, so a flag arriving through `args` counts exactly as much as
 *    one arriving through `volumes`.
 *  - On allow we echo OUR OWN input. Bash's `updatedInput` is `{command}`-shaped
 *    and the harness applies it verbatim, which would replace our `op` with a
 *    `command` field the schema does not have. That is the bug that made
 *    apply_patch dead on arrival in auto/bypass mode.
 */
export async function checkContainerPermission(
  input: ContainerToolInput,
  context: ToolUseContext,
  ctx: BuildCommandContext = {},
): Promise<PermissionResult> {
  let built: BuiltCommand
  try {
    built = buildContainerCommand(input, ctx)
  } catch (e) {
    if (e instanceof ContainerCommandError) {
      return {
        behavior: 'deny',
        message: e.message,
        decisionReason: { type: 'other', reason: e.message },
      }
    }
    throw e
  }
  const command = built.commandString

  const decision = await bashToolHasPermission({ command }, context)

  if (decision.behavior === 'deny') return decision

  if (isAlwaysAskCommand(input.op, built.argv)) {
    // Downgrade an allow to an ask. A deny above still wins.
    if (decision.behavior !== 'allow') return decision
    return {
      behavior: 'ask',
      message: `\`${command}\` deletes data that cannot be recovered.`,
      updatedInput: input as unknown as { [key: string]: unknown },
    }
  }

  if (decision.behavior !== 'allow') return decision

  return {
    behavior: 'allow',
    updatedInput: input as unknown as { [key: string]: unknown },
  }
}
