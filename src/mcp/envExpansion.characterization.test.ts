/**
 * Characterization of `expandEnvVarsInString` (src/mcp/envExpansion.ts).
 *
 * The placeholder syntax is shared by every MCP config scope and by the plugin
 * MCP and LSP loaders, so each row below is something a user's config relies on.
 * Only variables with the CHAR_ENV_ prefix are touched, and each row sets them
 * from scratch.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { expandEnvVarsInString } from 'src/mcp/envExpansion.js'

const PREFIX = 'CHAR_ENV_'

function scrub(): void {
  for (const key of Object.keys(process.env)) if (key.startsWith(PREFIX)) delete process.env[key]
}

afterEach(scrub)

type Row = {
  why: string
  env?: Record<string, string>
  input: string
  out: string
  missing?: string[]
}

const rows: Row[] = [
  { why: 'a set variable is substituted', env: { CHAR_ENV_A: 'alpha' }, input: 'x-${CHAR_ENV_A}-y', out: 'x-alpha-y' },
  { why: 'an empty value still counts as set', env: { CHAR_ENV_A: '' }, input: '[${CHAR_ENV_A:-fallback}]', out: '[]' },
  { why: 'the default applies when unset', input: '${CHAR_ENV_A:-fallback}', out: 'fallback' },
  { why: 'an empty default gives an empty string', input: '<${CHAR_ENV_A:-}>', out: '<>' },
  { why: 'only the first :- separates the default', input: '${CHAR_ENV_A:-p:-q}', out: 'p:-q' },
  { why: 'a set variable wins over its default', env: { CHAR_ENV_A: 'set' }, input: '${CHAR_ENV_A:-unused}', out: 'set' },
  { why: 'an unset variable stays verbatim and is reported', input: 'k=${CHAR_ENV_NOPE}', out: 'k=${CHAR_ENV_NOPE}', missing: ['CHAR_ENV_NOPE'] },
  { why: 'each unset occurrence is reported, repeats included', input: '${CHAR_ENV_X}${CHAR_ENV_Y}${CHAR_ENV_X}', out: '${CHAR_ENV_X}${CHAR_ENV_Y}${CHAR_ENV_X}', missing: ['CHAR_ENV_X', 'CHAR_ENV_Y', 'CHAR_ENV_X'] },
  { why: 'a bare $NAME is not a placeholder', env: { CHAR_ENV_A: 'v' }, input: '$CHAR_ENV_A', out: '$CHAR_ENV_A' },
  { why: 'empty braces are left alone', input: 'a${}b', out: 'a${}b' },
  { why: 'a single dash is part of the name', input: '${CHAR_ENV_A-d}', out: '${CHAR_ENV_A-d}', missing: ['CHAR_ENV_A-d'] },
  { why: 'spaces are part of the name', input: '${ CHAR_ENV_A }', out: '${ CHAR_ENV_A }', missing: [' CHAR_ENV_A '] },
  { why: 'a substituted value is not expanded again', env: { CHAR_ENV_A: '${CHAR_ENV_B}', CHAR_ENV_B: 'no' }, input: '${CHAR_ENV_A}', out: '${CHAR_ENV_B}' },
  { why: 'a nested placeholder ends at the first closing brace', input: '${CHAR_ENV_A:-${CHAR_ENV_B}}', out: '${CHAR_ENV_B}' },
  { why: 'several placeholders in one string', env: { CHAR_ENV_H: 'host', CHAR_ENV_P: '8080' }, input: 'http://${CHAR_ENV_H}:${CHAR_ENV_P}/${CHAR_ENV_PATH:-mcp}', out: 'http://host:8080/mcp' },
  { why: 'a string with no placeholder is returned as is', input: 'plain --flag=1', out: 'plain --flag=1' },
]

describe('expandEnvVarsInString', () => {
  test.each(rows.map(r => [r.why, r] as const))('%s', (_why, row) => {
    scrub()
    for (const [k, v] of Object.entries(row.env ?? {})) process.env[k] = v
    expect(expandEnvVarsInString(row.input)).toEqual({ expanded: row.out, missingVars: row.missing ?? [] })
  })

  test('reads the environment at call time', () => {
    const template = '${CHAR_ENV_LATE:-early}'
    const first = expandEnvVarsInString(template).expanded
    process.env.CHAR_ENV_LATE = 'late'
    expect([first, expandEnvVarsInString(template).expanded]).toEqual(['early', 'late'])
  })
})
