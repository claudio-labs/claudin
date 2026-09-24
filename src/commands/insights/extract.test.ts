// The languages tally in a session's meta (logToSessionMeta). A batch Read
// (CLAUDIN_READ_MULTI, readMulti.ts) names its files in file_paths and has no
// file_path, so the tally used to count none of them.
import { describe, expect, test } from 'bun:test'
import { logToSessionMeta } from 'src/commands/insights/extract.js'
import type { LogOption } from 'src/shared/types/logs.js'

function logOf(inputs: unknown[]): LogOption {
  return {
    created: new Date('2026-09-24T10:00:00Z'),
    modified: new Date('2026-09-24T10:30:00Z'),
    messages: [
      {
        type: 'assistant',
        timestamp: '2026-09-24T10:00:01Z',
        message: {
          role: 'assistant',
          content: inputs.map((input, i) => ({
            type: 'tool_use',
            id: `toolu_${i}`,
            name: 'Read',
            input,
          })),
        },
      },
    ],
  } as unknown as LogOption
}

describe('logToSessionMeta — languages', () => {
  test('a batch Read counts the language of every file it names', () => {
    const meta = logToSessionMeta(logOf([{ file_paths: ['/r/a.ts', '/r/b.ts', '/r/c.py'] }]))
    expect(meta.languages).toEqual({ TypeScript: 2, Python: 1 })
  })

  test('a single Read counts its one file, as Codex stores it too', () => {
    const meta = logToSessionMeta(
      logOf([{ file_path: '/r/a.ts' }, { file_path: '/r/b.py', file_paths: null }]),
    )
    expect(meta.languages).toEqual({ TypeScript: 1, Python: 1 })
  })
})
