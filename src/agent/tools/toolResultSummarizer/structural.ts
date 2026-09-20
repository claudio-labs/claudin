import { compressJsonArray } from 'src/agent/tools/jsonArrayCompress.js'
import { detectCodeLang, stripLineNumberPrefix } from 'src/shared/fs/detectCodeLang.js'
import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'
import { renderOutlineBody } from 'src/tools/shared/codeOutline/renderOutline.js'
import { logForDebugging } from 'src/shared/debug.js'
import type { StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'
import { CODE_OUTLINE_MIN_SYMBOLS, codeSavesEnough, isToolResultCodeOutlineEnabled, isToolResultJsonCompressionEnabled, jsonSavesEnough } from 'src/agent/tools/toolResultSummarizer/thresholds.js'
import { joinTextBlocks } from 'src/agent/tools/toolResultSummarizer/headTail.js'

/**
 * Try structural JSON compression on the joined text blocks of an array-content
 * result (Agent/MCP). Gated + above-threshold + actually compressible, else null
 * so the caller falls through to its existing head/tail strategy.
 */
export function maybeJsonStructural(
  blocks: Array<{ type: string; text?: string }>,
  threshold: number,
): StrategyResult | null {
  if (!isToolResultJsonCompressionEnabled()) return null
  const text = joinTextBlocks(blocks)
  if (text.length < threshold) return null
  const jc = compressJsonArray(text)
  if (!jc || !jsonSavesEnough(jc.render, text)) return null
  return {
    body: jc.render,
    strategy: 'json-structural',
    salientPinned: jc.salientPinned,
  }
}

/**
 * Code-outline strategy: when the whole result is recognizably one source file,
 * replace its body with the scanSymbols structural outline (signatures + line
 * ranges) instead of blind head/tail. The full source is persisted verbatim by
 * `makeReversibleIfElided`, so the dropped bodies stay retrievable via Read
 * offset/limit + Grep on the marker's `source=` path (outline ranges == raw
 * line numbers). Returns null on any miss so the caller falls through to its
 * existing head/tail strategy.
 */
function summarizeCodeOutline(text: string): StrategyResult | null {
  try {
    if (!isToolResultCodeOutlineEnabled()) return null
    const lines = text.split('\n')
    // Strip a uniform `cat -n`/`grep -n` numeric prefix for scanning only; this
    // never changes line count/positions, so ranges still match the raw source.
    const stripped = stripLineNumberPrefix(lines).join('\n')
    const lang = detectCodeLang(stripped)
    if (lang === null) return null
    const entries = scanSymbols(stripped, lang)
    if (entries.length < CODE_OUTLINE_MIN_SYMBOLS) return null
    const body = renderOutlineBody(entries)
    if (!codeSavesEnough(body, text)) return null
    return {
      body,
      strategy: 'code-outline',
      envelopeAttrs: {
        symbols: String(entries.length),
        lines: String(lines.length),
      },
    }
  } catch (error) {
    logForDebugging(
      `summarizeCodeOutline: ${(error as Error)?.message ?? String(error)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Try code-outline on a text blob (string or joined array content). Gated +
 * above-threshold, else null so the caller falls through to head/tail.
 */
export function maybeCodeOutline(text: string, threshold: number): StrategyResult | null {
  if (!isToolResultCodeOutlineEnabled()) return null
  if (text.length < threshold) return null
  return summarizeCodeOutline(text)
}
