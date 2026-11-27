/**
 * Entry-by-entry validation of an MCP server's tools, prompts, resources and
 * resource templates lists.
 *
 * The SDK's list schemas check a whole page at once, so one malformed tool
 * (an inputSchema of type "string", a name that is a number) failed the page
 * and the server lost every tool it had. Here a page is requested with its
 * entries unchecked, and each entry is checked on its own against the SDK's
 * schema for that kind: a broken entry is skipped with its reason, and an
 * optional field of the wrong type is dropped from an entry that is
 * otherwise sound.
 */
import type {
  Prompt,
  Resource,
  ResourceTemplateType,
  Tool,
} from '@modelcontextprotocol/client'
import {
  PromptSchema,
  ResourceSchema,
  ResourceTemplateSchema,
  ToolSchema,
} from '@modelcontextprotocol/core'
import { z } from 'zod/v4'

export type SkippedEntry = { name?: string; reason: string }
export type ValidatedList<T> = { items: T[]; skipped: SkippedEntry[] }

// Pages whose entries are left for the keepValid* functions below.
const entries = z.array(z.unknown())
const nextCursor = z.string().optional()
export const LenientToolsPageSchema = z.object({ tools: entries, nextCursor }).passthrough()
export const LenientPromptsPageSchema = z.object({ prompts: entries, nextCursor }).passthrough()
export const LenientResourcesPageSchema = z.object({ resources: entries, nextCursor }).passthrough()
export const LenientResourceTemplatesPageSchema = z.object({ resourceTemplates: entries, nextCursor }).passthrough()

/** A list response that is itself malformed: retrying it gets the same answer. */
export function isSchemaError(error: unknown): boolean {
  return error instanceof z.core.$ZodError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entryName(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.name === 'string' ? entry.name : undefined
}

// Parse one entry. A failure confined to the droppable fields drops them and
// parses again (zod reports every issue at once, so one drop is enough); a
// failure anywhere else skips the entry.
function parseEntry<T>(
  schema: z.ZodType<T>,
  entry: Record<string, unknown>,
  droppable: ReadonlySet<string>,
): { ok: true; value: T } | { ok: false; skipped: SkippedEntry } {
  const first = schema.safeParse(entry)
  if (first.success) return { ok: true, value: first.data }
  const fields = new Set(first.error.issues.map(issue => String(issue.path[0] ?? '')))
  if ([...fields].every(field => droppable.has(field))) {
    const second = schema.safeParse(Object.fromEntries(Object.entries(entry).filter(([key]) => !fields.has(key))))
    if (second.success) return { ok: true, value: second.data }
  }
  const issue = first.error.issues[0]
  const reason = issue ? `${issue.path.join('.') || 'entry'}: ${issue.message}` : 'invalid entry'
  return { ok: false, skipped: { name: entryName(entry), reason } }
}

type Normalized = { entry: Record<string, unknown> } | { skip: string }

function keepValid<T>(
  raw: readonly unknown[],
  schema: z.ZodType<T>,
  droppable: ReadonlySet<string>,
  normalize: (entry: Record<string, unknown>) => Normalized = entry => ({ entry }),
): ValidatedList<T> {
  const items: T[] = []
  const skipped: SkippedEntry[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) {
      skipped.push({ reason: 'not an object' })
      continue
    }
    const normalized = normalize(entry)
    if ('skip' in normalized) {
      skipped.push({ name: entryName(entry), reason: normalized.skip })
      continue
    }
    const parsed = parseEntry(schema, normalized.entry, droppable)
    if (parsed.ok) items.push(parsed.value)
    else skipped.push(parsed.skipped)
  }
  return { items, skipped }
}

const TOOL_DROPPABLE = new Set(['title', 'description', 'outputSchema', 'annotations', 'execution', 'icons', '_meta'])
const PROMPT_DROPPABLE = new Set(['title', 'description', 'icons', '_meta'])
const RESOURCE_DROPPABLE = new Set(['title', 'description', 'mimeType', 'annotations', 'size', 'icons', '_meta'])

// The top level of a tool's inputSchema is what providers check against the
// JSON Schema metaschema, so a wrong-typed `properties` or `required` there is
// dropped rather than sent; nested property schemas are left as the server
// wrote them (as opencode does, packages/core/src/mcp/client.ts), except one
// that is not an object at all, which skips the tool: the 1.x SDK schema
// rejected it and the v2 one types properties as any JSON value.
function normalizeTool(entry: Record<string, unknown>): Normalized {
  if (typeof entry.name !== 'string' || entry.name === '') return { skip: 'name is not a non-empty string' }
  const inputSchema = entry.inputSchema
  if (!isRecord(inputSchema)) return { skip: 'inputSchema is not an object' }
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') {
    return { skip: 'inputSchema type is not "object"' }
  }
  const { properties, required, ...rest } = inputSchema
  if (isRecord(properties)) {
    const notSchema = Object.keys(properties).find(key => typeof properties[key] !== 'object' || properties[key] === null)
    if (notSchema !== undefined) return { skip: `inputSchema.properties.${notSchema}: not a schema` }
  }
  return {
    entry: {
      ...entry,
      inputSchema: {
        ...rest,
        type: 'object',
        ...(isRecord(properties) ? { properties } : {}),
        ...(Array.isArray(required) && required.every(key => typeof key === 'string') ? { required } : {}),
      },
    },
  }
}

export function keepValidTools(raw: readonly unknown[]): ValidatedList<Tool> {
  return keepValid(raw, ToolSchema, TOOL_DROPPABLE, normalizeTool)
}

export function keepValidPrompts(raw: readonly unknown[]): ValidatedList<Prompt> {
  return keepValid(raw, PromptSchema, PROMPT_DROPPABLE)
}

export function keepValidResources(raw: readonly unknown[]): ValidatedList<Resource> {
  return keepValid(raw, ResourceSchema, RESOURCE_DROPPABLE)
}

export function keepValidResourceTemplates(raw: readonly unknown[]): ValidatedList<ResourceTemplateType> {
  return keepValid(raw, ResourceTemplateSchema, RESOURCE_DROPPABLE)
}
