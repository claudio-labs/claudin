/**
 * Reading the title model's reply. Pure: the reply text in, the title or
 * null out.
 */
import { z } from 'zod/v4'

import { safeParseJSON } from 'src/shared/data/json.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'

/** Only `title` is read; any other field in the reply is ignored. */
const TitleReplySchema = lazySchema(() => z.object({ title: z.string() }))

export function parseTitleReply(text: string): string | null {
  // A reply that is not JSON is an answer without a title, not an error to log.
  const parsed = TitleReplySchema().safeParse(safeParseJSON(text, false))
  if (!parsed.success) return null
  const title = parsed.data.title.trim()
  return title.length > 0 ? title : null
}
