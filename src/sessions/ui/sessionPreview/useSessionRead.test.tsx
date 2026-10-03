import { describe, expect, test } from 'bun:test'
import React from 'react'
import { mountInApp, useResumeWorld } from 'src/sessions/ui/__testutils__/resumeRig.js'
import { previewFooter, type SessionRead, useSessionRead } from 'src/sessions/ui/sessionPreview/useSessionRead.js'
import type { LogOption } from 'src/shared/types/logs.js'

const TIMEOUT = 20_000
useResumeWorld()

const NOW = new Date('2026-10-03T12:00:00Z')

function entry(sessionId: string, extra: Partial<LogOption> = {}): LogOption {
  return { sessionId, messages: [], messageCount: 0, modified: NOW, ...extra } as LogOption
}

describe('previewFooter', () => {
  const cases: Array<{ name: string; log: Partial<LogOption>; expected: string }> = [
    { name: 'with a branch', log: { messageCount: 3, gitBranch: 'parser-fix' }, expected: '30m ago · 3 messages · parser-fix' },
    { name: 'without a branch', log: { messageCount: 3 }, expected: '30m ago · 3 messages' },
    { name: 'empty', log: { messageCount: 0, gitBranch: 'main' }, expected: '30m ago · 0 messages · main' },
  ]
  for (const { name, log, expected } of cases) {
    test(name, () => {
      const modified = new Date(NOW.getTime() - 30 * 60_000)
      expect(previewFooter(entry('s', { ...log, modified }), NOW)).toBe(expected)
    })
  }
})

describe('useSessionRead', () => {
  /** A reader whose reads finish when the test says so. */
  function heldReader() {
    const pending = new Map<string, (log: LogOption) => void>()
    const read = (log: LogOption) =>
      new Promise<LogOption>(resolve => {
        pending.set(log.sessionId!, resolve)
      })
    const finish = (sessionId: string, messageCount: number) =>
      pending.get(sessionId)!(entry(sessionId, { messageCount }))
    return { read, finish }
  }

  async function host(first: LogOption, read: (log: LogOption) => Promise<LogOption>) {
    let seen: SessionRead | undefined
    let show: (log: LogOption) => void = () => undefined
    function Host(): null {
      const [log, setLog] = React.useState(first)
      show = setLog
      seen = useSessionRead(log, read)
      return null
    }
    await mountInApp(<Host />)
    await Bun.sleep(50)
    return {
      seen: () => seen!,
      show: async (log: LogOption) => {
        show(log)
        await Bun.sleep(50)
      },
    }
  }

  test('a read that finishes after the preview moved to another session is dropped', async () => {
    const reader = heldReader()
    const first = entry('first')
    const second = entry('second')
    const rig = await host(first, reader.read)
    expect(rig.seen()).toEqual({ log: first, loading: true })

    await rig.show(second)
    reader.finish('second', 4)
    await Bun.sleep(50)
    reader.finish('first', 3)
    await Bun.sleep(50)
    expect(rig.seen().loading).toBe(false)
    expect(rig.seen().log.sessionId).toBe('second')
    expect(rig.seen().log.messageCount).toBe(4)
  }, TIMEOUT)

  test('while the new session is read, the old result is not shown', async () => {
    const reader = heldReader()
    const rig = await host(entry('first'), reader.read)
    reader.finish('first', 3)
    await Bun.sleep(50)
    expect(rig.seen().log.messageCount).toBe(3)

    const second = entry('second')
    await rig.show(second)
    expect(rig.seen()).toEqual({ log: second, loading: true })
  }, TIMEOUT)

  test('a failed read shows the entry as it was given', async () => {
    const given = entry('broken')
    const rig = await host(given, () => Promise.reject(new Error('unreadable')))
    expect(rig.seen()).toEqual({ log: given, loading: false })
  }, TIMEOUT)
})
