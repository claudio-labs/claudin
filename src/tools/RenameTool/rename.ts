// Orchestration for the Rename tool: input validation, permission resolution
// (over the file set discovery resolves), the mechanical rewrite, and the
// atomic commit. Free of any `ink`/UI import so it stays unit-testable under
// `bun test`; the thin Tool definition lives in RenameTool.ts.

import type { UUID } from 'crypto'
import { createHash } from 'crypto'

import type { ToolUseContext, ValidationResult } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { checkBatchWritePermission } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  BATCH_CONFIRM_THRESHOLD,
  commitStagedChanges,
  type DiagnosticAttachment,
  readFileForStaging,
  type StagedChange,
  stageContentReplacement,
} from '../shared/stagedWrite/stagedWrite.js'
import { findSites, isValidIdentifier, type RenameSite } from './findSites.js'
import { RENAME_TOOL_NAME } from './prompt.js'
import { renderPreview } from './renderPreview.js'

export type RenameInput = {
  symbol: string
  replacement: string
  scope?: string
  mode?: 'apply' | 'preview'
  exclude?: string[]
  sitesToken?: string
}

export type RenameFileResult = {
  relPath: string
  sites: number
}

export type RenameOutput =
  | {
      type: 'preview'
      text: string
      siteCount: number
      fileCount: number
    }
  | {
      type: 'apply'
      symbol: string
      replacement: string
      files: RenameFileResult[]
      siteCount: number
      excluded: number
      skippedMasked: number
      /**
       * Files renamed without a string/comment mask — an unsupported language,
       * or one too large to analyze. Every occurrence in them was rewritten,
       * including the ones in strings and comments, so the apply summary has
       * to say so: unlike a preview, there is no `~` column to notice.
       */
      unparsedFiles: string[]
      /** Candidates ripgrep matched that could not be read. */
      unreadable: string[]
    }

/**
 * File set each permission decision was taken over, keyed by the input it was
 * taken for. `call()` re-discovers (the tree can move between the two), and a
 * file that appeared in between was never approved — so the entry is what makes
 * that drift detectable instead of silently written.
 *
 * Entries are left for the TTL to reap rather than consumed on use: the harness
 * takes a fresh permission decision for every call, so an entry never grants
 * anything on its own, and keeping it means two identical calls in flight are
 * both checked instead of the second silently skipping the check.
 */
const approvedFiles = new Map<string, { files: Set<string>; at: number }>()

const APPROVAL_TTL_MS = 5 * 60_000

function approvalKey(input: RenameInput, cwd: string): string {
  return createHash('sha256')
    .update(
      [cwd, input.symbol, input.replacement, input.scope ?? ''].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 16)
}

function pruneApprovals(now: number): void {
  for (const [key, entry] of approvedFiles) {
    if (now - entry.at > APPROVAL_TTL_MS) approvedFiles.delete(key)
  }
}

function fail(message: string, errorCode = 1): ValidationResult {
  return { result: false, message, errorCode }
}

export function validateRenameInput(input: RenameInput): ValidationResult {
  if (!isValidIdentifier(input.symbol)) {
    return fail(
      `${RENAME_TOOL_NAME}: "${input.symbol}" is not an identifier. This tool renames a single whole-word identifier — use Grep + Patch for anything pattern-shaped.`,
    )
  }
  if (!isValidIdentifier(input.replacement)) {
    return fail(
      `${RENAME_TOOL_NAME}: "${input.replacement}" is not a valid identifier.`,
    )
  }
  if (input.symbol === input.replacement) {
    return fail(`${RENAME_TOOL_NAME}: symbol and replacement are identical.`)
  }
  if (input.exclude?.length && !input.sitesToken) {
    return fail(
      `${RENAME_TOOL_NAME}: \`exclude\` needs the \`sitesToken\` from the preview that produced those ids — site ids are only stable within one preview.`,
      2,
    )
  }
  return { result: true }
}

/**
 * Resolves the write permission over the files discovery says will change.
 * Preview writes nothing, so it never prompts.
 */
