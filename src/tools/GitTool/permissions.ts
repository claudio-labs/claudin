import type { ToolUseContext } from '../../Tool.js'
import type { PermissionResult } from '../../types/permissions.js'
import { bashToolHasPermission } from '../BashTool/bashPermissions.js'

/**
 * Permission delegation.
 *
 * Every element is checked by `bashToolHasPermission` — the ~900-line pipeline
 * behind BashTool (tree-sitter parse, semantics check, sandbox auto-allow,
 * exact/prefix/wildcard rules, the classifier, path constraints, the cd+git
 * bare-repository guard, injection checks). Re-implementing any part of it
 * here would be a security regression, and delegating means a user's existing
 * `Bash(git push:*)` rules keep working with no migration and no second
 * namespace to maintain.
 *
 * The whole batch is decided BEFORE anything runs: one denied element refuses
 * the call outright rather than letting the earlier commands land first.
 */
export async function checkGitBatchPermission(
  input: { commands: string[] },
  context: ToolUseContext,
): Promise<PermissionResult> {
  const decisions = await Promise.all(
    input.commands.map(command => bashToolHasPermission({ command }, context)),
  )

  // Deny wins over ask wherever it appears in the list, not just first.
  const denied = decisions.find(d => d.behavior === 'deny')
  if (denied) return denied

  const needsUser = decisions.find(d => d.behavior !== 'allow')
  // Returned verbatim so the dialog gets Bash's own rule suggestions
  // (`Bash(git push:*)`) instead of a tool-wide grant.
  if (needsUser) return needsUser

  // NEVER Bash's `updatedInput`: it is `{ command }`-shaped and the harness
  // applies it verbatim, which would replace our `commands` list with a single
  // `command` field the schema does not have — the bug that made apply_patch
  // dead on arrival in auto/bypass mode. Echo our own input.
  return { behavior: 'allow', updatedInput: input }
}
