import { describe, expect, test } from 'bun:test'
import {
  parseEventLine,
  shouldResnapshot,
} from 'src/containers/docker/parseEvent.js'

function event(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Type: 'container',
    Action: 'start',
    Actor: {
      ID: 'aaaaaaaaaaaa',
      Attributes: {
        name: 'legendarr-legendarr-1',
        'com.docker.compose.project': 'legendarr',
      },
    },
    ...over,
  })
}

describe('parseEventLine', () => {
  test('reads a start event', () => {
    const e = parseEventLine(event())
    expect(e?.action).toBe('start')
    expect(e?.containerId).toBe('aaaaaaaaaaaa')
    expect(e?.name).toBe('legendarr-legendarr-1')
    expect(e?.project).toBe('legendarr')
  })

  test('reads the exit code off a die event', () => {
    const e = parseEventLine(
      event({
        Action: 'die',
        Actor: {
          ID: 'aaaaaaaaaaaa',
          Attributes: { name: 'x', exitCode: '137' },
        },
      }),
    )
    expect(e?.action).toBe('die')
    expect(e?.exitCode).toBe(137)
  })

  test('splits the health verdict out of the action', () => {
    const e = parseEventLine(event({ Action: 'health_status: unhealthy' }))
    expect(e?.action).toBe('health_status')
    expect(e?.health).toBe('unhealthy')
  })

  test('an oom event is flagged — a bare exit 137 is not enough to claim OOM', () => {
    const e = parseEventLine(event({ Action: 'oom' }))
    expect(e?.oomKilled).toBe(true)
    expect(parseEventLine(event({ Action: 'die' }))?.oomKilled).toBe(false)
  })

  test('ignores actions the panel does not react to', () => {
    expect(parseEventLine(event({ Action: 'exec_create: /bin/sh -c ls' }))).toBeNull()
    expect(parseEventLine(event({ Action: 'attach' }))).toBeNull()
    expect(parseEventLine(event({ Action: 'top' }))).toBeNull()
  })

  test('ignores non-container events', () => {
    expect(parseEventLine(event({ Type: 'image', Action: 'pull' }))).toBeNull()
    expect(parseEventLine(event({ Type: 'network', Action: 'connect' }))).toBeNull()
  })

  test('a malformed line is skipped, not thrown on', () => {
    expect(parseEventLine('{not json')).toBeNull()
    expect(parseEventLine('')).toBeNull()
    expect(parseEventLine('some plain text')).toBeNull()
  })

  test('falls back to the legacy flat shape', () => {
    const e = parseEventLine(
      JSON.stringify({ status: 'start', id: 'bbbbbbbbbbbb' }),
    )
    expect(e?.action).toBe('start')
    expect(e?.containerId).toBe('bbbbbbbbbbbb')
  })

  test('a container with no compose labels still parses', () => {
    const e = parseEventLine(
      event({ Actor: { ID: 'cccccccccccc', Attributes: { name: 'plex' } } }),
    )
    expect(e?.project).toBeNull()
  })
})

describe('shouldResnapshot', () => {
  test('any identified container event triggers a re-snapshot', () => {
    expect(shouldResnapshot(parseEventLine(event())!)).toBe(true)
  })

  test('an event with no container id does not', () => {
    const e = parseEventLine(JSON.stringify({ status: 'start' }))
    expect(e).not.toBeNull()
    expect(shouldResnapshot(e!)).toBe(false)
  })
})
