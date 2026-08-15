import { toJSONSchema } from 'zod/v4'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { SettingsSchema } from 'src/platform/settings/types.js'

export function generateSettingsJSONSchema(): string {
  const jsonSchema = toJSONSchema(SettingsSchema(), { unrepresentable: 'any' })
  return jsonStringify(jsonSchema, null, 2)
}
