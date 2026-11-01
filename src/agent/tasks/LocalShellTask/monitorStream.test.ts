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
  MONITOR_READ_MAX_BYTES,
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
// `expire()` fires the deadline. `running: false` plays a command that already
// ended when the stream tries to kill it; `failReads` fails that many reads.
function harness(options: MonitorStreamOptions = OPTIONS, setup: { running?: boolean; failReads?: number } = {}) {
  let file = Buffer.alloc(0)
  let clock = 0
  let poll: (() => void) | null = null
  let deadline: (() => void) | null = null
  const enqueued: string[] = []
  const reads: number[] = []
  let kills = 0
  let failReads = setup.failReads ?? 0
  let pollCancelled = false
  let deadlineCancelled = false
  const deps: MonitorStreamDeps = {
    async read(fromOffset, maxBytes) {
      expect(maxBytes).toBe(MONITOR_READ_MAX_BYTES)
      reads.push(fromOffset)
      if (failReads > 0) {
        failReads--
        throw new Error('read failed')
      }
      return file.subarray(fromOffset)
    },
    enqueue: message => enqueued.push(message),
    kill: () => {
      kills++
      return setup.running ?? true
    },
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
    write(data: string | Buffer) {
      file = Buffer.concat([file, Buffer.from(data)])
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
  const take = (text: string | Buffer, flush: boolean) => takeCompleteLines(Buffer.from(text), flush)

  test('keeps a trailing partial line for the next read', () => {
    expect(take('a\nb\npar', false)).toEqual({ lines: ['a', 'b'], consumedBytes: 4 })
    expect(take('partial', false)).toEqual({ lines: [], consumedBytes: 0 })
  })

  test('flush takes the partial line too, and CRLF splits like LF', () => {
    expect(take('a\r\nb', true)).toEqual({ lines: ['a', 'b'], consumedBytes: 4 })
    expect(take('a\r\n', false)).toEqual({ lines: ['a'], consumedBytes: 3 })
    expect(take('', true)).toEqual({ lines: [], consumedBytes: 0 })
  })

  test('a newline-less run over the byte cap is taken up to its last whole character', () => {
    const long = 'x'.repeat(MONITOR_EVENT_MAX_BYTES + 1)
    expect(take(long, false)).toEqual({ lines: [long], consumedBytes: long.length })
    // "€" is 3 bytes; with one or two of them read, the run stops before it.
    for (const cut of [1, 2]) {
      const split = Buffer.concat([Buffer.from(long), Buffer.from('€').subarray(0, cut)])
      expect(take(split, false)).toEqual({ lines: [long], consumedBytes: long.length })
    }
    // A whole 4-byte character at the end is kept.
    const emoji = Buffer.from(`${long}😀`)
    expect(take(emoji, false)).toEqual({ lines: [`${long}😀`], consumedBytes: emoji.length })
  })

  test('an invalid byte decodes to U+FFFD but counts as the one byte it is', () => {
    expect(take(Buffer.from([0x61, 0xe9, 0x0a, 0x62]), false)).toEqual({ lines: ['a\uFFFD'], consumedBytes: 3 })
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

  // Review round, PR #337: the cut counted characters against a byte budget,
  // so a line of two-byte characters came out at twice the cap.
  test('cuts a long multi-byte line by bytes, on a character boundary', () => {
    const event = formatMonitorEvent(OPTIONS, ['é'.repeat(3_000)])
    const body = event.slice(event.indexOf('</task-notification>\n') + '</task-notification>\n'.length)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MONITOR_EVENT_MAX_BYTES + Buffer.byteLength('…'))
    expect(body).not.toContain('\uFFFD')
    expect(body.endsWith('é…')).toBe(true)
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

// Review round, PR #337: the offset advanced by the decoded text's length, so
// a byte that is not UTF-8 (U+FFFD, 3 bytes, for 1 byte read) moved it past
// the start of the next line.
describe('startMonitorStream reads bytes, not decoded text', () => {
  test('a non-UTF-8 byte in one line does not eat the start of the next', async () => {
    const h = harness()
    h.write(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])) // Latin-1 "café\n"
    h.tick()
    await drain()
    h.write('next line\n')
    h.tick()
    await drain()
    expect(h.enqueued).toHaveLength(2)
    expect(h.enqueued[1]!.endsWith('\nnext line')).toBe(true)
    await h.finish()
  })

  test('a character split at the end of a long newline-less run is not skipped', async () => {
    const h = harness()
    h.write(Buffer.concat([Buffer.from('a'.repeat(MONITOR_EVENT_MAX_BYTES + 1)), Buffer.from([0xc3])]))
    h.tick()
    await drain()
    h.write(Buffer.concat([Buffer.from([0xa9]), Buffer.from('XYZ tail\n')]))
    h.tick()
    await drain()
    expect(h.enqueued).toHaveLength(2)
    expect(h.enqueued[1]!.endsWith('\néXYZ tail')).toBe(true)
    await h.finish()
  })
})

describe('startMonitorStream ends once', () => {
  // Review round, PR #337: the command can exit on its own in the instant the
  // deadline fires; the exit notice already went out, so a killed notice would
  // be a second, false ending.
  test('a deadline that finds the command already ended posts no notice', async () => {
    const h = harness(OPTIONS, { running: false })
    h.expire()
    await drain()
    expect(h.kills()).toBe(1)
    expect(h.enqueued).toEqual([])
  })

  // A failed read rejected the shared chain: every later poll was skipped and
  // stop() threw, which took the exit notice down with it.
  test('a failed read skips one poll, not the rest of the stream', async () => {
    const h = harness(OPTIONS, { failReads: 1 })
    h.write('lost for a second\n')
    h.tick()
    await drain()
    h.tick()
    await drain()
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]!.endsWith('\nlost for a second')).toBe(true)
    await expect(h.stream.stop({ flush: true })).resolves.toBeUndefined()
  })

  test('a deadline whose last read fails still kills the command and says so', async () => {
    const h = harness(OPTIONS, { failReads: 1 })
    h.expire()
    await drain()
    expect(h.kills()).toBe(1)
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]).toContain('expired after')
    expect(h.cancelled()).toEqual({ poll: true, deadline: true })
  })

  test('a stop whose last read fails still stops polling', async () => {
    const h = harness(OPTIONS, { failReads: 1 })
    await h.stream.stop({ flush: true })
    expect(h.cancelled()).toEqual({ poll: true, deadline: true })
    h.write('late\n')
    h.tick()
    await drain()
    expect(h.enqueued).toEqual([])
  })
})
