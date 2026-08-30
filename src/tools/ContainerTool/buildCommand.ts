// Pure op → argv builder.
//
// This is the load-bearing piece of the tool: BOTH the runner and the
// permission check consume it, so what gets approved and what gets executed
// cannot drift apart. The permission check reads `commandString`; the runner
// reads `argv`. Nothing ever executes `commandString`.
//
// Table-driven rather than a 25-arm switch, per .claudin/rules/code-design.md
// §2 — the extension points in this tree are tables, and a new op should be a
// row here plus a test, not another branch.

import { dockerBin } from 'src/containers/docker/dockerCli.js'
import type {
  BuiltCommand,
  ContainerOp,
  ContainerToolInput,
} from 'src/tools/ContainerTool/types.js'

/** `logs` is never an unbounded dump: a container running for days would
 * return megabytes. Overridable, but always present. */
export const DEFAULT_LOGS_SINCE = '10m'
export const DEFAULT_LOGS_TAIL = 200

/** Characters that make a token unsafe to leave unquoted in `commandString`. */
const NEEDS_QUOTING_RE = /[^\w@%+=:,./-]/

/**
 * Ops that address a compose project rather than a single container. They emit
 * `docker compose …`; everything else emits `docker …`.
 *
 * `ps` is the interesting one: it is compose-scoped only when a compose file was
 * named, because the panel's own project scoping comes from labels rather than
 * from the file.
 */
const COMPOSE_ONLY_OPS: ReadonlySet<ContainerOp> = new Set<ContainerOp>([
  'up',
  'down',
  'config',
])

/** Ops that go through compose when a compose file is available, and through
 * plain docker otherwise. */
const COMPOSE_CAPABLE_OPS: ReadonlySet<ContainerOp> = new Set<ContainerOp>([
  'build',
  'ps',
  'logs',
  'start',
  'stop',
  'restart',
  'pause',
  'unpause',
  'pull',
  'push',
  'exec',
  'run',
  'top',
  'events',
])

export type BuildCommandContext = {
  /** Compose file discovered for the project, if any. `input.composeFile` wins. */
  composeFile?: string
}

export class ContainerCommandError extends Error {}

/** Shell-quote one token for `commandString`. */
function quote(token: string): string {
  if (token === '') return "''"
  if (!NEEDS_QUOTING_RE.test(token)) return token
  return `'${token.replaceAll("'", `'\\''`)}'`
}

function requireService(input: ContainerToolInput, op: string): string {
  const service = input.service?.trim()
  if (!service) {
    throw new ContainerCommandError(`\`${op}\` needs a \`service\``)
  }
  return service
}

function resolveComposeFile(
  input: ContainerToolInput,
  ctx: BuildCommandContext,
): string | undefined {
  return input.composeFile ?? ctx.composeFile
}

/** `['compose', '-f', file]` or `[]`. */
function composePrefix(file: string | undefined): string[] {
  return file ? ['compose', '-f', file] : ['compose']
}

type OpBuilder = (
  input: ContainerToolInput,
  composeFile: string | undefined,
  useCompose: boolean,
) => string[]

/**
 * One row per op. Each returns argv AFTER the binary, including any `compose
 * -f <file>` prefix, so an op that is compose-scoped in one call and
 * container-scoped in another decides that here rather than at the call site.
 */
