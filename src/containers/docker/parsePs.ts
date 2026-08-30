// Pure parser for `docker ps --all --no-trunc --format '{{json .}}'`.
//
// One JSON object per line. Everything the panel and the tool need is in that
// one call — health and exit code are recovered from the `Status` string, so
// there is no per-container `docker inspect` on the hot path.

import { logError } from 'src/shared/log.js'
import type {
  ContainerHealth,
  ContainerInfo,
  ContainerPort,
  ContainerState,
} from 'src/containers/types.js'

/** `Exited (137) 3 minutes ago`, `Restarting (1) 2 seconds ago`. */
const EXIT_CODE_RE = /\((\d+)\)/
const HEALTHY_RE = /\(healthy\)/i
const UNHEALTHY_RE = /\(unhealthy\)/i
const HEALTH_STARTING_RE = /\(health:\s*starting\)/i
/** `0.0.0.0:8000->8000/tcp`, `[::]:8000->8000/tcp`, `8000/tcp`. */
const PUBLISHED_PORT_RE = /^(?:(.*):(\d+)->)?(\d+)\/(\w+)$/
/** Docker prints `2026-08-29 20:31:14 -0300 -03`; the trailing abbreviation
 * defeats Date.parse, so it is dropped before parsing. */
const TRAILING_TZ_ABBREV_RE = /\s+[A-Z0-9+-]{1,6}$/

const KNOWN_STATES: ReadonlySet<string> = new Set<ContainerState>([
  'created',
  'restarting',
  'running',
  'removing',
  'paused',
  'exited',
  'dead',
])

/** Shape docker emits. Every field is optional because the format has gained
 * and lost columns across versions, and a missing one must not throw. */
type RawPsLine = {
  ID?: string
  Names?: string
  Image?: string
  State?: string
  Status?: string
  Ports?: string
  Labels?: string
  CreatedAt?: string
}

export function parseHealth(status: string): ContainerHealth {
  if (HEALTHY_RE.test(status)) return 'healthy'
  if (UNHEALTHY_RE.test(status)) return 'unhealthy'
  if (HEALTH_STARTING_RE.test(status)) return 'starting'
  return 'none'
}

/**
 * Exit code from a status line. Only `Exited`/`Restarting` carry one — the
 * parenthesised number in `Up 2 hours (healthy)` is not a code, so the health
 * markers are excluded before looking.
 */
export function parseExitCode(status: string): number | null {
  if (parseHealth(status) !== 'none') return null
  const m = EXIT_CODE_RE.exec(status)
  if (!m?.[1]) return null
  const code = Number.parseInt(m[1], 10)
  return Number.isFinite(code) ? code : null
}

export function parsePorts(ports: string | undefined): ContainerPort[] {
  if (!ports?.trim()) return []
  const out: ContainerPort[] = []
  const seen = new Set<string>()
  for (const chunk of ports.split(',')) {
    const m = PUBLISHED_PORT_RE.exec(chunk.trim())
    if (!m) continue
    const hostPortRaw = m[2]
    const containerPort = Number.parseInt(m[3] ?? '', 10)
    if (!Number.isFinite(containerPort)) continue
    const hostPort = hostPortRaw ? Number.parseInt(hostPortRaw, 10) : null
    const protocol = m[4] ?? 'tcp'
    // Docker lists IPv4 and IPv6 bindings of the same port separately; the
    // panel wants one row per port, not one per address family.
    const key = `${hostPort ?? ''}:${containerPort}/${protocol}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      hostPort: hostPort !== null && Number.isFinite(hostPort) ? hostPort : null,
      containerPort,
      protocol,
    })
  }
  return out
}

/**
 * Docker joins labels with commas and has no escaping for a comma inside a
 * value, so this is best-effort by construction. It is good enough for the
 * compose labels we read, whose values are project names and paths.
 */
export function parseLabels(labels: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!labels?.trim()) return out
  for (const pair of labels.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1))
  }
  return out
}

function parseCreatedAt(raw: string | undefined): number | null {
  if (!raw?.trim()) return null
  const ms = Date.parse(raw.replace(TRAILING_TZ_ABBREV_RE, ''))
  return Number.isFinite(ms) ? ms : null
}

function parseState(raw: string | undefined, status: string): ContainerState {
  const lowered = raw?.trim().toLowerCase()
  if (lowered && KNOWN_STATES.has(lowered)) return lowered as ContainerState
  // Older docker builds omit `State`; the `Status` prefix still carries it.
  const head = status.trim().toLowerCase()
  if (head.startsWith('up')) return 'running'
  if (head.startsWith('exited')) return 'exited'
  if (head.startsWith('restarting')) return 'restarting'
  if (head.startsWith('created')) return 'created'
  if (head.startsWith('paused')) return 'paused'
  if (head.startsWith('dead')) return 'dead'
  return 'exited'
}

/**
 * Parse the whole `docker ps` payload. A malformed line is skipped rather than
 * failing the batch — one bad row must not blank the panel.
 */
export function parsePsOutput(stdout: string): ContainerInfo[] {
  const out: ContainerInfo[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('{')) continue
    let raw: RawPsLine
    try {
      raw = JSON.parse(trimmed) as RawPsLine
    } catch (e) {
      logError(new Error('docker ps: skipping unparseable line', { cause: e }))
      continue
    }
    const id = raw.ID?.trim()
    if (!id) continue
    const status = raw.Status?.trim() ?? ''
    const labels = parseLabels(raw.Labels)
    // `Names` is comma-joined when a container has aliases; the first is the
    // one docker itself prints and the one compose derives.
    const name = raw.Names?.split(',')[0]?.trim() ?? id.slice(0, 12)
    out.push({
      id,
      name,
      image: raw.Image?.trim() ?? '',
      state: parseState(raw.State, status),
      status,
      health: parseHealth(status),
      exitCode: parseExitCode(status),
      ports: parsePorts(raw.Ports),
      project: labels.get('com.docker.compose.project') ?? null,
      service: labels.get('com.docker.compose.service') ?? null,
      workingDir:
        labels.get('com.docker.compose.project.working_dir') ?? null,
      createdAt: parseCreatedAt(raw.CreatedAt),
    })
  }
  return out
}
