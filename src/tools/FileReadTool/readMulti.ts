/**
 * The batch Read — several files, or several symbols of one file, in one call
 * — behind CLAUDIN_READ_MULTI, off by default while the session-cache A/B
 * measures it (arm `readmulti`). Promotion hangs on API calls per session
 * going down; the ceiling measured over real sessions is ~1.9% of calls.
 *
 * This module is the flag and the pure reading of a batch input. The loop that
 * runs a batch is batchRead.ts.
 */
import { isEnvTruthy } from 'src/shared/envUtils.js'
import type { Input, SingleInput } from 'src/tools/FileReadTool/schemas.js'

/**
 * Every module whose surface the flag changes (schemas.ts, prompt.ts,
 * FileReadTool.ts) reads it once, at its own load, and keeps the answer: the
 * input schema, the description and the call dispatch must agree for the
 * whole session, and a schema that changed mid-session would rewrite the
 * cached tools array.
 */
export function readMultiEnabledAtLoad(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_READ_MULTI)
}

export const MIN_BATCH_FILES = 2
export const MAX_BATCH_FILES = 20
export const MAX_BATCH_SYMBOLS = 10

/** The fields that make a Read a batch, as the flag-on schema parses them. */
type ReadTargets = {
  file_path?: string
  file_paths?: string[]
  symbol?: string | string[] | null
}

/**
 * A Read's targets as a transcript records them, for the code that walks one
 * (resume, compaction, the plan dossier, the collapsed-group counts). A
 * tool_use block keeps the model's own arguments: the placeholder strip and
 * the schema run when the call executes (toolExecution.ts), not on what is
 * stored. So Codex strict mode stores a single Read under the batch-capable
 * schema with `file_paths: null` — or `""`, or `[]` — beside its
 * `file_path`, and a call the schema refused is stored all the same. Read
 * here as the flag-on schema reads them: a placeholder, or a value of a type
 * the schema refuses, is absent.
 */
export function recordedReadTargets(input: unknown): ReadTargets {
  if (typeof input !== 'object' || input === null) return {}
  const { file_path, file_paths, symbol } = input as Record<string, unknown>
  const paths = stringList(file_paths)
  const symbols = stringList(symbol)
  return {
    ...(isNonEmptyString(file_path) && { file_path }),
    ...(paths && { file_paths: paths }),
    ...(isNonEmptyString(symbol) ? { symbol } : symbols && { symbol: symbols }),
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** A list the schema would take: at least one entry, every one a string. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const list: unknown[] = value
  return list.every((entry): entry is string => typeof entry === 'string')
    ? list
    : undefined
}

/**
 * Whether `input` is answered by the batch loop: a `file_paths` list, or a
 * `symbol` list naming more than one symbol. A one-name list is an ordinary
 * symbol Read, and goes down the single-file path unchanged.
 */
export function isBatchReadInput(input: ReadTargets): boolean {
  return (
    input.file_paths !== undefined ||
    (Array.isArray(input.symbol) && input.symbol.length > 1)
  )
}

/** Every path a Read input names, in the order it names them. */
export function readPathsOf(input: ReadTargets): string[] {
  if (input.file_paths !== undefined) return input.file_paths
  return input.file_path !== undefined ? [input.file_path] : []
}

/** Every symbol a Read input names, one or a list; empty for none. */
export function symbolsOf(input: Pick<ReadTargets, 'symbol'>): string[] {
  const { symbol } = input
  if (symbol === undefined || symbol === null) return []
  return Array.isArray(symbol) ? symbol : [symbol]
}

const NO_PATH_MESSAGE = 'Read needs file_path, or file_paths to read several files.'

/**
 * The single-file view of an input that is not a batch. validateInput refuses
 * a Read that names no path, so past it `file_path` is always there; a
 * one-name symbol list is that name.
 */
export function toSingleInput(input: Input): SingleInput {
  const { file_path, file_paths: _batchOnly, symbol, ...rest } = input
  if (file_path === undefined) throw new Error(NO_PATH_MESSAGE)
  const [name] = symbolsOf({ symbol })
  return name === undefined ? { ...rest, file_path } : { ...rest, file_path, symbol: name }
}

// The single-file validateInput codes run 1-9.
const SHAPE_ERROR_CODE = 10
const SINGLE_FILE_OPTION_ERROR_CODE = 11
export const READ_HOOK_ERROR_CODE = 12

const SINGLE_FILE_OPTIONS = ['offset', 'limit', 'pages', 'encoding'] as const

/**
 * What a batch-capable input asks for that the schema cannot refuse on its
 * own: both paths or neither (the schema leaves both optional — see
 * schemas.ts), or a single-file option alongside `file_paths`. Null when the
 * shape is fine. Pure; validateInput runs it before anything else.
 */
export function batchShapeRefusal(
  input: Input,
): { message: string; errorCode: number } | null {
  if (input.file_path !== undefined && input.file_paths !== undefined) {
    return {
      message: 'Give file_path or file_paths, not both.',
      errorCode: SHAPE_ERROR_CODE,
    }
  }
  if (input.file_path === undefined && input.file_paths === undefined) {
    return { message: NO_PATH_MESSAGE, errorCode: SHAPE_ERROR_CODE }
  }
  if (input.file_paths === undefined) return null
  const given = SINGLE_FILE_OPTIONS.filter(key => input[key] !== undefined)
  if (given.length === 0) return null
  const [them, apply] = given.length === 1 ? ['it', 'applies'] : ['them', 'apply']
  return {
    message: `${given.join(', ')} ${apply} to one file — drop ${them} from a file_paths Read, or Read that file on its own.`,
    errorCode: SINGLE_FILE_OPTION_ERROR_CODE,
  }
}
