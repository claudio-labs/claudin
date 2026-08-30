import { describe, expect, test } from 'bun:test'
import {
  containerRowLabel,
  portSummary,
  shortContainerName,
} from 'src/agent/ui/tasks/containerRowLabel.js'
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'
import type { ContainerInfo } from 'src/containers/types.js'

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'c0ffee',
    name: 'legendarr-legendarr-1',
    image: 'legendarr',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    exitCode: null,
    ports: [{ hostPort: 8000, containerPort: 8000, protocol: 'tcp' }],
    project: 'legendarr',
    service: 'legendarr',
    workingDir: '/home/dev/projects/legendarr',
    createdAt: null,
    ...over,
  }
}

function task(
  over: Partial<ContainerInfo> = {},
  restartCount = 0,
): ContainerTaskState {
  return {
    id: 'cc0ffee',
    type: 'container',
    status: 'running',
    description: 'legendarr',
    startTime: 0,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    container: container(over),
    startedByUs: false,
    restartCount,
    lastNotifiedSignature: null,
    diedAt: null,
  }
}

describe('shortContainerName', () => {
  test('drops the compose project prefix but keeps the replica index', () => {
    expect(shortContainerName(container())).toBe('legendarr-1')
    expect(
      shortContainerName(container({ name: 'legendarr-worker-3', service: 'worker' })),
    ).toBe('worker-3')
  })

  test('leaves a name that does not carry the prefix alone', () => {
    expect(shortContainerName(container({ name: 'plex', project: null }))).toBe(
      'plex',
    )
  })
})

describe('portSummary', () => {
  test('lists published host ports, deduped and sorted', () => {
    const c = container({
      ports: [
        { hostPort: 8989, containerPort: 8989, protocol: 'tcp' },
        { hostPort: 8000, containerPort: 8000, protocol: 'tcp' },
        { hostPort: 8000, containerPort: 8000, protocol: 'udp' },
      ],
    })
    expect(portSummary(c)).toBe(':8000 :8989')
  })

  test('an unpublished port contributes nothing', () => {
    expect(
      portSummary(
        container({ ports: [{ hostPort: null, containerPort: 8000, protocol: 'tcp' }] }),
      ),
    ).toBe('')
  })
})

describe('containerRowLabel', () => {
  test('a plain running container says up, not healthy', () => {
    // Most images declare no healthcheck; claiming health we never measured
    // would be the one thing the panel must not do.
    expect(containerRowLabel(task())).toBe('legendarr-1 · up · :8000')
  })

  test('reports a passing and a failing healthcheck differently', () => {
    expect(containerRowLabel(task({ health: 'healthy' }))).toContain('healthy')
    expect(containerRowLabel(task({ health: 'unhealthy' }))).toContain('unhealthy')
    expect(containerRowLabel(task({ health: 'starting' }))).toContain('starting')
  })

  test('an exited container carries its exit code', () => {
    expect(
      containerRowLabel(
        task({ state: 'exited', status: 'Exited (137) 1 minute ago', exitCode: 137 }),
      ),
    ).toBe('legendarr-1 · exited (137)')
  })

  test('a restart loop shows its count', () => {
    expect(containerRowLabel(task({ state: 'restarting' }, 4))).toBe(
      'legendarr-1 · restarting x4',
    )
  })

  test('paused is called out — it reads as running but serves nothing', () => {
    expect(containerRowLabel(task({ state: 'paused' }))).toBe(
      'legendarr-1 · paused',
    )
  })

  test('a stopped container does not advertise ports', () => {
    expect(
      containerRowLabel(task({ state: 'exited', exitCode: 0 })),
    ).not.toContain(':8000')
  })

  test('is a single line — the tree paints one Text per row', () => {
    expect(containerRowLabel(task())).not.toContain('\n')
  })
})
