import { toJSONSchema } from 'zod/v4'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { SettingsSchema } from 'src/services/settings/types.js'

export function generateSettingsJSONSchema(): string {
  const jsonSchema = toJSONSchema(SettingsSchema(), { unrepresentable: 'any' })
  return jsonStringify(jsonSchema, null, 2)
}
