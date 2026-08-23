// Real captured command output for the Phase 14 filters (docker compose /
// docker exec / bun run).
//
// The two big ones are READ FROM `__fixtures__/samples/`, not inlined. Phase 13
// keeps its samples as template literals, which is fine at twenty lines and
// unreadable at a hundred and fifty; and the same capture is already needed on
// disk by `scripts/bench/tokens/measure-bash-filter-roi.test.ts`, so inlining
// would mean two copies drifting apart. One file, two consumers.
//
// Provenance of each capture is in the `// source:` comment. Both were lifted
// verbatim out of the recorded session corpus — neither is synthetic, and
// neither has been reflowed (the byte length is what the ROI floors measure).
//
// The small ones below ARE hand-written, and each says what shape it stands in
// for. They exist to exercise a branch the big capture does not reach — a failed
// build, an all-noise body, a service-prefixed log — not to measure reduction.
//
// NOT a `.test` file — pure data.

import { readFileSync } from "node:fs";
import path from "node:path";

const SAMPLES_DIR = path.resolve(
  import.meta.dir,
  "../../__fixtures__/samples",
);

function sample(name: string): string {
  return readFileSync(path.join(SAMPLES_DIR, name), "utf8");
}

// ─────────────────────────── docker compose ────────────────────────────────

/**
 * source: recorded session corpus, `docker compose -f docker-compose.dev.yml
 * up -d --build legendarr` — 152 lines, 5,588 chars.
 *
 * Carries every shape the spec targets at once: BuildKit step headers, the
 * `#N <elapsed> ` prefix (74 of the 151 lines), the per-step `DONE`/`CACHED`
 * footers (21), layer digests, and the compose lifecycle block at the end.
 *
 * The char counts here are BYTES. The ROI floors divide JS `.length`, which is
 * UTF-16 units — the two differ wherever a capture contains an emoji, so scrub
 * a fixture against `.length`, not `wc -c`.
 */
export const COMPOSE_UP = sample("docker-compose-up.txt");

/** A build that fails inside a RUN step. `#N ERROR:` is NOT a footer and must
 * survive, along with BuildKit's trailing `------` recap and `failed to solve`. */
export const COMPOSE_FAIL = `#13 [builder 6/9] COPY pyproject.toml ./
#13 DONE 0.1s

#14 [builder 7/9] RUN uv sync --frozen --all-packages
#14 0.512 error: Failed to parse \`pyproject.toml\`
#14 0.512   Caused by: TOML parse error at line 12, column 1
#14 ERROR: process "/bin/sh -c uv sync --frozen --all-packages" did not complete successfully: exit code: 2
------
 > [builder 7/9] RUN uv sync --frozen --all-packages:
0.512 error: Failed to parse \`pyproject.toml\`
------
failed to solve: process "/bin/sh -c uv sync --frozen --all-packages" did not complete successfully: exit code: 2
`;

/** Nothing but intermediate lifecycle states, with a blank run in the middle.
 * Every line is strippable, so the body must reach `onEmpty` — and the blank run
 * must not survive `collapseRuns` as a bare ` (×2)` marker.
 *
 * No `Created` line here: it is terminal for `create`/`up --no-start` and is
 * deliberately kept, so including it would stop this reaching `onEmpty`. */
export const COMPOSE_ALL_NOISE = ` Container app-db-1 Creating


 Container app-db-1 Pulling
 Container app-db-1 Starting
`;

/** `docker compose logs`: the service name is prefixed BEFORE the timestamp, so
 * the plain `docker logs` anchor does not reach it. */
export const COMPOSE_LOGS = `legendarr-1  | 2026-08-01T10:00:00.123456789Z INFO  starting web worker
db-1         | 2026-08-01 10:00:01.004 UTC [27] LOG:  database system is ready
legendarr-1  | 2026-08-01T10:00:02.887654321Z INFO  listening on :8080
`;

// ─────────────────────────────── bun run ───────────────────────────────────

/**
 * source: recorded session corpus, `bun run smoke` — 9 lines, 579 chars.
 *
 * Two `$ ` echo lines because the script nests (`smoke` shells out to `build`),
 * which is the shape the strip exists for.
 */
export const BUN_RUN_SMOKE = sample("bun-run-smoke.txt");

/** The KNOWN GAP: a script whose OWN output contains a `$ ` line. The second one
 * here is printed BY the script, not echoed by bun, and is stripped all the
 * same — the stages are stateless per line, so "only at the top" cannot be
 * expressed. Pinned so the behaviour is a decision, not a surprise. */
export const BUN_RUN_ECHOING_SCRIPT = `$ node scripts/deploy.js
preparing release 1.2.3
$ rsync -a dist/ server:/srv/app
uploaded 412 files
`;
