import { Ajv } from 'ajv'
import { Ajv2019 } from 'ajv/dist/2019.js'
import { Ajv2020 } from 'ajv/dist/2020.js'

const DRAFT_2020_RE = /draft\/2020-12\/schema/
const DRAFT_2019_RE = /draft\/2019-09\/schema/

export type AjvClass = typeof Ajv | typeof Ajv2019 | typeof Ajv2020

/**
 * The Ajv class for the draft a JSON Schema declares. Plain `Ajv` is draft-07
 * and knows no other meta-schema, so a `$schema` naming 2020-12 — what zod v4's
 * toJSONSchema and @playwright/mcp emit — does not compile under it: every call
 * to that MCP server's tools was refused ("no schema with key or ref
 * …/draft/2020-12/schema"), and one user put a stdio proxy in front of
 * @playwright/mcp just to strip the field. A schema with no `$schema`, or
 * another draft, gets the draft-07 class it always had.
 */
export function ajvClassForSchema(schema: unknown): AjvClass {
  const declared =
    schema && typeof schema === 'object' && '$schema' in schema
      ? String(schema.$schema)
      : ''
  if (DRAFT_2020_RE.test(declared)) return Ajv2020
  if (DRAFT_2019_RE.test(declared)) return Ajv2019
  return Ajv
}
