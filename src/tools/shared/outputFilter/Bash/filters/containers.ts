// Docker container filters: docker ps, docker images, docker logs, docker
// compose, docker exec.
//
// docker ps output is wide — CONTAINER ID and CREATED are noise (use name/image
// for actions; timestamps vary between runs and kill prompt caching).
// docker images includes a WARNING line and an ID column that are rarely useful.
// docker logs often embeds timestamps + PID in every line — strip to message only.
// docker compose up --build is dominated by BuildKit step bookkeeping — see the
// section below for the measured composition.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from 'src/tools/shared/outputFilter/Bash/types.js'

// --- docker ps -------------------------------------------------------------

const DOCKER_PS_MATCH = /^docker\s+ps\b/
// Passthrough when user already specified output format or wants IDs only.
const DOCKER_PS_REJECT = /--format\b|--quiet\b|-q\b|--no-trunc\b/
// 12-char hex CONTAINER ID column.
// /gm is intentional: used in text.replace() (not .test()), so no lastIndex staleness.
const DOCKER_PS_ID_ROW = /^[0-9a-f]{12}\s+/gm
// Truncate COMMAND column — already comes with … from docker, still wide.
const DOCKER_PS_CMD = /"[^"]{1,40}…"/g
// CREATED column values: "2 hours ago", "3 days ago", etc.
const DOCKER_PS_CREATED =
  /\s+\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/g
// IPv6 duplicate port binding appended after IPv4: ", [::]:5432->5432/tcp"
const DOCKER_PS_IPV6 = /, \[::\]:\d+->\d+\/(?:tcp|udp)/g

// docker ps column header line (CONTAINER ID header or post-strip IMAGE header).
const DOCKER_PS_HDR_LINE = /^(?:CONTAINER ID|IMAGE)\s/

export const dockerPs: FilterSpec = {
  name: 'docker-ps',
  matchCommand: DOCKER_PS_MATCH,
  matchCommandReject: DOCKER_PS_REJECT,
  stripAnsi: true,
  stripLinesMatching: [DOCKER_PS_HDR_LINE],
  replace: [
    { pattern: DOCKER_PS_ID_ROW, replacement: '' },
    { pattern: DOCKER_PS_CMD, replacement: '"…"' },
    { pattern: DOCKER_PS_CREATED, replacement: '' },
    { pattern: DOCKER_PS_IPV6, replacement: '' },
  ],
  truncateLineAt: 200,
  maxLines: 50,
  onEmpty: 'No matching containers.',
}

// --- docker images ---------------------------------------------------------

const DOCKER_IMAGES_MATCH = /^docker\s+images\b/
// Passthrough when user already specified output format or wants quiet (IDs only).
const DOCKER_IMAGES_REJECT = /--format\b|--quiet\b|-q\b/
// 12-char hex IMAGE ID column.
const DOCKER_IMAGES_ID = /\b[0-9a-f]{12}\s+/g

export const dockerImages: FilterSpec = {
  name: 'docker-images',
  matchCommand: DOCKER_IMAGES_MATCH,
  matchCommandReject: DOCKER_IMAGES_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    /^WARNING: This output is designed for human readability/,
  ],
  replace: [{ pattern: DOCKER_IMAGES_ID, replacement: '' }],
  maxLines: 50,
}

// --- docker logs -----------------------------------------------------------
// Strip absolute timestamps + PID prefix down to HH:MM:SS. Works for postgres
// and similar services that use "YYYY-MM-DD HH:MM:SS.mmm UTC [PID] " or
// Docker's native ISO timestamp "YYYY-MM-DDTHH:MM:SS.mmmZ " format.

const DOCKER_LOGS_MATCH = /^docker\s+logs\b/
// Passthrough: -f streams live; --timestamps=false means user disabled them already.
const DOCKER_LOGS_REJECT = /-f\b|--follow\b|--timestamps=false\b/
// postgres-style: "2026-05-05 14:35:40.337 UTC [27] " → "14:35:40 "
// /gm is intentional: used in text.replace() (not .test()), so no lastIndex staleness.
const DOCKER_LOGS_PG_TS =
  /^\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2})\.\d+\s+UTC\s+\[\d+\]\s+/gm
// Docker ISO format: "2026-05-05T14:35:40.337Z " → removed
const DOCKER_LOGS_ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+/gm

export const dockerLogs: FilterSpec = {
  name: 'docker-logs',
  matchCommand: DOCKER_LOGS_MATCH,
  matchCommandReject: DOCKER_LOGS_REJECT,
  stripAnsi: true,
  replace: [
    { pattern: DOCKER_LOGS_PG_TS, replacement: '$1 ' },
    { pattern: DOCKER_LOGS_ISO_TS, replacement: '' },
  ],
  maxLines: 200,
}

// --- docker compose --------------------------------------------------------
// Measured on a real `docker compose -f … up -d --build` capture (152 lines,
// 5,588 chars): 37 lines carry BuildKit's `#N <elapsed> ` prefix — the whole of
// an apt/uv install echoed back with the step number and a timestamp glued to
// every line — and another ~50 are per-step `DONE`/`CACHED` footers and transfer
// progress. The step HEADER (`#7 [runtime 1/4] FROM …`) is signal and stays; its
// bookkeeping does not.
//
// `-f` is NOT in the reject set: before a subcommand it means `--file`, and the
// recorded traffic is `docker compose -f docker-compose.dev.yml up`. Only the
// unambiguous `--follow` opts out.

