import type {
  BooleanSchema,
  EnumSchema,
  MultiSelectEnumSchema,
  NumberSchema,
  PrimitiveSchemaDefinition,
  StringSchema,
} from '@modelcontextprotocol/sdk/types.js'

export type DateFormat = 'date' | 'date-time'

export type DateTimeSchema = StringSchema & { format: DateFormat }

/** A form field as the checks see it, classified once. */
export type FieldKind =
  | { kind: 'singleChoice'; schema: EnumSchema }
  | { kind: 'multiChoice'; schema: MultiSelectEnumSchema }
  | { kind: 'text'; schema: StringSchema }
  | { kind: 'number'; schema: NumberSchema }
  | { kind: 'boolean'; schema: BooleanSchema }
  | { kind: 'unsupported' }

type Fields = Readonly<Record<string, unknown>>

/** Servers send JSON, so a field may carry keys its declared type does not list. */
export function fieldsOf(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null ? (value as Fields) : undefined
}

export function isSingleChoiceField(
  schema: PrimitiveSchemaDefinition,
): schema is EnumSchema {
  const fields = fieldsOf(schema)
  return (
    fields?.type === 'string' && ('enum' in fields || 'oneOf' in fields)
  )
}

export function isMultiChoiceField(
  schema: PrimitiveSchemaDefinition,
): schema is MultiSelectEnumSchema {
  const fields = fieldsOf(schema)
  if (fields?.type !== 'array') return false
  const items = fieldsOf(fields.items)
  return items !== undefined && ('enum' in items || 'anyOf' in items)
}

export function isDateField(
  schema: PrimitiveSchemaDefinition,
): schema is DateTimeSchema {
  const fields = fieldsOf(schema)
  return (
    fields?.type === 'string' &&
    (fields.format === 'date' || fields.format === 'date-time')
  )
}

export function classifyField(schema: PrimitiveSchemaDefinition): FieldKind {
  if (isSingleChoiceField(schema)) return { kind: 'singleChoice', schema }
  if (isMultiChoiceField(schema)) return { kind: 'multiChoice', schema }
  switch (fieldsOf(schema)?.type) {
    case 'string':
      return { kind: 'text', schema: schema as StringSchema }
    case 'number':
    case 'integer':
      return { kind: 'number', schema: schema as NumberSchema }
    case 'boolean':
      return { kind: 'boolean', schema: schema as BooleanSchema }
    default:
      return { kind: 'unsupported' }
  }
}
