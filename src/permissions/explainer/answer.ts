/**
 * The shape the explainer asks the model for, declared once: the forced tool's
 * input schema and the reply parser both read the same field table, so the
 * enum and the required fields cannot drift apart.
 */
import type { PermissionExplanation, RiskLevel } from 'src/permissions/permissionExplainer.js'

export const EXPLAIN_TOOL_NAME = 'explain_command'

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const satisfies readonly RiskLevel[]

type AnswerField = keyof PermissionExplanation

type FieldSpec = { description: string; oneOf?: readonly string[] }

const ANSWER_FIELDS: Record<AnswerField, FieldSpec> = {
  explanation: { description: 'What this command does, in 1-2 sentences' },
  reasoning: {
    description: 'Why you are running this command. Start with "I", as in "I need to see which files changed"',
  },
  risk: { description: 'What could go wrong, in under 15 words' },
  riskLevel: {
    description: 'LOW (safe dev workflows), MEDIUM (recoverable changes) or HIGH (dangerous or irreversible)',
    oneOf: RISK_LEVELS,
  },
}

const FIELD_NAMES = Object.keys(ANSWER_FIELDS) as AnswerField[]

type JsonStringProperty = { type: 'string'; description: string; enum?: string[] }

export type ExplainTool = {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<AnswerField, JsonStringProperty>
    required: AnswerField[]
  }
}

function toProperty(spec: FieldSpec): JsonStringProperty {
  const property: JsonStringProperty = { type: 'string', description: spec.description }
  if (spec.oneOf) property.enum = [...spec.oneOf]
  return property
}

export function buildExplainTool(): ExplainTool {
  const properties = Object.fromEntries(FIELD_NAMES.map(name => [name, toProperty(ANSWER_FIELDS[name])])) as Record<
    AnswerField,
    JsonStringProperty
  >
  return {
    name: EXPLAIN_TOOL_NAME,
    description: 'Explain a shell command to the user',
    input_schema: { type: 'object', properties, required: [...FIELD_NAMES] },
  }
}

function fieldIsValid(spec: FieldSpec, value: unknown): value is string {
  if (typeof value !== 'string') return false
  return spec.oneOf === undefined || spec.oneOf.includes(value)
}

/** The four fields of a tool input, or null when any is missing or out of range. */
export function parseExplanationInput(input: unknown): PermissionExplanation | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  for (const name of FIELD_NAMES) {
    if (!fieldIsValid(ANSWER_FIELDS[name], record[name])) return null
  }
  return {
    riskLevel: record.riskLevel as RiskLevel,
    explanation: record.explanation as string,
    reasoning: record.reasoning as string,
    risk: record.risk as string,
  }
}

type ReplyBlock = { type: string; input?: unknown }

/** Reads the reply's first tool call; text around it is ignored. */
export function parseExplanationReply(reply: { content: readonly ReplyBlock[] }): PermissionExplanation | null {
  const call = reply.content.find(block => block.type === 'tool_use')
  return call ? parseExplanationInput(call.input) : null
}
