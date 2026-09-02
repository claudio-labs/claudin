/**
 * Non-destructive JSON merge, shared by the startup migration and `/import`.
 *
 * "Non-destructive" here means **existing wins**: a key already present in the
 * destination is never replaced, so re-running an import is a no-op and a user
 * who has already configured Claudin cannot lose that by importing.
 */
import { existsSync } from 'fs'

import {
  ensureDir,
  readJson,
  writeJson,
} from 'src/platform/import/writers/files.js'
import type { JsonTable } from 'src/platform/import/translate/values.js'
import { dirname } from 'path'

export type JsonMergeResult =
  | { outcome: 'noSource'; copiedKeys: 0 }
  | { outcome: 'unparseableSource'; copiedKeys: 0 }
  | { outcome: 'writeFailed'; copiedKeys: 0; message: string }
  | { outcome: 'merged'; copiedKeys: number }

export type JsonMergeOptions = {
  /**
   * Restrict the merge to these keys. Omit to forward every top-level key the
   * source has — which is what the legacy global config wants, while
   * settings.json is deliberately whitelisted.
   */
  keys?: readonly string[]
}

export function mergeJsonFileNonDestructive(
  sourcePath: string,
  destPath: string,
  options: JsonMergeOptions = {},
): JsonMergeResult {
  if (!existsSync(sourcePath)) return { outcome: 'noSource', copiedKeys: 0 }

  const source = readJson(sourcePath)
  if (!source) return { outcome: 'unparseableSource', copiedKeys: 0 }

  const destExists = existsSync(destPath)
  const existing = destExists ? (readJson(destPath) ?? {}) : {}

  const merged: JsonTable = { ...existing }
  let copiedKeys = 0
  for (const key of options.keys ?? Object.keys(source)) {
    if (!(key in source)) continue
    if (key in existing) continue // non-destructive: existing wins
    merged[key] = source[key]
    copiedKeys += 1
  }

  // Nothing new to add and a destination already on disk — leave its bytes
  // alone rather than rewriting it with identical content.
  if (copiedKeys === 0 && destExists) {
    return { outcome: 'merged', copiedKeys: 0 }
  }

  try {
    ensureDir(dirname(destPath))
    writeJson(destPath, merged)
  } catch (e: unknown) {
    return {
      outcome: 'writeFailed',
      copiedKeys: 0,
      message: e instanceof Error ? e.message : String(e),
    }
  }

  return { outcome: 'merged', copiedKeys }
}
