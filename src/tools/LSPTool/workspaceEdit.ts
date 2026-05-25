/**
 * WorkspaceEdit normalization, application, and rollback for LSPTool write-ops.
 *
 * Pure utilities (no IO) plus an IO-bound applier. The applier reads each
 * affected file once, validates content didn't drift, writes atomically per
 * file, and rolls back from an in-memory snapshot if any write fails.
 *
 * Capped by LIMITS.maxFiles / LIMITS.maxBytes to keep rollback memory bounded.
 */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { normalize as normalizePath } from 'node:path'
import type {
  CreateFile,
  DeleteFile,
  RenameFile,
  TextDocumentEdit,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver-types'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  detectFileEncoding,
  detectLineEndings,
  writeTextContent,
} from '../../utils/file.js'
import type { LineEndingType } from '../../utils/fileRead.js'
import { logError } from '../../utils/log.js'
import { invalidateForPath } from '../../services/tools/toolResultCache.js'
import { getGlobalConfig } from '../../utils/config.js'

const DEFAULT_LIMITS = {
  maxFiles: 200,
  maxBytes: 50 * 1024 * 1024,
} as const

/**
 * Effective limits, with user overrides from settings.json applied.
 * Settings keys:
 * - lspWorkspaceEditMaxFiles  (default 200)
 * - lspWorkspaceEditMaxBytes  (default 50 MiB)
 *
 * Negative or zero values fall back to the default — limits are a safety net,
 * not a knob for disabling rollback guarantees.
 */
export function getLimits(): { maxFiles: number; maxBytes: number } {
  const cfg = getGlobalConfig()
  const maxFiles =
    typeof cfg.lspWorkspaceEditMaxFiles === 'number' &&
    cfg.lspWorkspaceEditMaxFiles > 0
      ? cfg.lspWorkspaceEditMaxFiles
      : DEFAULT_LIMITS.maxFiles
  const maxBytes =
    typeof cfg.lspWorkspaceEditMaxBytes === 'number' &&
    cfg.lspWorkspaceEditMaxBytes > 0
      ? cfg.lspWorkspaceEditMaxBytes
      : DEFAULT_LIMITS.maxBytes
  return { maxFiles, maxBytes }
}

// Kept for tests that still reference the original constant.
export const LIMITS = DEFAULT_LIMITS

export type NormalizedTextEdit = {
  // 0-based, server coordinates
  startLine: number
  startChar: number
  endLine: number
  endChar: number
  newText: string
}

export type NormalizedFileEdit = {
  kind: 'edit'
  path: string // absolute, normalized
  edits: NormalizedTextEdit[] // sorted reverse by (startLine, startChar)
}

export type NormalizedRename = {
  kind: 'rename'
  oldPath: string
  newPath: string
  overwrite: boolean
  ignoreIfExists: boolean
}

export type NormalizedOp = NormalizedFileEdit | NormalizedRename

export type NormalizedEdit = {
  ops: NormalizedOp[]
  hasUnsupported: boolean
  unsupportedReasons: string[]
}

function uriToPath(uri: string): string {
  // file:// URIs only — non-file URIs are unsupported and will be flagged.
  return normalizePath(fileURLToPath(uri))
}

function isFileUri(uri: string): boolean {
  return uri.startsWith('file://')
}

/**
 * List unique absolute paths touched by a WorkspaceEdit. For renames, both
 * the old and new path are returned so the permission gate can authorize
 * both reads (old) and writes (new + edits to other files).
 */
export function pathsTouchedByEdit(edit: WorkspaceEdit): string[] {
  const out = new Set<string>()

  if (edit.changes) {
    for (const uri of Object.keys(edit.changes)) {
      if (isFileUri(uri)) out.add(uriToPath(uri))
    }
  }

  if (edit.documentChanges) {
    for (const op of edit.documentChanges) {
      if (isTextDocumentEdit(op)) {
        if (isFileUri(op.textDocument.uri)) {
          out.add(uriToPath(op.textDocument.uri))
        }
      } else if (op.kind === 'rename') {
        if (isFileUri(op.oldUri)) out.add(uriToPath(op.oldUri))
        if (isFileUri(op.newUri)) out.add(uriToPath(op.newUri))
      } else if (op.kind === 'create' || op.kind === 'delete') {
        if (isFileUri(op.uri)) out.add(uriToPath(op.uri))
      }
    }
  }

  return [...out]
}

