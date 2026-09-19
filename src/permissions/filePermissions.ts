import type { z } from 'zod/v4'
import { getPathsForPermissionCheck } from 'src/shared/fs/fsOperations.js'
import { expandPath, getDirectoryForPath } from 'src/shared/fs/path.js'
import type { AnyObject, Tool, ToolPermissionContext } from 'src/tools/Tool.js'
import {
  CLAUDE_FOLDER_PERMISSION_PATTERN,
  FILE_EDIT_TOOL_NAME,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
} from 'src/tools/FileEditTool/constants.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from 'src/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import {
  checkPathSafetyForAutoEdit,
  hasSuspiciousWindowsPathPattern,
} from 'src/permissions/filePermissions/dangerousPaths.js'
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
  getClaudeSkillScope,
} from 'src/permissions/filePermissions/internalPaths.js'
import { matchingRuleForInput } from 'src/permissions/filePermissions/rulePatterns.js'
import { pathInAllowedWorkingPath } from 'src/permissions/filePermissions/workingDirs.js'

export { checkPathSafetyForAutoEdit } from 'src/permissions/filePermissions/dangerousPaths.js'
export {
  checkEditableInternalPath,
  checkReadableInternalPath,
  isClaudeSettingsPath,
} from 'src/permissions/filePermissions/internalPaths.js'
export { normalizeCaseForComparison } from 'src/permissions/filePermissions/pathCase.js'
export {
  getFileReadIgnorePatterns,
  matchingRuleForInput,
  normalizePatternsToPath,
} from 'src/permissions/filePermissions/rulePatterns.js'
export {
  allWorkingDirectories,
  pathInAllowedWorkingPath,
  pathInWorkingPath,
} from 'src/permissions/filePermissions/workingDirs.js'

/**
 * Permission result for read permission for the specified tool & tool input
 */
export function checkReadPermissionForTool(
  tool: Tool,
  input: { [key: string]: unknown },
  toolPermissionContext: ToolPermissionContext,
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${tool.name}, but you haven't granted it yet.`,
    }
  }
  // Resolve relative paths against the session cwd before matching permission
  // rules. Without expandPath, a relative getPath() stays relative and later
  // resolves against the process cwd (via realpath), so allow/deny rules are
  // evaluated against a different absolute path than what is actually read —
  // wrong in worktree/bridge/scoped sessions where the two cwds diverge.
  const path = expandPath(tool.getPath(input))

  // Get paths to check (includes both original and resolved symlinks).
  // Computed once here and threaded through checkWritePermissionForTool →
  // checkPathSafetyForAutoEdit → pathInAllowedWorkingPath to avoid redundant
  // existsSync/lstatSync/realpathSync syscalls on the same path (previously
  // 6× = 30 syscalls per Read permission check).
  const pathsToCheck = getPathsForPermissionCheck(path)

  // 1. Defense-in-depth: Block UNC paths early (before other checks)
  // This catches paths starting with \\ or // that could access network resources
  // This may catch some UNC patterns not detected by containsVulnerableUncPath
  for (const pathToCheck of pathsToCheck) {
    if (pathToCheck.startsWith('\\\\') || pathToCheck.startsWith('//')) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to read from ${path}, which appears to be a UNC path that could access network resources.`,
        decisionReason: {
          type: 'other',
          reason: 'UNC path detected (defense-in-depth check)',
        },
      }
    }
  }

  // 2. Check for suspicious Windows path patterns (defense in depth)
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to read from ${path}, which contains a suspicious Windows path pattern that requires manual approval.`,
        decisionReason: {
          type: 'other',
          reason:
            'Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, or three or more consecutive dots) that require manual verification',
        },
      }
    }
  }

  // 3. Check for READ-SPECIFIC deny rules first - check both the original path and resolved symlink path
  // SECURITY: This must come before any allow checks (including "edit access implies read access")
  // to prevent bypassing explicit read deny rules
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `Permission to read ${path} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 4. Check for READ-SPECIFIC ask rules - check both the original path and resolved symlink path
  // SECURITY: This must come before implicit allow checks to ensure explicit ask rules are honored
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'read',
      'ask',
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to read from ${path}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 5. Edit access implies read access (but only if no read-specific deny/ask rules exist)
  // We check this after read-specific rules so that explicit read restrictions take precedence
  const editResult = checkWritePermissionForTool(
    tool,
    input,
    toolPermissionContext,
    pathsToCheck,
  )
  if (editResult.behavior === 'allow') {
    return editResult
  }

  // 6. Allow reads in working directories
  const isInWorkingDir = pathInAllowedWorkingPath(
    path,
    toolPermissionContext,
    pathsToCheck,
  )
  if (isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: 'default',
      },
    }
  }

  // 7. Allow reads from internal harness paths (session-memory, plans, tool-results)
  const absolutePath = expandPath(path)
  const internalReadResult = checkReadableInternalPath(absolutePath, input)
  if (internalReadResult.behavior !== 'passthrough') {
    return internalReadResult
  }

  // 8. Check for allow rules
  const allowRule = matchingRuleForInput(
    path,
    toolPermissionContext,
    'read',
    'allow',
  )
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 12. Default to asking for permission
  // At this point, isInWorkingDir is false (from step #6), so path is outside working directories
  return {
    behavior: 'ask',
    message: `Claude requested permissions to read from ${path}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(
      path,
      'read',
      toolPermissionContext,
      pathsToCheck,
    ),
    decisionReason: {
      type: 'workingDir',
      reason: 'Path is outside allowed working directories',
    },
  }
}

