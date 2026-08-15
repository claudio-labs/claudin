// Docker container filters: docker ps, docker images, docker logs.
//
// docker ps output is wide — CONTAINER ID and CREATED are noise (use name/image
// for actions; timestamps vary between runs and kill prompt caching).
// docker images includes a WARNING line and an ID column that are rarely useful.
// docker logs often embeds timestamps + PID in every line — strip to message only.
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