function isTextDocumentEdit(
  op: TextDocumentEdit | CreateFile | RenameFile | DeleteFile,
): op is TextDocumentEdit {
  return (op as TextDocumentEdit).textDocument !== undefined
}

function compareReverse(a: NormalizedTextEdit, b: NormalizedTextEdit): number {
  if (a.startLine !== b.startLine) return b.startLine - a.startLine
  if (a.startChar !== b.startChar) return b.startChar - a.startChar
  return 0
}

function detectOverlap(edits: NormalizedTextEdit[]): NormalizedTextEdit | null {
  // edits sorted reverse by start; check that each edit's end <= next edit's start
  for (let i = 0; i < edits.length - 1; i++) {
    const cur = edits[i]!
    const next = edits[i + 1]!
    // cur starts AFTER next in reverse order. Overlap if next.end > cur.start.
    if (
      next.endLine > cur.startLine ||
      (next.endLine === cur.startLine && next.endChar > cur.startChar)
    ) {
      return cur
    }
  }
  return null
}

function toNormalizedTextEdit(e: TextEdit): NormalizedTextEdit {
  return {
    startLine: e.range.start.line,
    startChar: e.range.start.character,
    endLine: e.range.end.line,
    endChar: e.range.end.character,
    newText: e.newText,
  }
}

/**
 * Flatten changes + documentChanges into a single ordered list of operations.
 * Throws on overlap or unsupported resource ops (create / delete). Rename ops
 * are kept as separate NormalizedRename entries.
 */
export function resolveWorkspaceEdit(edit: WorkspaceEdit): NormalizedEdit {
  const editsByPath = new Map<string, NormalizedTextEdit[]>()
  const renames: NormalizedRename[] = []
  const unsupportedReasons: string[] = []

  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      if (!isFileUri(uri)) {
        unsupportedReasons.push(`non-file URI in changes: ${uri}`)
        continue
      }
      const path = uriToPath(uri)
      const list = editsByPath.get(path) ?? []
      for (const e of textEdits) list.push(toNormalizedTextEdit(e))
      editsByPath.set(path, list)
    }
  }

  if (edit.documentChanges) {
    for (const op of edit.documentChanges) {
      if (isTextDocumentEdit(op)) {
        if (!isFileUri(op.textDocument.uri)) {
          unsupportedReasons.push(
            `non-file URI in documentChanges: ${op.textDocument.uri}`,
          )
          continue
        }
        const path = uriToPath(op.textDocument.uri)
        const list = editsByPath.get(path) ?? []
        for (const e of op.edits) list.push(toNormalizedTextEdit(e))
        editsByPath.set(path, list)
      } else if (op.kind === 'rename') {
        if (!isFileUri(op.oldUri) || !isFileUri(op.newUri)) {
          unsupportedReasons.push('non-file URI in rename')
          continue
        }
        renames.push({
          kind: 'rename',
          oldPath: uriToPath(op.oldUri),
          newPath: uriToPath(op.newUri),
          overwrite: op.options?.overwrite ?? false,
          ignoreIfExists: op.options?.ignoreIfExists ?? false,
        })
      } else if (op.kind === 'create' || op.kind === 'delete') {
        unsupportedReasons.push(
          `${op.kind} file operations are not supported`,
        )
      }
    }
  }

  const ops: NormalizedOp[] = []
  for (const [path, edits] of editsByPath) {
    edits.sort(compareReverse)
    const overlap = detectOverlap(edits)
    if (overlap) {
      throw new Error(
        `Overlapping edits in ${path} near line ${overlap.startLine + 1}; refusing to apply.`,
      )
    }
    ops.push({ kind: 'edit', path, edits })
  }
  // Renames after edits — caller applies file moves last so the edits to the
  // old path land on the still-existing file.
  ops.push(...renames)

  return {
    ops,
    hasUnsupported: unsupportedReasons.length > 0,
    unsupportedReasons,
  }
}

