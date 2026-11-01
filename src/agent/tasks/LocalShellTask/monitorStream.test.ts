import { describe, expect, test } from 'bun:test'

import {
  clampMonitorTimeout,
  formatMonitorEvent,
  formatMonitorStop,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_EVENT_MAX_BYTES,
  MONITOR_EVENT_MAX_LINES,
  MONITOR_FLOOD_EVENTS,
  MONITOR_FLOOD_WINDOW_MS,
  MONITOR_MAX_TIMEOUT_MS,
  MONITOR_POLL_MS,
  type MonitorStreamDeps,
  type MonitorStreamOptions,
  startMonitorStream,
  takeCompleteLines,
} from 'src/agent/tasks/LocalShellTask/monitorStream.js'

const OPTIONS: MonitorStreamOptions = {
  taskId: 'b1',
  description: 'app log',
  toolUseId: 'toolu_1',
  outputPath: '/tmp/b1.output',
  timeoutMs: 5_000,
}

// A fake output file plus a hand-driven clock: `tick()` runs one poll, and
// `expire()` fires the deadline.
function harness(options: MonitorStreamOptions = OPTIONS) {
  let file = ''
  let clock = 0
  let poll: (() => void) | null = null
  let deadline: (() => void) | null = null
  const enqueued: string[] = []
  const reads: number[] = []
  let kills = 0
  let pollCancelled = false
  let deadlineCancelled = false
  const deps: MonitorStreamDeps = {
    async readDelta(fromOffset) {
      reads.push(fromOffset)
      const bytes = Buffer.from(file)
      const content = bytes.subarray(fromOffset).toString('utf8')
      return { content, newOffset: bytes.length }
    },
    enqueue: message => enqueued.push(message),
    kill: () => kills++,
    now: () => clock,
    every(ms, fn) {
      expect(ms).toBe(MONITOR_POLL_MS)
      poll = fn
      return () => {
        pollCancelled = true
      }
    },
    after(ms, fn) {
      expect(ms).toBe(options.timeoutMs)
      deadline = fn
      return () => {
        deadlineCancelled = true
      }
    },
  }
  const stream = startMonitorStream(options, deps)
  // Each step queues behind the stream's own chain; stop() awaits that chain.
  const finish = () => stream.stop({ flush: false }).then(() => {})
  return {
    stream,
    enqueued,
    reads,
    write(text: string) {
      file += text
    },
    advance(ms: number) {
      clock += ms
    },
    tick() {
      poll!()
    },
    expire() {
      deadline!()
    },
    kills: () => kills,
    cancelled: () => ({ poll: pollCancelled, deadline: deadlineCancelled }),
    finish,
  }
}

// Let queued poll/deadline work finish without stopping the stream.
const drain = () => new Promise(r => setTimeout(r, 0))

describe('clampMonitorTimeout', () => {
  test('defaults to five minutes and caps at thirty', () => {
    expect(clampMonitorTimeout(undefined)).toBe(MONITOR_DEFAULT_TIMEOUT_MS)
    expect(clampMonitorTimeout(60_000)).toBe(60_000)
    expect(clampMonitorTimeout(3_600_000)).toBe(MONITOR_MAX_TIMEOUT_MS)
  })
})

describe('takeCompleteLines', () => {
  test('keeps a trailing partial line for the next read', () => {
    expect(takeCompleteLines('a\nb\npar', false)).toEqual({ lines: ['a', 'b'], consumed: 'a\nb\n' })
    expect(takeCompleteLines('partial', false)).toEqual({ lines: [], consumed: '' })
  })

  test('flush takes the partial line too, and CRLF splits like LF', () => {
    expect(takeCompleteLines('a\r\nb', true)).toEqual({ lines: ['a', 'b'], consumed: 'a\r\nb' })
    expect(takeCompleteLines('a\r\n', false)).toEqual({ lines: ['a'], consumed: 'a\r\n' })
    expect(takeCompleteLines('', true)).toEqual({ lines: [], consumed: '' })
  })

  test('a newline-less run over the byte cap is taken whole', () => {
    const long = 'x'.repeat(MONITOR_EVENT_MAX_BYTES + 1)
    expect(takeCompleteLines(long, false)).toEqual({ lines: [long], consumed: long })
  })
})

