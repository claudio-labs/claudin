import type {
  EnumSchema,
  MultiSelectEnumSchema,
  PrimitiveSchemaDefinition,
  StringSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  multiChoiceLabel,
  multiChoiceLabels,
  multiChoiceValues,
  singleChoiceLabel,
  singleChoiceLabels,
  singleChoiceValues,
} from 'src/mcp/elicitation/choices.js'
import { checkField } from 'src/mcp/elicitation/fieldChecks.js'
import {
  isDateField,
  isMultiChoiceField,
  isSingleChoiceField,
} from 'src/mcp/elicitation/fieldKind.js'
import {
  looksLikeISO8601,
  parseNaturalLanguageDateTime,
} from 'src/mcp/dateTimeParser.js'

export type ValidationResult = {
  value?: string | number | boolean
  isValid: boolean
  error?: string
}

export const isEnumSchema = (
  schema: PrimitiveSchemaDefinition,
): schema is EnumSchema => isSingleChoiceField(schema)

export function isMultiSelectEnumSchema(
  schema: PrimitiveSchemaDefinition,
): schema is MultiSelectEnumSchema {
  return isMultiChoiceField(schema)
}

export function getMultiSelectValues(schema: MultiSelectEnumSchema): string[] {
  return multiChoiceValues(schema)
}

export function getMultiSelectLabels(schema: MultiSelectEnumSchema): string[] {
  return multiChoiceLabels(schema)
}

export function getMultiSelectLabel(
  schema: MultiSelectEnumSchema,
  value: string,
): string {
  return multiChoiceLabel(schema, value)
}

export function getEnumValues(schema: EnumSchema): string[] {
  return singleChoiceValues(schema)
}

export function getEnumLabels(schema: EnumSchema): string[] {
  return singleChoiceLabels(schema)
}

export function getEnumLabel(schema: EnumSchema, value: string): string {
  return singleChoiceLabel(schema, value)
}

export function validateElicitationInput(
  stringValue: string,
  schema: PrimitiveSchemaDefinition,
): ValidationResult {
  return checkField(stringValue, schema)
}

export function isDateTimeSchema(
  schema: PrimitiveSchemaDefinition,
): schema is StringSchema & { format: 'date' | 'date-time' } {
  return isDateField(schema)
}

/**
 * The typed-input check, with a model fallback for natural-language dates.
 * Valid date input is always ISO-shaped, so it never reaches the model.
 * The model's value is never trusted: it must pass the same check, and when
 * it does not, the user sees the error for what they typed.
 */
export async function validateElicitationInputAsync(
  stringValue: string,
  schema: PrimitiveSchemaDefinition,
  signal: AbortSignal,
): Promise<ValidationResult> {
  const typed = validateElicitationInput(stringValue, schema)
  if (!isDateField(schema) || looksLikeISO8601(stringValue)) {
    return typed
  }
  const parsed = await parseNaturalLanguageDateTime(stringValue, schema.format, signal)
  if (!parsed.success) return typed
  const resolved = validateElicitationInput(parsed.value, schema)
  return resolved.isValid ? resolved : typed
}
