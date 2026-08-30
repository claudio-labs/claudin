import { describe, expect, test } from 'bun:test'
import {
  parseExitCode,
  parseHealth,
  parseLabels,
  parsePorts,
  parsePsOutput,
} from 'src/containers/docker/parsePs.js'

const LEGENDARR_LABELS = [
  'com.docker.compose.project=legendarr',
  'com.docker.compose.service=legendarr',
  'com.docker.compose.project.working_dir=/home/dev/projects/legendarr',
].join(',')

function psLine(over: Record<string, string> = {}): string {
  return JSON.stringify({
    ID: 'c0ffee',
    Names: 'legendarr-legendarr-1',
    Image: 'legendarr-legendarr',
    State: 'running',
    Status: 'Up 2 hours',
    Ports: '0.0.0.0:8000->8000/tcp, [::]:8000->8000/tcp',
    Labels: LEGENDARR_LABELS,
    CreatedAt: '2026-08-29 20:31:14 -0300 -03',
    ...over,
  })
}

describe('parseHealth', () => {
  test('reads the three healthcheck verdicts', () => {
    expect(parseHealth('Up 2 hours (healthy)')).toBe('healthy')
    expect(parseHealth('Up 3 minutes (unhealthy)')).toBe('unhealthy')
    expect(parseHealth('Up 5 seconds (health: starting)')).toBe('starting')
  })

  test('a container with no healthcheck reports none, not unhealthy', () => {
    // The distinction `wait until healthy` depends on: `none` must fail fast,
    // `unhealthy` must report the probe output.
    expect(parseHealth('Up 2 hours')).toBe('none')
    expect(parseHealth('Exited (0) 1 minute ago')).toBe('none')
  })
})

describe('parseExitCode', () => {
  test('reads the code out of Exited and Restarting', () => {
    expect(parseExitCode('Exited (137) 3 minutes ago')).toBe(137)
    expect(parseExitCode('Restarting (1) 2 seconds ago')).toBe(1)
    expect(parseExitCode('Exited (0) 1 minute ago')).toBe(0)
  })

  test('a health marker is not an exit code', () => {
    expect(parseExitCode('Up 2 hours (healthy)')).toBeNull()
    expect(parseExitCode('Up 3 minutes (unhealthy)')).toBeNull()
  })

  test('a running container has no exit code', () => {
    expect(parseExitCode('Up 2 hours')).toBeNull()
  })
})

describe('parsePorts', () => {
  test('collapses the IPv4 and IPv6 bindings of one port into one row', () => {
    expect(parsePorts('0.0.0.0:8000->8000/tcp, [::]:8000->8000/tcp')).toEqual([
      { hostPort: 8000, containerPort: 8000, protocol: 'tcp' },
    ])
  })

  test('keeps distinct ports apart', () => {
    expect(parsePorts('0.0.0.0:8000->8000/tcp, 0.0.0.0:8989->8989/tcp')).toEqual(
      [
        { hostPort: 8000, containerPort: 8000, protocol: 'tcp' },
        { hostPort: 8989, containerPort: 8989, protocol: 'tcp' },
      ],
    )
  })

  test('an exposed but unpublished port has no host side', () => {
    expect(parsePorts('8000/tcp')).toEqual([
      { hostPort: null, containerPort: 8000, protocol: 'tcp' },
    ])
  })

  test('empty and undefined are both no ports', () => {
    expect(parsePorts('')).toEqual([])
    expect(parsePorts(undefined)).toEqual([])
  })
})

describe('parseLabels', () => {
  test('splits on the first = so a value may contain one', () => {
    const labels = parseLabels('a=1,b=x=y')
    expect(labels.get('a')).toBe('1')
    expect(labels.get('b')).toBe('x=y')
  })

  test('ignores a bare key with no value', () => {
    expect(parseLabels('novalue').size).toBe(0)
  })
})

describe('parsePsOutput', () => {
  test('parses a compose container end to end', () => {
    const [c] = parsePsOutput(psLine({ Status: 'Up 2 hours (healthy)' }))
    expect(c).toBeDefined()
    expect(c?.id).toBe('c0ffee')
    expect(c?.name).toBe('legendarr-legendarr-1')
    expect(c?.state).toBe('running')
    expect(c?.health).toBe('healthy')
    expect(c?.project).toBe('legendarr')
    expect(c?.service).toBe('legendarr')
    expect(c?.workingDir).toBe('/home/dev/projects/legendarr')
    expect(c?.ports).toEqual([
      { hostPort: 8000, containerPort: 8000, protocol: 'tcp' },
    ])
    expect(c?.createdAt).not.toBeNull()
  })

  test('a docker run container has no compose labels', () => {
    const [c] = parsePsOutput(psLine({ Labels: '' }))
    expect(c?.project).toBeNull()
    expect(c?.service).toBeNull()
    expect(c?.workingDir).toBeNull()
  })

  test('one malformed line does not blank the rest', () => {
    const out = parsePsOutput(
      [psLine(), '{not json', psLine({ ID: 'beef' })].join('\n'),
    )
    expect(out.map(c => c.id)).toEqual(['c0ffee', 'beef'])
  })

  test('falls back to the Status prefix when State is missing', () => {
    const [c] = parsePsOutput(
      psLine({ State: '', Status: 'Exited (137) 3 minutes ago' }),
    )
    expect(c?.state).toBe('exited')
    expect(c?.exitCode).toBe(137)
  })

  test('takes the first name when a container has aliases', () => {
    const [c] = parsePsOutput(psLine({ Names: 'first,second' }))
    expect(c?.name).toBe('first')
  })

  test('an unparseable timestamp is null, not NaN', () => {
    const [c] = parsePsOutput(psLine({ CreatedAt: 'not a date' }))
    expect(c?.createdAt).toBeNull()
  })
})