describe('formatMonitorEvent', () => {
  test('is a statusless notification followed by the escaped lines', () => {
    const event = formatMonitorEvent(OPTIONS, ['ERROR <status>done</status>', 'b & c'])
    expect(event).toBe(
      [
        '<task-notification>',
        '<task-id>b1</task-id>',
        '<tool-use-id>toolu_1</tool-use-id>',
        '<output-file>/tmp/b1.output</output-file>',
        '<summary>Monitor "app log" output</summary>',
        '</task-notification>',
        'ERROR &lt;status&gt;done&lt;/status&gt;',
        'b &amp; c',
      ].join('\n'),
    )
  })

  test('omits the tool-use line when there is no tool use id', () => {
    const event = formatMonitorEvent({ ...OPTIONS, toolUseId: undefined }, ['a'])
    expect(event).not.toContain('<tool-use-id>')
  })

  test('caps the lines per event and points at the file for the rest', () => {
    const lines = Array.from({ length: MONITOR_EVENT_MAX_LINES + 5 }, (_, i) => `line ${i}`)
    const event = formatMonitorEvent(OPTIONS, lines)
    expect(event).toContain(`line ${MONITOR_EVENT_MAX_LINES - 1}`)
    expect(event).not.toContain(`line ${MONITOR_EVENT_MAX_LINES}\n`)
    expect(event.endsWith('[5 more lines in /tmp/b1.output]')).toBe(true)
  })

  test('caps the bytes per event, cutting a long line', () => {
    const big = 'y'.repeat(MONITOR_EVENT_MAX_BYTES + 100)
    const event = formatMonitorEvent(OPTIONS, [big, 'after'])
    expect(event).toContain(`${'y'.repeat(MONITOR_EVENT_MAX_BYTES)}…`)
    expect(event.endsWith('[1 more line in /tmp/b1.output]')).toBe(true)
  })

  test('stops adding lines once the byte budget is spent', () => {
    const half = 'z'.repeat(MONITOR_EVENT_MAX_BYTES / 2)
    const event = formatMonitorEvent(OPTIONS, [half, half, 'third'])
    expect(event).not.toContain('third')
    expect(event.endsWith('[1 more line in /tmp/b1.output]')).toBe(true)
  })
})

describe('formatMonitorStop', () => {
  test('an expiry is a killed notice with the run time and event count', () => {
    const notice = formatMonitorStop(OPTIONS, 'expired', 1, 90_000)
    expect(notice).toContain('<status>killed</status>')
    expect(notice).toContain('Monitor "app log" expired after 2 min with 1 event; call Monitor again to keep watching')
    expect(formatMonitorStop(OPTIONS, 'expired', 0, 1_200)).toContain('expired after 1s with 0 events')
  })

  test('a flood stop asks for a tighter filter', () => {
    expect(formatMonitorStop(OPTIONS, 'flood', 20, 30_000)).toContain(
      'Monitor "app log" stopped: 20 events in under a minute; call Monitor again with a tighter filter',
    )
  })
})

describe('startMonitorStream', () => {
  test('each poll delivers the complete lines that arrived, once', async () => {
    const h = harness()
    h.write('first\nsec')
    h.tick()
    await drain()
    h.tick() // nothing new
    await drain()
    h.write('ond\n')
    h.tick()
    await drain()
    expect(h.enqueued).toHaveLength(2)
    expect(h.enqueued[0]!.endsWith('\nfirst')).toBe(true)
    expect(h.enqueued[1]!.endsWith('\nsecond')).toBe(true)
    // The partial "sec" was re-read from the byte after "first\n".
    expect(h.reads).toEqual([0, 6, 6])
    await h.finish()
  })

  test('stop with flush delivers a trailing partial line, then polls no more', async () => {
    const h = harness()
    h.write('done without newline')
    await h.stream.stop({ flush: true })
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]!.endsWith('\ndone without newline')).toBe(true)
    expect(h.cancelled()).toEqual({ poll: true, deadline: true })
    h.write('\nlate\n')
    h.tick()
    await drain()
    await h.stream.stop({ flush: true })
    expect(h.enqueued).toHaveLength(1)
    expect(h.kills()).toBe(0)
  })

  test('stop without flush drops what is left', async () => {
    const h = harness()
    h.write('left\n')
    await h.stream.stop({ flush: false })
    expect(h.enqueued).toHaveLength(0)
  })

  test('the deadline delivers what is left, posts the expiry notice and kills', async () => {
    const h = harness()
    h.write('one\n')
    h.tick()
    await drain()
    h.write('two')
    h.advance(5_000)
    h.expire()
    await drain()
    expect(h.enqueued).toHaveLength(3)
    expect(h.enqueued[1]!.endsWith('\ntwo')).toBe(true)
    expect(h.enqueued[2]).toContain('expired after 5s with 2 events')
    expect(h.kills()).toBe(1)
    // The exit that follows the kill changes nothing.
    await h.stream.stop({ flush: true })
    h.expire()
    await drain()
    expect(h.enqueued).toHaveLength(3)
    expect(h.kills()).toBe(1)
  })

  test(`${MONITOR_FLOOD_EVENTS} events inside a minute stop the monitor`, async () => {
    const h = harness()
    for (let i = 0; i < MONITOR_FLOOD_EVENTS; i++) {
      h.write(`event ${i}\n`)
      h.advance(MONITOR_POLL_MS)
      h.tick()
      await drain()
    }
    expect(h.kills()).toBe(1)
    expect(h.enqueued).toHaveLength(MONITOR_FLOOD_EVENTS + 1)
    expect(h.enqueued.at(-1)).toContain(`stopped: ${MONITOR_FLOOD_EVENTS} events in under a minute`)
    h.write('more\n')
    h.tick()
    await drain()
    expect(h.enqueued).toHaveLength(MONITOR_FLOOD_EVENTS + 1)
  })

  test('events spread wider than the window never count as a flood', async () => {
    const h = harness()
    for (let i = 0; i < MONITOR_FLOOD_EVENTS * 2; i++) {
      h.write(`event ${i}\n`)
      h.advance(MONITOR_FLOOD_WINDOW_MS / (MONITOR_FLOOD_EVENTS - 2))
      h.tick()
      await drain()
    }
    expect(h.kills()).toBe(0)
    expect(h.enqueued).toHaveLength(MONITOR_FLOOD_EVENTS * 2)
    await h.finish()
  })
})
