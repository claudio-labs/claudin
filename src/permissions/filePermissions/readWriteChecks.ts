import type { z } from 'zod/v4'
import type { AnyObject, Tool, ToolPermissionContext } from 'src/tools/Tool.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { pathlessToolMessage } from 'src/permissions/filePermissions/fileChecks/messages.js'
import { decideRead } from 'src/permissions/filePermissions/fileChecks/readCheck.js'
import { suggestionsFor } from 'src/permissions/filePermissions/fileChecks/suggestions.js'
import { resolveTarget } from 'src/permissions/filePermissions/fileChecks/target.js'
import { decideWrite, editDenyRuleFor } from 'src/permissions/filePermissions/fileChecks/writeCheck.js'

// The checks live in ./fileChecks/ as ordered steps over one resolved path;
// this file keeps the exported names where their callers import them.

function askAboutPathlessTool(toolName: string): PermissionDecision {
  return { behavior: 'ask', message: pathlessToolMessage(toolName) }
}

export function checkReadPermissionForTool(
  tool: Tool,
  input: { [key: string]: unknown },
  toolPermissionContext: ToolPermissionContext,
): PermissionDecision {
  if (!tool.getPath) return askAboutPathlessTool(tool.name)
  return decideRead({
    target: resolveTarget(tool.getPath(input)),
    input,
    context: toolPermissionContext,
  })
}

export function checkWritePermissionForTool<Input extends AnyObject>(
  tool: Tool<Input>,
  input: z.infer<Input>,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionDecision {
  if (!tool.getPath) return askAboutPathlessTool(tool.name)
  return decideWrite({
    target: resolveTarget(tool.getPath(input), precomputedPathsToCheck),
    input,
    context: toolPermissionContext,
  })
}

function pathList(paths: readonly string[]): string {
  return paths.map(path => `  - ${path}`).join('\n')
}

function filesWord(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`
}

function batchWriteDenied(paths: readonly string[]): PermissionDecision {
  return {
    behavior: 'deny',
    message: `Permission to write to the following paths has been denied:\n${pathList(paths)}`,
    decisionReason: { type: 'other', reason: 'batch deny' },
  }
}

/**
 * One write verdict for a batch (an ApplyPatch, a Rename, an LSP
 * WorkspaceEdit): each path goes through the write check. Any deny denies,
 * naming the denied paths, and the caller writes nothing. Else any ask makes
 * one ask naming the asking paths. Else a batch at or over the caller's
 * `confirmThreshold` still asks, because fifty files at once are not one edit.
 *
 * bypassPermissions skips the prompts, the threshold included, but not the
 * `Edit` deny rules (F5): a deny holds in every mode.
 */
export function checkBatchWritePermission(
  toolName: string,
  paths: readonly string[],
  toolPermissionContext: ToolPermissionContext,
  options?: { confirmThreshold?: number },
): PermissionDecision {
  if (toolPermissionContext.mode === 'bypassPermissions') {
    const denied = paths.filter(
      path => editDenyRuleFor(resolveTarget(path), toolPermissionContext) !== null,
    )
    if (denied.length > 0) return batchWriteDenied(denied)
    return {
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'mode', mode: 'bypassPermissions' },
    }
  }

  const denied: string[] = []
  const asked: string[] = []
  for (const path of paths) {
    const decision = decideWrite({
      target: resolveTarget(path),
      input: { file_path: path },
      context: toolPermissionContext,
    })
    if (decision.behavior === 'deny') denied.push(path)
    else if (decision.behavior === 'ask') asked.push(path)
  }

  if (denied.length > 0) return batchWriteDenied(denied)
  if (asked.length > 0) {
    return {
      behavior: 'ask',
      message: `Claude requested permissions to write to ${filesWord(asked.length)}:\n${pathList(asked)}`,
      decisionReason: { type: 'other', reason: 'batch ask' },
    }
  }

  const threshold = options?.confirmThreshold
  if (threshold !== undefined && threshold > 0 && paths.length >= threshold) {
    return {
      behavior: 'ask',
      message: `Batch write touches ${filesWord(paths.length)} (threshold ${threshold}):\n${pathList(paths)}`,
      decisionReason: { type: 'other', reason: 'batch threshold' },
    }
  }

  return {
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'other', reason: 'batch allow' },
  }
}

/**
 * One read verdict for the files of a batch Read (`file_paths`). Each path
 * goes through the read check exactly as a Read of that one file would.
 *
 * - Any path denied: deny, naming the denied paths, with the first denial's
 *   reason.
 * - Else any path asks: one ask naming every asking path. It keeps the first
 *   rule-backed reason when there is one, because the decision core honours
 *   an ask RULE even under bypassPermissions, and a generic reason would let
 *   the batch read a file a single Read would have asked about.
 * - Else allow.
 *
 * There is no bypassPermissions shortcut here: the mode is applied by the
 * decision core, after the deny and ask rules a shortcut would skip.
 *
 * `input` is the tool's real input, handed back on allow. The harness applies
 * `updatedInput` over the call's input, so `{}` would erase the batch.
 */
export function checkBatchReadPermission(
  toolName: string,
  paths: readonly string[],
  input: { [key: string]: unknown },
  toolPermissionContext: ToolPermissionContext,
): PermissionDecision {
  type Verdict<B> = { path: string; decision: PermissionDecision & { behavior: B } }
  const denied: Verdict<'deny'>[] = []
  const asked: Verdict<'ask'>[] = []
  for (const path of paths) {
    const decision = decideRead({
      target: resolveTarget(path),
      input: { file_path: path },
      context: toolPermissionContext,
    })
    if (decision.behavior === 'deny') denied.push({ path, decision })
    else if (decision.behavior === 'ask') asked.push({ path, decision })
  }

  const [firstDenied] = denied
  if (firstDenied) {
    return {
      behavior: 'deny',
      message: `Permission to read the following paths has been denied:\n${pathList(denied.map(d => d.path))}`,
      decisionReason: firstDenied.decision.decisionReason,
    }
  }

  const [firstAsked] = asked
  if (firstAsked) {
    const binding = asked.find(a => a.decision.decisionReason?.type === 'rule') ?? firstAsked
    return {
      behavior: 'ask',
      message: `Claude requested permissions to read ${filesWord(asked.length)}:\n${pathList(asked.map(a => a.path))}`,
      decisionReason: binding.decision.decisionReason,
    }
  }

  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'other', reason: 'batch allow' },
  }
}

export function generateSuggestions(
  filePath: string,
  operationType: 'read' | 'write' | 'create',
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionUpdate[] {
  return suggestionsFor(filePath, operationType, toolPermissionContext, precomputedPathsToCheck)
}
