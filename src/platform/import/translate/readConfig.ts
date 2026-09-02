/**
 * Readers for the four config formats the `/import` adapters have to open.
 *
 * They share one result type so an adapter can turn a bad file into a warning
 * row in the report instead of aborting the whole import: `missing` is the
 * ordinary case (the agent is installed but never configured that surface),
 * while `unreadable` and `invalid` are worth telling the user about.
 */
import { readFileSync } from 'fs'
// The deep ESM path, as in `src/shared/data/json.ts`. The bare specifier
// resolves to an entry whose internal `require('./impl/format')` does not
// survive bundling: the chunk throws on load, and a lazily-loaded command
// whose chunk fails to load is silently inert rather than an error.
import {
  parse as parseJsonc,
  type ParseError,
} from 'jsonc-parser/lib/esm/main.js'
import { parse as parseToml } from 'smol-toml'
import { parse as parseYaml } from 'yaml'

import {
  asTable,
  type JsonTable,
} from 'src/platform/import/translate/values.js'
import { isENOENT } from 'src/shared/errors.js'

export type ConfigReadResult =
  | { ok: true; value: JsonTable }
  | {
      ok: false
      reason: 'missing' | 'unreadable' | 'invalid'
      message: string
    }

export type TextReadResult =
  | { ok: true; value: string }
  | {
      ok: false
      reason: 'missing' | 'unreadable'
      message: string
    }

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function readTextFile(path: string): TextReadResult {
  try {
    return { ok: true, value: readFileSync(path, 'utf8') }
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return { ok: false, reason: 'missing', message: `${path} does not exist` }
    }
    return {
      ok: false,
      reason: 'unreadable',
      message: `${path}: ${messageFor(e)}`,
    }
  }
}

function parsedTable(
  path: string,
  parse: (raw: string) => unknown,
): ConfigReadResult {
  const read = readTextFile(path)
  if (!read.ok) return read

  let parsed: unknown
  try {
    parsed = parse(read.value)
  } catch (e: unknown) {
    return {
      ok: false,
      reason: 'invalid',
      message: `${path}: ${messageFor(e)}`,
    }
  }

  const table = asTable(parsed)
  if (!table) {
    return {
      ok: false,
      reason: 'invalid',
      message: `${path}: expected an object at the top level`,
    }
  }
  return { ok: true, value: table }
}

export function readJsonFile(path: string): ConfigReadResult {
  return parsedTable(path, raw => JSON.parse(raw) as unknown)
}

/**
 * opencode ships `opencode.jsonc` alongside `opencode.json`, and several agents
 * tolerate comments in a nominally-JSON file. `jsonc-parser` reports rather
 * than throws, so its errors are raised here to reach the `invalid` arm.
 */
export function readJsoncFile(path: string): ConfigReadResult {
  return parsedTable(path, raw => {
    const errors: ParseError[] = []
    const parsed: unknown = parseJsonc(raw, errors, {
      allowTrailingComma: true,
    })
    if (errors.length > 0) {
      throw new Error(`${errors.length} JSONC parse error(s)`)
    }
    return parsed
  })
}

export function readTomlFile(path: string): ConfigReadResult {
  return parsedTable(path, raw => parseToml(raw) as unknown)
}

export function readYamlFile(path: string): ConfigReadResult {
  return parsedTable(path, raw => parseYaml(raw) as unknown)
}
