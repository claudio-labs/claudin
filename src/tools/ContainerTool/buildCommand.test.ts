import { describe, expect, test } from 'bun:test'
import {
  buildContainerCommand,
  ContainerCommandError,
  DEFAULT_LOGS_SINCE,
  DEFAULT_LOGS_TAIL,
} from 'src/tools/ContainerTool/buildCommand.js'
import { CONTAINER_OPS, type ContainerToolInput } from 'src/tools/ContainerTool/types.js'

const COMPOSE = 'docker-compose.dev.yml'

function build(input: ContainerToolInput, composeFile?: string) {
  return buildContainerCommand(input, composeFile ? { composeFile } : {})
}

describe('read ops', () => {
  test('ps without a compose file asks docker for parseable JSON', () => {
    expect(build({ op: 'ps' }).argv).toEqual([
      'ps',
      '--all',
      '--no-trunc',
      '--format',
      '{{json .}}',
    ])
  })

  test('ps with a compose file is compose-scoped', () => {
    const built = build({ op: 'ps' }, COMPOSE)
    expect(built.kind).toBe('compose')
    expect(built.argv).toEqual(['compose', '-f', COMPOSE, 'ps'])
  })

  test('inspect targets one container', () => {
    expect(build({ op: 'inspect', service: 'legendarr-1' }).argv).toEqual([
      'inspect',
      'legendarr-1',
    ])
  })

  test('stats never streams — a streaming stats call never returns', () => {
    expect(build({ op: 'stats' }).argv).toContain('--no-stream')
  })

  test('events is bounded by --until, so it terminates', () => {
    const argv = build({ op: 'events' }).argv
    expect(argv).toContain('--until')
    expect(argv[argv.indexOf('--until') + 1]).toBe('0s')
  })

  test('df reports disk usage', () => {
    expect(build({ op: 'df' }).argv).toEqual(['system', 'df'])
  })
})

describe('logs', () => {
  test('always carries a bounded window — never an unbounded dump', () => {
    const argv = build({ op: 'logs', service: 'legendarr-1' }).argv
    expect(argv).toContain('--since')
    expect(argv[argv.indexOf('--since') + 1]).toBe(DEFAULT_LOGS_SINCE)
    expect(argv).toContain('--tail')
    expect(argv[argv.indexOf('--tail') + 1]).toBe(String(DEFAULT_LOGS_TAIL))
  })

  test('carries --timestamps so merged stdout and stderr stay ordered', () => {
    expect(build({ op: 'logs', service: 'x' }).argv).toContain('--timestamps')
  })

  test('an explicit window overrides the default', () => {
    const argv = build({ op: 'logs', service: 'x', since: '2h', tail: 10 }).argv
    expect(argv[argv.indexOf('--since') + 1]).toBe('2h')
    expect(argv[argv.indexOf('--tail') + 1]).toBe('10')
  })

  test('follow is opt-in', () => {
    expect(build({ op: 'logs', service: 'x' }).argv).not.toContain('--follow')
    expect(build({ op: 'logs', service: 'x', follow: true }).argv).toContain(
      '--follow',
    )
  })
})

describe('lifecycle', () => {
  test('up detaches and is compose-scoped even with no file named', () => {
    const built = build({ op: 'up', service: 'legendarr' })
    expect(built.kind).toBe('compose')
    expect(built.argv).toEqual(['compose', 'up', '--detach', 'legendarr'])
  })

  test('down adds --volumes ONLY when asked — it deletes data', () => {
    expect(build({ op: 'down' }, COMPOSE).argv).not.toContain('--volumes')
    expect(build({ op: 'down', volumes: true }, COMPOSE).argv).toContain(
      '--volumes',
    )
  })

  test('restart falls back to plain docker with no compose file', () => {
    const built = build({ op: 'restart', service: 'legendarr-1' })
    expect(built.kind).toBe('docker')
    expect(built.argv).toEqual(['restart', 'legendarr-1'])
  })
})

describe('build', () => {
  test('always adds --progress=plain, which is what makes output parseable', () => {
    expect(build({ op: 'build', service: 'legendarr' }, COMPOSE).argv).toContain(
      '--progress=plain',
    )
    expect(build({ op: 'build' }).argv).toContain('--progress=plain')
  })

  test('is compose-scoped when a compose file is present', () => {
    expect(build({ op: 'build', service: 'legendarr' }, COMPOSE).argv).toEqual([
      'compose',
      '-f',
      COMPOSE,
      'build',
      '--progress=plain',
      'legendarr',
    ])
  })

  test('falls back to a context-directory docker build', () => {
    expect(build({ op: 'build' }).argv).toEqual(['build', '--progress=plain', '.'])
  })
})

