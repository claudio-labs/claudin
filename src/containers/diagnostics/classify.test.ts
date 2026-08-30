import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  CRASH_LOOP_RESTART_THRESHOLD,
  classifyCommandFailure,
  classifyContainer,
  decodeSignal,
  diagnoseNoHealthcheck,
} from 'src/containers/diagnostics/classify.js'
import type { ContainerInfo } from 'src/containers/types.js'

const FIXTURES = resolve(import.meta.dir, '__fixtures__')
const fixture = (name: string): string =>
  readFileSync(resolve(FIXTURES, name), 'utf8')

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'c0ffee',
    name: 'legendarr-legendarr-1',
    image: 'legendarr',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    exitCode: null,
    ports: [],
    project: 'legendarr',
    service: 'legendarr',
    workingDir: '/home/dev/projects/legendarr',
    createdAt: null,
    ...over,
  }
}

describe('decodeSignal', () => {
  test('names the signals people actually see', () => {
    expect(decodeSignal(137)).toBe('SIGKILL')
    expect(decodeSignal(139)).toBe('SIGSEGV')
    expect(decodeSignal(143)).toBe('SIGTERM')
    expect(decodeSignal(130)).toBe('SIGINT')
    expect(decodeSignal(134)).toBe('SIGABRT')
  })

  test('reports an unnamed signal by number rather than guessing', () => {
    expect(decodeSignal(128 + 17)).toBe('signal 17')
  })

  test('an ordinary exit code is not a signal', () => {
    expect(decodeSignal(1)).toBeNull()
    expect(decodeSignal(100)).toBeNull()
    expect(decodeSignal(128)).toBeNull()
  })

  test('a code past the signal range is not a signal', () => {
    expect(decodeSignal(255)).toBeNull()
  })
})

describe('classifyContainer', () => {
  test('a healthy running container is not a diagnosis', () => {
    expect(classifyContainer(container({ health: 'healthy' }))).toBeNull()
    expect(classifyContainer(container())).toBeNull()
  })

  test('a clean exit is not a diagnosis', () => {
    const done = container({
      state: 'exited',
      status: 'Exited (0) 1 minute ago',
      exitCode: 0,
    })
    expect(classifyContainer(done)).toBeNull()
  })

  test('137 alone reports SIGKILL, not OOM', () => {
    const killed = container({
      state: 'exited',
      status: 'Exited (137) 3 minutes ago',
      exitCode: 137,
    })
    const d = classifyContainer(killed)
    expect(d?.kind).toBe('exit-signal')
    expect(d?.summary).toContain('SIGKILL')
    expect(d?.summary).not.toContain('OOM')
  })

  test('the same 137 becomes an OOM once inspect says so', () => {
    const killed = container({
      state: 'exited',
      status: 'Exited (137) 3 minutes ago',
      exitCode: 137,
    })
    const d = classifyContainer(killed, { oomKilled: true })
    expect(d?.kind).toBe('oom-killed')
    expect(d?.summary).toContain('OOM')
  })

  test('the OOM summary carries the memory limit when known', () => {
    const d = classifyContainer(
      container({ state: 'exited', exitCode: 137, status: 'Exited (137)' }),
      { oomKilled: true, memoryLimitBytes: 128 * 1024 * 1024 },
    )
    expect(d?.summary).toContain('128MB')
  })

  test('a non-signal failure is an ordinary exit error', () => {
    const d = classifyContainer(
      container({ state: 'exited', exitCode: 1, status: 'Exited (1) 5s ago' }),
    )
    expect(d?.kind).toBe('exit-error')
    expect(d?.summary).toContain('code 1')
  })

  test('a restart loop is reported with its count, not as a bare restarting', () => {
    const d = classifyContainer(
      container({
        state: 'restarting',
        status: 'Restarting (1) 2 seconds ago',
        exitCode: 1,
      }),
      { restartCount: CRASH_LOOP_RESTART_THRESHOLD + 4 },
    )
    expect(d?.kind).toBe('crash-loop')
    expect(d?.summary).toContain('7 restarts')
    expect(d?.summary).toContain('last exit 1')
  })

  test('the loop wins over the exit code it carries', () => {
    const d = classifyContainer(
      container({ state: 'restarting', exitCode: 137, status: 'Restarting (137)' }),
      { restartCount: 9 },
    )
    expect(d?.kind).toBe('crash-loop')
  })

  test('paused is a diagnosis because it reads as running', () => {
    const d = classifyContainer(
      container({ state: 'paused', status: 'Up 2 hours (Paused)' }),
    )
    expect(d?.kind).toBe('paused')
    expect(d?.summary).toContain('not serving')
  })

  test('dead is a diagnosis', () => {
    expect(classifyContainer(container({ state: 'dead' }))?.kind).toBe('dead')
  })

  test('unhealthy is a diagnosis', () => {
    const d = classifyContainer(container({ health: 'unhealthy' }))
    expect(d?.kind).toBe('unhealthy')
  })

  test('a container with no healthcheck is NOT flagged by default', () => {
    // Most images declare none; firing here would flag every normal container.
    expect(classifyContainer(container({ health: 'none' }))).toBeNull()
  })
})

describe('diagnoseNoHealthcheck', () => {
  test('fires only for the opt-in wait case', () => {
    const d = diagnoseNoHealthcheck(container({ health: 'none' }))
    expect(d?.kind).toBe('no-healthcheck')
    expect(d?.summary).toContain('never report healthy')
  })

  test('a container that has a healthcheck is fine', () => {
    expect(diagnoseNoHealthcheck(container({ health: 'healthy' }))).toBeNull()
    expect(diagnoseNoHealthcheck(container({ health: 'starting' }))).toBeNull()
  })
})