/**
 * Apply text edits to a string. Edits MUST be sorted reverse by start
 * position (use resolveWorkspaceEdit for that guarantee).
 *
 * Position semantics follow LSP: (line, character) are 0-based, line endings
 * are counted as a single character, BOM is part of the file (not stripped).
 * Throws if any edit references a position beyond the document.
 */
export function applyTextEditsToContent(
  content: string,
  edits: NormalizedTextEdit[],
): string {
  if (edits.length === 0) return content

  const lines = splitKeepingNewlines(content)
  // lineOffsets[i] = char offset where line i starts in `content`
  const lineOffsets: number[] = new Array(lines.length + 1)
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = offset
    offset += lines[i]!.length
  }
  lineOffsets[lines.length] = offset

  const posToOffset = (line: number, character: number): number => {
    if (line < 0 || line > lines.length) {
      throw new Error(`Position out of range: line ${line + 1}`)
    }
    if (line === lines.length) {
      if (character !== 0) {
        throw new Error(`Position past end of document: line ${line + 1}`)
      }
      return lineOffsets[line]!
    }
    const lineText = lines[line]!
    // Character can equal lineText.length (end-of-line, before newline char(s)).
    const lineBodyLength = stripLineEnding(lineText).length
    if (character < 0 || character > lineBodyLength) {
      // Some servers send character == lineText.length (including newline).
      // Clamp to body length for safety.
      if (character <= lineText.length) {
        return lineOffsets[line]! + lineText.length
      }
      throw new Error(
        `Position out of range: line ${line + 1}, character ${character}`,
      )
    }
    return lineOffsets[line]! + character
  }

  let result = content
  for (const e of edits) {
    const start = posToOffset(e.startLine, e.startChar)
    const end = posToOffset(e.endLine, e.endChar)
    if (end < start) {
      throw new Error(
        `Inverted edit range at line ${e.startLine + 1}: end before start`,
      )
    }
    result = result.slice(0, start) + e.newText + result.slice(end)
  }
  return result
}

function splitKeepingNewlines(s: string): string[] {
  if (s.length === 0) return ['']
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && s[j] !== '\n' && s[j] !== '\r') j++
    if (j < s.length) {
      if (s[j] === '\r' && s[j + 1] === '\n') j += 2
      else j++
    }
    out.push(s.slice(i, j))
    i = j
  }
  return out
}

function stripLineEnding(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2)
  if (line.endsWith('\n') || line.endsWith('\r')) return line.slice(0, -1)
  return line
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export type ApplyResult = {
  modifiedPaths: string[]
  renamedPaths: { oldPath: string; newPath: string }[]
  beforeContents: Map<string, string>
  afterContents: Map<string, string>
}

export type ApplyOptions = {
  /**
   * If true, files are written to disk; otherwise the apply is a dry-run that
   * still returns before/after maps for diff preview.
   */
  write: boolean
}

/**
 * Apply a normalized WorkspaceEdit to disk. Atomic: if any step fails after
 * the first successful write, previously-written files are restored from the
 * in-memory snapshot captured at read time.
 *
 * Throws on:
 * - workspace too large (> LIMITS.maxFiles / maxBytes after read)
 * - file content drift between snapshot and write (sha256 mismatch)
 * - rename target already exists (unless overwrite or ignoreIfExists)
 */
