import { expect, test } from 'bun:test'
import type { Attachment } from 'src/agent/attachments/attachments.js'
import { normalizeAttachmentForAPI } from 'src/agent/messages/attachments.js'
import { ATTACHMENT_PERSISTENCE } from 'src/sessions/pure/attachmentPersistence.js'

// `skip` claims the renderer returns [] for ANY payload — nothing a resumed
// request could miss. A bare payload cannot prove that for every type (one
// that returns [] on empty content passes here too), but a type that renders
// from its fields throws or renders on it, which is the usual mistake.
// The types that must persist are pinned by resumePrefixDeterminism.test.ts.
test('every attachment type the transcript skips renders nothing to the API', () => {
  const skipped = Object.entries(ATTACHMENT_PERSISTENCE)
    .filter(([, policy]) => policy === 'skip')
    .map(([type]) => type)
  expect(skipped.length).toBeGreaterThan(0)

  for (const type of skipped) {
    const rendered = normalizeAttachmentForAPI({ type } as Attachment)
    expect({ type, rendered }).toEqual({ type, rendered: [] })
  }
})