describe('classifyCommandFailure', () => {
  test('empty output is not a diagnosis', () => {
    expect(classifyCommandFailure('')).toBeNull()
    expect(classifyCommandFailure('   \n  ')).toBeNull()
  })

  test('port conflict names the port', () => {
    const d = classifyCommandFailure(fixture('port-conflict.txt'))
    expect(d?.kind).toBe('port-conflict')
    expect(d?.summary).toContain('8000')
    expect(d?.evidence).toContain('address already in use')
  })

  test('the older port-conflict wording is recognised too', () => {
    const d = classifyCommandFailure(
      'Error starting userland proxy: Bind for 0.0.0.0:8989 failed: port is already allocated',
    )
    expect(d?.kind).toBe('port-conflict')
    expect(d?.summary).toContain('8989')
  })

  test('a denied pull is reported as a pull denial', () => {
    const d = classifyCommandFailure(fixture('image-pull-denied.txt'))
    expect(d?.kind).toBe('image-pull-denied')
  })

  test('a message containing "not found" is not misread as a missing docker binary', () => {
    // The environment matcher's `not found` arm is broad by design, so it runs
    // LAST. Moving it first turns each of these into `not-installed`; that is
    // what this and the two build cases below pin.
    expect(
      classifyCommandFailure(
        'Error response from daemon: manifest for acme/app:v9 not found: manifest unknown',
      )?.kind,
    ).toBe('image-not-found')
    expect(
      classifyCommandFailure('failed to solve: secret npmrc not found', {
        context: 'build',
      })?.kind,
    ).toBe('build-secret-missing')
  })

  test('a rate limit wins over the access-denied line it comes with', () => {
    const d = classifyCommandFailure(
      'toomanyrequests: You have reached your pull rate limit.\ndenied: requested access to the resource is denied',
    )
    expect(d?.kind).toBe('registry-rate-limited')
  })

  test('a missing tag is image-not-found', () => {
    const d = classifyCommandFailure(
      'Error response from daemon: manifest for acme/app:v9 not found: manifest unknown',
    )
    expect(d?.kind).toBe('image-not-found')
  })

  test('a failed dependency names the dependency, not the caller', () => {
    const d = classifyCommandFailure(fixture('dependency-unhealthy.txt'))
    expect(d?.kind).toBe('dependency-unhealthy')
    expect(d?.summary).toContain('legendarr-sonarr-1')
  })

  test('a typo in a service name is named', () => {
    const d = classifyCommandFailure('no such service: legendar')
    expect(d?.kind).toBe('no-such-service')
    expect(d?.summary).toContain('legendar')
  })

  test('a mount failure is its own verdict', () => {
    const d = classifyCommandFailure(
      'Error response from daemon: error while creating mount source path \'/home/dev/media\': mkdir /home/dev/media: permission denied',
    )
    expect(d?.kind).toBe('mount-failed')
  })

  test('an unset variable is reported', () => {
    const d = classifyCommandFailure(
      'WARN[0000] The "SONARR_API_KEY" variable is not set. Defaulting to a blank string.',
    )
    expect(d?.kind).toBe('unset-variable')
  })

  test('a compose file error is reported', () => {
    const d = classifyCommandFailure(
      'yaml: line 12: did not find expected key',
    )
    expect(d?.kind).toBe('compose-file-error')
  })

  test('out of disk reads differently in a build than at run time', () => {
    const msg = 'write /var/lib/docker/tmp/x: no space left on device'
    expect(classifyCommandFailure(msg)?.kind).toBe('no-space-left')
    expect(classifyCommandFailure(msg, { context: 'build' })?.kind).toBe(
      'build-no-space',
    )
  })

  test('a missing COPY source names the path', () => {
    const d = classifyCommandFailure(fixture('build-copy-missing.txt'), {
      context: 'build',
    })
    expect(d?.kind).toBe('build-copy-missing')
    expect(d?.summary).toContain('/requirements.txt')
  })

  test('a network failure inside a RUN step is build-network', () => {
    const d = classifyCommandFailure(fixture('build-network.txt'), {
      context: 'build',
    })
    expect(d?.kind).toBe('build-network')
    expect(d?.evidence).toContain('Temporary failure resolving')
  })

  test('a missing build secret is reported', () => {
    const d = classifyCommandFailure(
      'failed to solve: secret npmrc not found',
      { context: 'build' },
    )
    expect(d?.kind).toBe('build-secret-missing')
  })

  test('a missing buildx builder is reported', () => {
    const d = classifyCommandFailure('ERROR: no builder "mybuilder" found')
    expect(d?.kind).toBe('build-builder-missing')
  })

  test('daemon down is recognised, and last in the order', () => {
    const d = classifyCommandFailure(
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    )
    expect(d?.kind).toBe('daemon-not-running')
  })

  test('a socket permission error says so, not "not found"', () => {
    const d = classifyCommandFailure(
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
    )
    expect(d?.kind).toBe('permission-denied')
    expect(d?.summary).toContain('docker` group')
  })

  test('output with nothing recognisable is null, not a wrong guess', () => {
    expect(classifyCommandFailure('something went sideways')).toBeNull()
  })

  test('stdout is searched too, since compose writes errors there', () => {
    const d = classifyCommandFailure('', {
      stdout: 'dependency failed to start: container legendarr-db-1 is unhealthy',
    })
    expect(d?.kind).toBe('dependency-unhealthy')
    expect(d?.summary).toContain('legendarr-db-1')
  })
})