/**
 * Permission result for write permission for the specified tool & tool input.
 *
 * @param precomputedPathsToCheck - Optional cached result of
 *   `getPathsForPermissionCheck(tool.getPath(input))`. Callers MUST derive this
 *   from the same `tool` and `input` in the same synchronous frame — `path` is
 *   re-derived internally for error messages and internal-path checks, so a
 *   stale value would silently check deny rules for the wrong path.
 */
export function checkWritePermissionForTool<Input extends AnyObject>(
  tool: Tool<Input>,
  input: z.infer<Input>,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${tool.name}, but you haven't granted it yet.`,
    }
  }
  const path = tool.getPath(input)

  // 1. Check for deny rules - check both the original path and resolved symlink path
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `Permission to edit ${path} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 1.5. Allow writes to internal editable paths (plan files, scratchpad)
  // This MUST come before isDangerousFilePathToAutoEdit check since .claudin is a dangerous directory
  const absolutePathForEdit = expandPath(path)
  const internalEditResult = checkEditableInternalPath(
    absolutePathForEdit,
    input,
  )
  if (internalEditResult.behavior !== 'passthrough') {
    return internalEditResult
  }

  // 1.6. Check for .claudin/** allow rules BEFORE safety checks
  // This allows session-level permissions to bypass the safety blocks for .claudin/
  // We only allow this for session-level rules to prevent users from accidentally
  // permanently granting broad access to their .claudin/ folder.
  //
  // matchingRuleForInput returns the first match across all sources. If the user
  // also has a broader Edit(.claudin) rule in userSettings (e.g. from sandbox
  // write-allow conversion), that rule would be found first and its source check
  // below would fail. Scope the search to session-only rules so the dialog's
  // "allow Claude to edit its own settings for this session" option actually works.
  const claudeFolderAllowRule = matchingRuleForInput(
    path,
    {
      ...toolPermissionContext,
      alwaysAllowRules: {
        session: toolPermissionContext.alwaysAllowRules.session ?? [],
      },
    },
    'edit',
    'allow',
  )
  if (claudeFolderAllowRule) {
    // Check if this rule is scoped under .claudin/ (project or global).
    // Accepts both the broad patterns ('/.claudin/**', '~/.claudin/**') and
    // narrowed ones like '/.claudin/skills/my-skill/**' so users can grant
    // session access to a single skill without also exposing settings.json
    // or hooks/. The rule already matched the path via matchingRuleForInput;
    // this is an additional scope check. Reject '..' to prevent a rule like
    // '/.claudin/../**' from leaking this bypass outside .claudin/.
    const ruleContent = claudeFolderAllowRule.ruleValue.ruleContent
    if (
      ruleContent &&
      (ruleContent.startsWith(CLAUDE_FOLDER_PERMISSION_PATTERN.slice(0, -2)) ||
        ruleContent.startsWith(
          GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN.slice(0, -2),
        )) &&
      !ruleContent.includes('..') &&
      ruleContent.endsWith('/**')
    ) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'rule',
          rule: claudeFolderAllowRule,
        },
      }
    }
  }

  // 1.7. Check comprehensive safety validations (Windows patterns, Claude config, dangerous files)
  // This MUST come before checking allow rules to prevent users from accidentally granting
  // permission to edit protected files
  const safetyCheck = checkPathSafetyForAutoEdit(path, pathsToCheck)
  if (!safetyCheck.safe) {
    // SDK suggestion: if under .claudin/skills/{name}/, emit the narrowed
    // session-scoped addRules that step 1.6 will honor on the next call.
    // Everything else (.claudin/settings.json, .git/, .vscode/, .idea/) falls
    // back to generateSuggestions — its setMode suggestion doesn't bypass
    // this check, but preserving it avoids a surprising empty array.
    const skillScope = getClaudeSkillScope(path)
    const safetySuggestions: PermissionUpdate[] = skillScope
      ? [
          {
            type: 'addRules',
            rules: [
              {
                toolName: FILE_EDIT_TOOL_NAME,
                ruleContent: skillScope.pattern,
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ]
      : generateSuggestions(path, 'write', toolPermissionContext, pathsToCheck)
    return {
      behavior: 'ask',
      message: safetyCheck.message,
      suggestions: safetySuggestions,
      decisionReason: {
        type: 'safetyCheck',
        reason: safetyCheck.message,
        classifierApprovable: safetyCheck.classifierApprovable,
      },
    }
  }

  // 2. Check for ask rules - check both the original path and resolved symlink path
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'ask',
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 3. If in acceptEdits or sandboxBashMode mode, allow all writes in original cwd
  const isInWorkingDir = pathInAllowedWorkingPath(
    path,
    toolPermissionContext,
    pathsToCheck,
  )
  if (toolPermissionContext.mode === 'acceptEdits' && isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: toolPermissionContext.mode,
      },
    }
  }

  // 4. Check for allow rules
  const allowRule = matchingRuleForInput(
    path,
    toolPermissionContext,
    'edit',
    'allow',
  )
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 5. Default to asking for permission
  return {
    behavior: 'ask',
    message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(
      path,
      'write',
      toolPermissionContext,
      pathsToCheck,
    ),
    decisionReason: !isInWorkingDir
      ? {
          type: 'workingDir',
          reason: 'Path is outside allowed working directories',
        }
      : undefined,
  }
}

/**
 * Aggregated write-permission check across N paths for batch operations
 * (e.g. an LSP WorkspaceEdit that touches multiple files in one go).
 *
 * Semantics:
 * - If ANY path resolves to `deny` → returns `deny` listing the blocked paths
 *   (the caller must abort without writing anything).
 * - Else if ANY path resolves to `ask` → returns a single `ask` covering the
 *   full set, with the per-path messages joined for the prompt.
 * - Else → `allow`.
 *
 * Implemented by delegating to `checkWritePermissionForTool` per-path using a
 * synthetic tool wrapper, so all existing rules (deny / ask / acceptEdits /
 * safety checks / internal paths) are honored identically.
 */
export function checkBatchWritePermission(
  toolName: string,
  paths: readonly string[],
  toolPermissionContext: ToolPermissionContext,
  options?: { confirmThreshold?: number },
): PermissionDecision {
  // bypassPermissions opts out of every prompt. Honor the bypass directly so
  // per-path 'ask' results inside a working directory don't surface as
  // prompts even when invoked from a tool's checkPermissions preflight.
  if (toolPermissionContext.mode === 'bypassPermissions') {
    return {
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'mode', mode: 'bypassPermissions' },
    }
  }
  type SyntheticInput = { file_path: string }
  const denied: { path: string; message: string }[] = []
  const asked: { path: string; message: string }[] = []

  for (const p of paths) {
    const syntheticTool = {
      name: toolName,
      getPath(input: SyntheticInput): string {
        return input.file_path
      },
    } as unknown as Tool<z.ZodType<SyntheticInput>>
    const decision = checkWritePermissionForTool(
      syntheticTool,
      { file_path: p },
      toolPermissionContext,
    )
    if (decision.behavior === 'deny') {
      denied.push({ path: p, message: decision.message })
    } else if (decision.behavior === 'ask') {
      asked.push({ path: p, message: decision.message })
    }
  }

  if (denied.length > 0) {
    return {
      behavior: 'deny',
      message: `Permission to write to the following paths has been denied:\n${denied
        .map(d => `  - ${d.path}`)
        .join('\n')}`,
      decisionReason: { type: 'other', reason: 'batch deny' },
    }
  }

  if (asked.length > 0) {
    return {
      behavior: 'ask',
      message: `Claude requested permissions to write to ${asked.length} file${asked.length === 1 ? '' : 's'}:\n${asked
        .map(a => `  - ${a.path}`)
        .join('\n')}`,
      decisionReason: { type: 'other', reason: 'batch ask' },
    }
  }

  // Even when every individual path is auto-approved (e.g. acceptEdits mode),
  // a large batch should still prompt — a 50-file rename is qualitatively
  // different from a single edit. Threshold is opt-in and passed through by
  // the caller as options.confirmThreshold.
  // bypassPermissions explicitly opts out of all prompts, and is already
  // returned above, so the threshold cannot reintroduce one there.
  if (
    options?.confirmThreshold !== undefined &&
    options.confirmThreshold > 0 &&
    paths.length >= options.confirmThreshold
  ) {
    return {
      behavior: 'ask',
      message: `Batch write touches ${paths.length} file${paths.length === 1 ? '' : 's'} (threshold ${options.confirmThreshold}):\n${paths
        .map(p => `  - ${p}`)
        .join('\n')}`,
      decisionReason: { type: 'other', reason: 'batch threshold' },
    }
  }

  return {
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'other', reason: 'batch allow' },
  }
}

export function generateSuggestions(
  filePath: string,
  operationType: 'read' | 'write' | 'create',
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionUpdate[] {
  const isOutsideWorkingDir = !pathInAllowedWorkingPath(
    filePath,
    toolPermissionContext,
    precomputedPathsToCheck,
  )

  if (operationType === 'read' && isOutsideWorkingDir) {
    // For read operations outside working directories, add Read rules
    // IMPORTANT: Include both the symlink path and resolved path so subsequent checks pass
    const dirPath = getDirectoryForPath(filePath)
    const dirsToAdd = getPathsForPermissionCheck(dirPath)

    const suggestions = dirsToAdd
      .map(dir => createReadRuleSuggestion(dir, 'session'))
      .filter((s): s is PermissionUpdate => s !== undefined)

    return suggestions
  }

  // Only suggest setMode:acceptEdits when it would be an upgrade. In auto
  // mode the classifier already auto-approves edits; in bypassPermissions
  // everything is allowed; in acceptEdits it's a no-op. Suggesting it
  // anyway and having the SDK host apply it on "Always allow" silently
  // downgrades auto → acceptEdits, which then prompts for MCP/Bash.
  const shouldSuggestAcceptEdits =
    toolPermissionContext.mode === 'default' ||
    toolPermissionContext.mode === 'plan'

  if (operationType === 'write' || operationType === 'create') {
    const updates: PermissionUpdate[] = shouldSuggestAcceptEdits
      ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
      : []

    if (isOutsideWorkingDir) {
      // For write operations outside working directories, also add the directory
      // IMPORTANT: Include both the symlink path and resolved path so subsequent checks pass
      const dirPath = getDirectoryForPath(filePath)
      const dirsToAdd = getPathsForPermissionCheck(dirPath)

      updates.push({
        type: 'addDirectories',
        directories: dirsToAdd,
        destination: 'session',
      })
    }

    return updates
  }

  // For read operations inside working directories, just change mode
  return shouldSuggestAcceptEdits
    ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    : []
}