const BUILDERS: Record<ContainerOp, OpBuilder> = {
  // --- read ---------------------------------------------------------------
  ps: (input, file, useCompose) =>
    useCompose
      ? [...composePrefix(file), 'ps', ...(input.all ? ['--all'] : [])]
      : [
          'ps',
          ...(input.all === false ? [] : ['--all']),
          '--no-trunc',
          '--format',
          '{{json .}}',
        ],
  inspect: input => ['inspect', requireService(input, 'inspect')],
  logs: (input, file, useCompose) => {
    const since = input.since ?? DEFAULT_LOGS_SINCE
    const tail = String(input.tail ?? DEFAULT_LOGS_TAIL)
    // `--timestamps` keeps stdout and stderr in order once they are merged.
    const flags = ['--timestamps', '--since', since, '--tail', tail]
    if (input.follow) flags.push('--follow')
    return useCompose
      ? [...composePrefix(file), 'logs', ...flags, ...(input.service ? [input.service] : [])]
      : ['logs', ...flags, requireService(input, 'logs')]
  },
  stats: input => [
    'stats',
    '--no-stream',
    ...(input.service ? [input.service] : []),
  ],
  top: (input, file, useCompose) =>
    useCompose
      ? [...composePrefix(file), 'top', ...(input.service ? [input.service] : [])]
      : ['top', requireService(input, 'top')],
  port: input => ['port', requireService(input, 'port')],
  images: input => ['images', ...(input.all ? ['--all'] : [])],
  df: () => ['system', 'df'],
  config: (_input, file) => [...composePrefix(file), 'config'],
  events: input => [
    'events',
    '--filter',
    'type=container',
    // Bounded on purpose: an unbounded `docker events` never returns.
    '--since',
    input.since ?? DEFAULT_LOGS_SINCE,
    '--until',
    '0s',
    '--format',
    '{{json .}}',
  ],

  // --- lifecycle ----------------------------------------------------------
  up: (input, file) => [
    ...composePrefix(file),
    'up',
    '--detach',
    ...(input.service ? [input.service] : []),
  ],
  down: (input, file) => [
    ...composePrefix(file),
    'down',
    // Only when explicitly asked: this deletes data.
    ...(input.volumes ? ['--volumes'] : []),
  ],
  start: (input, file, useCompose) =>
    useCompose
      ? [...composePrefix(file), 'start', ...(input.service ? [input.service] : [])]
      : ['start', requireService(input, 'start')],
  stop: (input, file, useCompose) =>
    useCompose
      ? [...composePrefix(file), 'stop', ...(input.service ? [input.service] : [])]
      : ['stop', requireService(input, 'stop')],
  restart: (input, file, useCompose) =>
    useCompose
      ? [...composePrefix(file), 'restart', ...(input.service ? [input.service] : [])]
      : ['restart', requireService(input, 'restart')],
  pause: (input, file, useCompose) =>
    useCompose
      ? [...composePrefix(file), 'pause', ...(input.service ? [input.service] : [])]
      : ['pause', requireService(input, 'pause')],
  unpause: (input, file, useCompose) =>
    useCompose
      ? [...composePrefix(file), 'unpause', ...(input.service ? [input.service] : [])]
      : ['unpause', requireService(input, 'unpause')],
  pull: (input, file, useCompose) =>
    useCompose
      ? [...composePrefix(file), 'pull', ...(input.service ? [input.service] : [])]
      : ['pull', requireService(input, 'pull')],
  push: (input, file, useCompose) =>
    useCompose
      ? [...composePrefix(file), 'push', ...(input.service ? [input.service] : [])]
      : ['push', requireService(input, 'push')],

  // --- images and builds --------------------------------------------------
  // `--progress=plain` is what makes the output parseable: the default `auto`
  // renderer rewrites lines in place with ANSI cursor moves.
  build: (input, file, useCompose) =>
    useCompose
      ? [
          ...composePrefix(file),
          'build',
          '--progress=plain',
          ...(input.service ? [input.service] : []),
        ]
      : ['build', '--progress=plain', input.service ?? '.'],
  tag: input => {
    if (!input.source || !input.dest) {
      throw new ContainerCommandError('`tag` needs `source` and `dest`')
    }
    return ['tag', input.source, input.dest]
  },
  history: input => ['history', requireService(input, 'history')],

  // --- interact -----------------------------------------------------------
  exec: (input, file, useCompose) => {
    if (!input.command?.length) {
      throw new ContainerCommandError('`exec` needs a `command`')
    }
    // NEVER `-t`. A TTY allocated in a non-TTY context hangs the call, and
    // nothing here is interactive. `-i` only when stdin is actually supplied.
    const flags = input.stdin === undefined ? [] : ['-i']
    return useCompose
      ? [
          ...composePrefix(file),
          'exec',
          '--no-TTY',
          ...flags,
          requireService(input, 'exec'),
          ...input.command,
        ]
      : ['exec', ...flags, requireService(input, 'exec'), ...input.command]
  },
  run: (input, file, useCompose) => {
    const service = requireService(input, 'run')
    return useCompose
      ? [
          ...composePrefix(file),
          'run',
          '--rm',
          '--no-TTY',
          service,
          ...(input.command ?? []),
        ]
      : ['run', '--rm', service, ...(input.command ?? [])]
  },
  cp: input => {
    if (!input.source || !input.dest) {
      throw new ContainerCommandError('`cp` needs `source` and `dest`')
    }
    return ['cp', input.source, input.dest]
  },

  // --- wait ---------------------------------------------------------------
  // `wait` never shells out: run.ts polls the snapshot. The argv is what the
  // permission check sees, and what the UI shows.
  wait: input => ['ps', '--filter', `name=${requireService(input, 'wait')}`],

  // --- destructive --------------------------------------------------------
  rm: input => ['rm', requireService(input, 'rm')],
  rmi: input => ['rmi', requireService(input, 'rmi')],
  prune: input => {
    const target = input.target ?? 'image'
    const noun = target === 'system' ? 'system' : target
    return [noun, 'prune', '--force']
  },
}

/**
 * Build the command for one op.
 *
 * Throws `ContainerCommandError` for an input the op cannot be built from —
 * the tool turns that into a validation failure before anything runs.
 */
export function buildContainerCommand(
  input: ContainerToolInput,
  ctx: BuildCommandContext = {},
): BuiltCommand {
  const builder = BUILDERS[input.op]
  if (!builder) {
    throw new ContainerCommandError(`unknown op \`${String(input.op)}\``)
  }
  const composeFile = resolveComposeFile(input, ctx)
  const useCompose =
    COMPOSE_ONLY_OPS.has(input.op) ||
    (COMPOSE_CAPABLE_OPS.has(input.op) && composeFile !== undefined)

  const base = builder(input, composeFile, useCompose)
  // Extra argv is appended as separate entries. It is never joined into a
  // shell string, so a value containing a space or a `;` is one argument to
  // docker rather than a second command.
  const argv = [...base, ...(input.args ?? [])]
  const bin = dockerBin()
  return {
    argv,
    commandString: [bin, ...argv].map(quote).join(' '),
    kind: useCompose ? 'compose' : 'docker',
  }
}
