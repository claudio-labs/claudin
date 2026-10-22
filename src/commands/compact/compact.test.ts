import { expect, test } from 'bun:test'

import { call } from 'src/commands/compact/compact.js'

type CompactContext = Parameters<typeof call>[1]

test('an empty conversation is refused before anything is compacted', async () => {
  const context = {
    messages: [],
    abortController: new AbortController(),
  } as unknown as CompactContext
  await expect(call('', context)).rejects.toThrow('No messages to compact')
})
