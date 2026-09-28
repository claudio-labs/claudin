import type { BetaJSONOutputFormat } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

/** The reply the title model must give: an object whose only field is the `title` string. */
export const TITLE_OUTPUT_FORMAT: BetaJSONOutputFormat = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  },
}