describe('exec', () => {
  test('NEVER allocates a TTY — that is what hangs a non-interactive call', () => {
    const plain = build({ op: 'exec', service: 'x', command: ['ls'] })
    expect(plain.argv).not.toContain('-t')
    expect(plain.argv).not.toContain('-it')
    expect(plain.argv).not.toContain('--tty')

    const compose = build(
      { op: 'exec', service: 'x', command: ['ls'] },
      COMPOSE,
    )
    expect(compose.argv).not.toContain('-t')
    expect(compose.argv).toContain('--no-TTY')
  })

  test('adds -i only when stdin is actually supplied', () => {
    expect(
      build({ op: 'exec', service: 'x', command: ['ls'] }).argv,
    ).not.toContain('-i')
    expect(
      build({ op: 'exec', service: 'x', command: ['cat'], stdin: 'hi' }).argv,
    ).toContain('-i')
  })

  test('the command is passed as separate argv entries', () => {
    const argv = build({
      op: 'exec',
      service: 'x',
      command: ['python3', '-c', 'print(1); print(2)'],
    }).argv
    expect(argv.slice(-3)).toEqual(['python3', '-c', 'print(1); print(2)'])
  })

  test('refuses to build without a command', () => {
    expect(() => build({ op: 'exec', service: 'x' })).toThrow(
      ContainerCommandError,
    )
  })
})

describe('destructive', () => {
  test('prune defaults to images and never prompts docker itself', () => {
    expect(build({ op: 'prune' }).argv).toEqual(['image', 'prune', '--force'])
    expect(build({ op: 'prune', target: 'volume' }).argv).toEqual([
      'volume',
      'prune',
      '--force',
    ])
    expect(build({ op: 'prune', target: 'system' }).argv).toEqual([
      'system',
      'prune',
      '--force',
    ])
  })

  test('rm and rmi need a target', () => {
    expect(() => build({ op: 'rm' })).toThrow(ContainerCommandError)
    expect(() => build({ op: 'rmi' })).toThrow(ContainerCommandError)
  })
})

describe('cp and tag', () => {
  test('cp needs both endpoints', () => {
    expect(build({ op: 'cp', source: 'a:/x', dest: './x' }).argv).toEqual([
      'cp',
      'a:/x',
      './x',
    ])
    expect(() => build({ op: 'cp', source: 'a:/x' })).toThrow(
      ContainerCommandError,
    )
  })

  test('tag needs both endpoints', () => {
    expect(build({ op: 'tag', source: 'img', dest: 'img:v2' }).argv).toEqual([
      'tag',
      'img',
      'img:v2',
    ])
    expect(() => build({ op: 'tag', source: 'img' })).toThrow(
      ContainerCommandError,
    )
  })
})

describe('argv injection', () => {
  test('extra args stay separate entries, never a joined shell string', () => {
    const argv = build({ op: 'ps', args: ['--filter', 'name=a; rm -rf /'] }).argv
    expect(argv).toContain('name=a; rm -rf /')
    // If it had been joined, the semicolon would have split into two entries.
    expect(argv.filter(a => a.includes('rm -rf'))).toHaveLength(1)
  })

  test('commandString quotes a token the shell would otherwise split', () => {
    const built = build({ op: 'ps', args: ['name=a; rm -rf /'] })
    expect(built.commandString).toContain(`'name=a; rm -rf /'`)
  })

  test('commandString escapes an embedded single quote', () => {
    const built = build({ op: 'exec', service: 'x', command: ["it's"] })
    expect(built.commandString).toContain(`'it'\\''s'`)
  })

  test('a plain token is left unquoted', () => {
    expect(build({ op: 'inspect', service: 'legendarr-1' }).commandString).toBe(
      'docker inspect legendarr-1',
    )
  })
})

describe('every op is buildable', () => {
  test('no op is missing from the builder table', () => {
    // A new op added to the union without a row here would throw, and the
    // failure would otherwise only surface at call time.
    const complete: ContainerToolInput = {
      op: 'ps',
      service: 'svc',
      command: ['ls'],
      source: 'a',
      dest: 'b',
    }
    for (const op of CONTAINER_OPS) {
      expect(() => build({ ...complete, op })).not.toThrow()
    }
  })
})