export async function checkRenamePermissions(
  input: RenameInput,
  context: ToolUseContext,
): Promise<PermissionDecision> {
  if (input.mode === 'preview') {
    return { behavior: 'allow', updatedInput: input }
  }

  const cwd = getCwd()
  const found = await findSites({
    symbol: input.symbol,
    scope: input.scope,
    cwd,
    abortSignal: context.abortController.signal,
  })
  const paths = filterExcluded(found.sites, input).map(s => s.absPath)
  const unique = [...new Set(paths)]

  const decision = checkBatchWritePermission(
    RENAME_TOOL_NAME,
    unique,
    context.getAppState().toolPermissionContext,
    { confirmThreshold: BATCH_CONFIRM_THRESHOLD },
  )

  if (decision.behavior === 'allow') {
    const now = Date.now()
    pruneApprovals(now)
    approvedFiles.set(approvalKey(input, cwd), {
      files: new Set(unique),
      at: now,
    })
    // checkBatchWritePermission validates a synthetic per-path input, so its
    // `allow` carries `updatedInput: {}` — the harness applies that verbatim and
    // would wipe the real input before call(). Echo ours back.
    return { ...decision, updatedInput: input }
  }
  return decision
}

function filterExcluded(sites: RenameSite[], input: RenameInput): RenameSite[] {
  if (!input.exclude?.length) return sites
  const drop = new Set(input.exclude)
  return sites.filter(s => !drop.has(s.id))
}

/**
 * Rewrites `source`, replacing `symbol` at each (ascending) offset.
 *
 * Every offset is re-checked against the text it is about to splice. Discovery
 * and this rewrite read the file separately, so the offsets are only as good as
 * the file standing still in between; a mismatch means it did not, and the
 * throw aborts the whole batch before anything is written.
 */