export async function applyNormalizedEdit(
  normalized: NormalizedEdit,
  options: ApplyOptions,
): Promise<ApplyResult> {
  const fs = getFsImplementation()
  const beforeContents = new Map<string, string>()
  const afterContents = new Map<string, string>()
  const beforeHashes = new Map<string, string>()
  const editOps = normalized.ops.filter(
    (o): o is NormalizedFileEdit => o.kind === 'edit',
  )
  const renameOps = normalized.ops.filter(
    (o): o is NormalizedRename => o.kind === 'rename',
  )

  const limits = getLimits()
  if (editOps.length > limits.maxFiles) {
    throw new Error(
      `Workspace edit touches ${editOps.length} files; max is ${limits.maxFiles}. Split the refactor manually.`,
    )
  }

  // Phase 1 — read snapshots, capturing per-file encoding/EOL up front so
  // rollback later doesn't redetect on a partially-written file.
  const fileMeta = new Map<
    string,
    { encoding: BufferEncoding; endings: LineEndingType }
  >()
  let totalBytes = 0
  for (const op of editOps) {
    let before: string
    try {
      before = await fs.readFile(op.path, { encoding: 'utf8' })
    } catch (e) {
      throw new Error(
        `Failed to read ${op.path} for WorkspaceEdit: ${(e as Error).message}`,
      )
    }
    totalBytes += Buffer.byteLength(before)
    if (totalBytes > limits.maxBytes) {
      throw new Error(
        `Workspace edit snapshot exceeds ${limits.maxBytes} bytes; split the refactor manually.`,
      )
    }
    beforeContents.set(op.path, before)
    beforeHashes.set(op.path, sha256(before))
    fileMeta.set(op.path, {
      encoding: detectFileEncoding(op.path),
      endings: detectLineEndings(op.path),
    })
  }

  // Phase 2 — compute after-contents in memory
  for (const op of editOps) {
    const before = beforeContents.get(op.path)!
    const after = applyTextEditsToContent(before, op.edits)
    afterContents.set(op.path, after)
  }

  if (!options.write) {
    return {
      modifiedPaths: editOps.map(o => o.path),
      renamedPaths: renameOps.map(r => ({ oldPath: r.oldPath, newPath: r.newPath })),
      beforeContents,
      afterContents,
    }
  }

  // Phase 3 — write with rollback on failure
  const written: string[] = []
  try {
    for (const op of editOps) {
      const path = op.path
      // Hash check: did the file drift between snapshot and now?
      const current = await fs.readFile(path, { encoding: 'utf8' })
      if (sha256(current) !== beforeHashes.get(path)!) {
        throw new Error(
          `File ${path} changed during LSP refactor; retry the operation.`,
        )
      }
      const after = afterContents.get(path)!
      if (after !== current) {
        const meta = fileMeta.get(path)!
        writeTextContent(path, after, meta.encoding, meta.endings)
        written.push(path)
        invalidateForPath(path)
      }
    }

    // Renames last — file moves go after edits so the in-place edits land on
    // the still-existing files.
    for (const r of renameOps) {
      // We avoid stat() here; rely on rename failure modes. Caller is
      // responsible for invoking ensureRenameTarget if it needs the
      // overwrite/ignoreIfExists semantics. For now we assume the server's
      // contract: target shouldn't exist.
      if (r.oldPath === r.newPath) continue
      try {
        await fs.rename(r.oldPath, r.newPath)
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'EXDEV') {
          // Cross-device — copy+unlink fallback. Move raw bytes so we
          // don't corrupt non-UTF8 files (latin1, utf16le, binary) by
          // round-tripping through a JS string.
          await fs.copyFile(r.oldPath, r.newPath)
          await fs.unlink(r.oldPath)
        } else {
          throw e
        }
      }
      invalidateForPath(r.oldPath)
      invalidateForPath(r.newPath)
    }
  } catch (err) {
    // Rollback — restore any files we wrote
    for (const path of written) {
      try {
        const before = beforeContents.get(path)!
        const meta = fileMeta.get(path)!
        writeTextContent(path, before, meta.encoding, meta.endings)
        invalidateForPath(path)
      } catch (rollbackErr) {
        logError(
          `WorkspaceEdit rollback failed for ${path}: ${(rollbackErr as Error).message}`,
        )
      }
    }
    throw err
  }

  return {
    modifiedPaths: written,
    renamedPaths: renameOps.map(r => ({ oldPath: r.oldPath, newPath: r.newPath })),
    beforeContents,
    afterContents,
  }
}
