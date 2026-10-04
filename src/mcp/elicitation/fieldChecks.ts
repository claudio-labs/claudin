import type {
  EnumSchema,
  NumberSchema,
  PrimitiveSchemaDefinition,
  StringSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { plural } from 'src/shared/text/stringUtils.js'
import { singleChoiceValues } from 'src/mcp/elicitation/choices.js'
import { classifyField } from 'src/mcp/elicitation/fieldKind.js'
import {
  isCalendarDate,
  isZonedDateTime,
} from 'src/mcp/elicitation/isoDate.js'

export type FieldCheck = {
  value?: string | number | boolean
  isValid: boolean
  error?: string
}

const FIELD_MESSAGES = {
  email: 'Must be a valid email address, e.g. user@example.com',
  uri: 'Must be a valid URI, e.g. https://example.com',
  date: 'Must be a valid date, e.g. 2024-03-15, today, next Monday',
  dateTime:
    'Must be a valid date-time, e.g. 2024-03-15T14:30:00Z, tomorrow at 3pm',
  boolean: 'Must be true or false',
  noChoices: 'There is no value to choose from',
} as const

const EMAIL_ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/
type FormatRule = { accepts: (text: string) => boolean; message: string }

/** Formats outside this table are not checked. */
const FORMAT_RULES = new Map<string, FormatRule>([
  ['email', { accepts: text => EMAIL_ADDRESS.test(text), message: FIELD_MESSAGES.email }],
  // Without a base, only an absolute URI (one with a scheme) parses.
  ['uri', { accepts: text => URL.canParse(text), message: FIELD_MESSAGES.uri }],
  ['date', { accepts: isCalendarDate, message: FIELD_MESSAGES.date }],
  ['date-time', { accepts: isZonedDateTime, message: FIELD_MESSAGES.dateTime }],
])

const accept = (value: string | number | boolean): FieldCheck => ({ isValid: true, value })
const refuse = (error: string): FieldCheck => ({ isValid: false, error })

function checkText(text: string, schema: StringSchema): FieldCheck {
  const problems: string[] = []
  const { minLength, maxLength, format } = schema
  if (minLength !== undefined && text.length < minLength) {
    problems.push(`Must be at least ${minLength} ${plural(minLength, 'character')}`)
  }
  if (maxLength !== undefined && text.length > maxLength) {
    problems.push(`Must be at most ${maxLength} ${plural(maxLength, 'character')}`)
  }
  const rule = format === undefined ? undefined : FORMAT_RULES.get(format)
  if (rule && !rule.accepts(text)) problems.push(rule.message)
  return problems.length === 0 ? accept(text) : refuse(problems.join('; '))
}

function boundText(bound: number, integer: boolean): string {
  return !integer && Number.isInteger(bound) ? bound.toFixed(1) : String(bound)
}

/** One message per field, whichever rule the input broke. */
function numberMessage(schema: NumberSchema): string {
  const integer = schema.type === 'integer'
  const noun = integer ? 'an integer' : 'a number'
  const { minimum, maximum } = schema
  if (minimum !== undefined && maximum !== undefined) {
    return `Must be ${noun} between ${boundText(minimum, integer)} and ${boundText(maximum, integer)}`
  }
  if (minimum !== undefined) return `Must be ${noun} >= ${boundText(minimum, integer)}`
  if (maximum !== undefined) return `Must be ${noun} <= ${boundText(maximum, integer)}`
  return `Must be ${noun}`
}

/** JavaScript's reading of the text, except that blank text is no number at all. */
function readNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const number = Number(text)
  return Number.isFinite(number) ? number : undefined
}

function checkNumber(text: string, schema: NumberSchema): FieldCheck {
  const number = readNumber(text)
  const fits =
    number !== undefined &&
    (schema.type !== 'integer' || Number.isInteger(number)) &&
    (schema.minimum === undefined || number >= schema.minimum) &&
    (schema.maximum === undefined || number <= schema.maximum)
  return fits ? accept(number) : refuse(numberMessage(schema))
}

function checkBoolean(text: string): FieldCheck {
  if (text === 'true') return accept(true)
  if (text === 'false') return accept(false)
  return refuse(FIELD_MESSAGES.boolean)
}

function checkSingleChoice(text: string, schema: EnumSchema): FieldCheck {
  const allowed = singleChoiceValues(schema)
  if (allowed.includes(text)) return accept(text)
  if (allowed.length === 0) return refuse(FIELD_MESSAGES.noChoices)
  return refuse(`Must be one of ${allowed.map(value => JSON.stringify(value)).join(', ')}`)
}

export function checkField(
  text: string,
  schema: PrimitiveSchemaDefinition,
): FieldCheck {
  const field = classifyField(schema)
  switch (field.kind) {
    case 'singleChoice':
      return checkSingleChoice(text, field.schema)
    case 'text':
      return checkText(text, field.schema)
    case 'number':
      return checkNumber(text, field.schema)
    case 'boolean':
      return checkBoolean(text)
    case 'multiChoice':
    case 'unsupported':
      throw new Error(`Unsupported schema: ${JSON.stringify(schema)}`)
  }
}
