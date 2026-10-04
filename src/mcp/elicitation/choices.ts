import type {
  EnumSchema,
  MultiSelectEnumSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { fieldsOf } from 'src/mcp/elicitation/fieldKind.js'

type TitledOption = { const: string; title: string }

function stringsIn(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined
}

function titledOptionsIn(value: unknown): TitledOption[] | undefined {
  return Array.isArray(value) ? (value as TitledOption[]) : undefined
}

/** The label at the value's position; a value with none reads as itself. */
function labelFor(values: string[], labels: string[], value: string): string {
  const position = values.indexOf(value)
  return position === -1 ? value : (labels[position] ?? value)
}

export function singleChoiceValues(schema: EnumSchema): string[] {
  const fields = fieldsOf(schema)
  const listed = stringsIn(fields?.enum)
  if (listed) return listed
  return titledOptionsIn(fields?.oneOf)?.map(option => option.const) ?? []
}

export function singleChoiceLabels(schema: EnumSchema): string[] {
  const fields = fieldsOf(schema)
  const titled = titledOptionsIn(fields?.oneOf)
  if (titled) return titled.map(option => option.title)
  return stringsIn(fields?.enumNames) ?? singleChoiceValues(schema)
}

export function singleChoiceLabel(schema: EnumSchema, value: string): string {
  return labelFor(singleChoiceValues(schema), singleChoiceLabels(schema), value)
}

export function multiChoiceValues(schema: MultiSelectEnumSchema): string[] {
  const items = fieldsOf(fieldsOf(schema)?.items)
  const listed = stringsIn(items?.enum)
  if (listed) return listed
  return titledOptionsIn(items?.anyOf)?.map(option => option.const) ?? []
}

export function multiChoiceLabels(schema: MultiSelectEnumSchema): string[] {
  const items = fieldsOf(fieldsOf(schema)?.items)
  const titled = titledOptionsIn(items?.anyOf)
  return titled
    ? titled.map(option => option.title)
    : multiChoiceValues(schema)
}

export function multiChoiceLabel(
  schema: MultiSelectEnumSchema,
  value: string,
): string {
  return labelFor(multiChoiceValues(schema), multiChoiceLabels(schema), value)
}