export function rewriteSource(
  source: string,
  offsets: number[],
  symbol: string,
  replacement: string,
): string {
  const parts: string[] = []
  let cursor = 0
  for (const at of offsets) {
    if (!source.startsWith(symbol, at)) {
      throw new Error(
        `offset ${at} no longer holds "${symbol}" — the file changed under the rename.`,
      )
    }
    parts.push(source.slice(cursor, at), replacement)
    cursor = at + symbol.length
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}

export async function runRename(
  input: RenameInput,
  context: ToolUseContext,
  messageId: UUID,
): Promise<{ output: RenameOutput; newMessages: DiagnosticAttachment[] }> {
  const cwd = getCwd()
  const found = await findSites({
    symbol: input.symbol,
    scope: input.scope,
    cwd,
    abortSignal: context.abortController.signal,
  })

  if (input.mode === 'preview') {
    return {
      output: {
        type: 'preview',
        text: renderPreview(found, input),
        siteCount: found.sites.length,
        fileCount: found.files.length,
      },
      newMessages: [],
    }
  }

  if (input.exclude?.length) {
    if (input.sitesToken !== found.sitesToken) {
      throw new Error(
        `${RENAME_TOOL_NAME}: the tree changed since that preview (sitesToken ${input.sitesToken} is now ${found.sitesToken}), so those site ids no longer point at the same places. Re-run mode:"preview" and pick again.`,
      )
    }
    const known = new Set(found.sites.map(s => s.id))
    const unknown = input.exclude.filter(id => !known.has(id))
    if (unknown.length > 0) {
      throw new Error(
        `${RENAME_TOOL_NAME}: no such site id: ${unknown.join(', ')}.`,
      )
    }
  }

  const sites = filterExcluded(found.sites, input)
  const excluded = found.sites.length - sites.length

  if (sites.length === 0) {
    return {
      output: {
        type: 'apply',
        symbol: input.symbol,
        replacement: input.replacement,
        files: [],
        siteCount: 0,
        excluded,
        skippedMasked: found.skippedMasked,
        unparsedFiles: [],
        unreadable: found.unreadable,
      },
      newMessages: [],
    }
  }

  const byFile = new Map<string, RenameSite[]>()
  for (const site of sites) {
    const list = byFile.get(site.absPath)
    if (list) list.push(site)
    else byFile.set(site.absPath, [site])
  }

  const approval = approvedFiles.get(approvalKey(input, cwd))
  // Fail closed. A missing entry means the permission pass did not complete
  // normally — it threw (the harness catches and falls back to passthrough),
  // or the TTL lapsed while the prompt sat open — so there is no approved file
  // set to compare against and nothing here is safe to write.
  if (!approval) {
    throw new Error(
      `${RENAME_TOOL_NAME}: the approved file set for this call is no longer on record, so the write cannot be checked against it. Nothing was written — run the tool again.`,
    )
  }
  const unapproved = [...byFile.keys()].filter(p => !approval.files.has(p))
  if (unapproved.length > 0) {
    throw new Error(
      `${RENAME_TOOL_NAME}: ${unapproved.length} file(s) started matching "${input.symbol}" after this call was approved (${unapproved.join(
        ', ',
      )}). Nothing was written — run the tool again.`,
    )
  }

  // Phase 1 — stage every file in memory, so a failure writes nothing.
  const staged: StagedChange[] = []
  const stageErrors: string[] = []
  const fileResults: RenameFileResult[] = []
  for (const [absPath, fileSites] of byFile) {
    try {
      // Discovery and staging read through the same LF-normalizing reader, so
      // the offsets stay valid. This exact read is handed to
      // stageContentReplacement as the base: the commit-time check compares
      // disk against it, so an edit landing after it is caught instead of
      // being overwritten by content derived from a stale snapshot.
      const current = readFileForStaging(absPath)
      if (!current.fileExists) {
        throw new Error(`${absPath} no longer exists.`)
      }
      const change = stageContentReplacement(
        absPath,
        rewriteSource(
          current.content,
          fileSites.map(s => s.offset),
          input.symbol,
          input.replacement,
        ),
        current,
      )
      staged.push(change)
      fileResults.push({
        relPath: fileSites[0]!.relPath,
        sites: fileSites.length,
      })
    } catch (e) {
      stageErrors.push(e instanceof Error ? e.message : String(e))
    }
  }
  if (stageErrors.length > 0) {
    throw new Error(
      `${RENAME_TOOL_NAME} could not stage ${stageErrors.length} of ${byFile.size} file(s) — nothing was written:\n` +
        stageErrors.map(m => `  • ${m}`).join('\n'),
    )
  }

  // Phases 2 & 3 — atomic commit with rollback, then post-write wiring. The
  // model never saw these files, so they are marked as a partial view: a later
  // hand-edit has to Read first.
  const { newMessages } = await commitStagedChanges(staged, context, messageId, {
    markReadStatePartial: true,
  })

  return {
    output: {
      type: 'apply',
      symbol: input.symbol,
      replacement: input.replacement,
      files: fileResults,
      siteCount: sites.length,
      excluded,
      skippedMasked: found.skippedMasked,
      unparsedFiles: [
        ...new Set(sites.filter(s => s.unparsed).map(s => s.relPath)),
      ],
      unreadable: found.unreadable,
    },
    newMessages,
  }
}

export function summarizeRename(output: RenameOutput): string {
  if (output.type === 'preview') return output.text

  if (output.siteCount === 0) {
    return `No site was renamed${output.excluded > 0 ? ` (${output.excluded} excluded)` : ''}.`
  }

  const lines = [
    `Renamed "${output.symbol}" → "${output.replacement}" at ${output.siteCount} site(s) in ${output.files.length} file(s):`,
  ]
  for (const file of output.files) {
    lines.push(`  ${file.relPath}  ${file.sites} site(s)`)
  }
  if (output.excluded > 0) lines.push(`Excluded ${output.excluded} site(s).`)
  if (output.skippedMasked > 0) {
    lines.push(
      `Left ${output.skippedMasked} occurrence(s) inside strings/comments untouched.`,
    )
  }
  if (output.unparsedFiles.length > 0) {
    lines.push(
      `No string/comment analysis for ${output.unparsedFiles.join(', ')} — occurrences in strings and comments there WERE renamed.`,
    )
  }
  if (output.unreadable.length > 0) {
    lines.push(
      `Could not read ${output.unreadable.length} matching file(s), left untouched: ${output.unreadable.join(', ')}.`,
    )
  }
  return lines.join('\n')
}