const DOCKER_COMPOSE_MATCH = /^docker(?:\s+compose|-compose)\b/
const DOCKER_COMPOSE_REJECT = /--format\b|--quiet\b|--json\b|--follow\b/
// `#14 2.785 <text>` — the step number and elapsed seconds repeated on every
// line of a RUN step. Dropping the prefix keeps the text.
// /gm is intentional: used in text.replace() (not .test()), so no lastIndex staleness.
const DOCKER_COMPOSE_STEP_ELAPSED = /^#\d+ \d+\.\d+ /gm
// The bare `#20 ` on a step header is deliberately KEPT. Two reasons: it is what
// groups a failing step's output with its header, and `replace` runs before
// `stripLinesMatching` (stages 3 and 7 in `applyPipeline`) — so removing it here
// would leave every strip pattern below hunting for a prefix that no longer
// exists, and `#1 DONE 0.0s` would survive as a bare `DONE 0.0s`.
// Layer/image digests: 64 hex chars nobody reads. Keep the first 12, as
// `docker ps` does for container ids.
const DOCKER_COMPOSE_DIGEST = /\bsha256:([0-9a-f]{12})[0-9a-f]{52}\b/g
// Per-step footers and transfer bookkeeping.
const DOCKER_COMPOSE_DONE = /^#\d+ (?:DONE \d+\.\d+s|CACHED)$/
const DOCKER_COMPOSE_TRANSFER =
  /^#\d+ (?:transferring |reading from stdin |exporting layers|preparing build cache|writing layer |sending tarball|resolving provenance)/
const DOCKER_COMPOSE_SHA_PROGRESS =
  /^#\d+ (?:sha256:|extracting sha256:|resolve )/
// `docker compose logs` prefixes every line with the SERVICE name before the
// timestamp, so the `docker logs` anchors below never reach it. Same treatment,
// one prefix further in — the service name is what tells the services apart and
// is kept.
const DOCKER_COMPOSE_SVC_ISO_TS =
  /^(\S+\s*\|\s*)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+/gm
const DOCKER_COMPOSE_SVC_PG_TS =
  /^(\S+\s*\|\s*)\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2})\.\d+\s+UTC\s+\[\d+\]\s+/gm
// BuildKit separates every step with a blank line. Once the `DONE`/`CACHED`
// footers are gone those blanks are the only thing left between two headers, so
// they carry no structure — same call `basedpyright` makes.
const DOCKER_COMPOSE_BLANK = /^\s*$/
// Compose's own lifecycle chatter. Only the TERMINAL state of each resource is
// kept (`Built`, `Started`, `Running`, `Pulled`, `Recreated`, `Removed`,
// `Stopped`, `Healthy`) — the states leading up to it say nothing the terminal
// one does not, and there are three or four of them per container.
const DOCKER_COMPOSE_LIFECYCLE =
  /^\s*(?:Container|Image|Volume|Network|Service)\s+\S+\s+(?:Building|Creating|Created|Starting|Recreate|Recreating|Stopping|Removing|Pulling|Waiting|Extracting|Verifying Checksum|Download complete|Downloading)\s*$/

export const dockerCompose: FilterSpec = {
  name: 'docker-compose',
  matchCommand: DOCKER_COMPOSE_MATCH,
  matchCommandReject: DOCKER_COMPOSE_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    DOCKER_COMPOSE_DONE,
    DOCKER_COMPOSE_TRANSFER,
    DOCKER_COMPOSE_SHA_PROGRESS,
    DOCKER_COMPOSE_LIFECYCLE,
    DOCKER_COMPOSE_BLANK,
  ],
  replace: [
    { pattern: DOCKER_COMPOSE_STEP_ELAPSED, replacement: '' },
    { pattern: DOCKER_COMPOSE_DIGEST, replacement: 'sha256:$1…' },
    // `docker compose logs` interleaves service logs, so it gets the same
    // timestamp treatment as `docker logs` — service-prefixed form first,
    // then the bare form for a single-service `--no-log-prefix` read.
    { pattern: DOCKER_COMPOSE_SVC_PG_TS, replacement: '$1$2 ' },
    { pattern: DOCKER_COMPOSE_SVC_ISO_TS, replacement: '$1' },
    { pattern: DOCKER_LOGS_PG_TS, replacement: '$1 ' },
    { pattern: DOCKER_LOGS_ISO_TS, replacement: '' },
  ],
  collapseRuns: true,
  truncateLineAt: 200,
  maxLines: 200,
  onEmpty: 'docker compose: ok',
}

// --- docker exec -----------------------------------------------------------
// Deliberately the thinnest spec in the registry, and the comment is the point:
// the body is whatever the command INSIDE the container printed, so there is no
// line shape to target and no honest reduction floor to assert. Claiming the
// command buys the ANSI strip (`-t` allocates a TTY, so colour is common) and a
// line cap; anything more would be inventing structure that is not there.

const DOCKER_EXEC_MATCH = /^docker\s+exec\b/

export const dockerExec: FilterSpec = {
  name: 'docker-exec',
  matchCommand: DOCKER_EXEC_MATCH,
  stripAnsi: true,
  maxLines: 200,
}
