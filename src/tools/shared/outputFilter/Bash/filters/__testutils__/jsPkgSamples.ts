// Real captured command output for the JS package-runner filters.
//
// Named for the filter family it serves, matching `filters/js-pkg.ts`. Only the
// `bun run` samples live here so far — the next/biome/oxlint/turbo/nx samples
// for the same family are still inside `phase13Samples.ts` and belong here when
// that file is split by family too.
//
// NOT a `.test` file — pure data.

import { readSample } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

/**
 * source: recorded session corpus, `bun run smoke` — 9 lines, 579 chars.
 *
 * Two `$ ` echo lines because the script nests (`smoke` shells out to `build`),
 * which is the shape the strip exists for.
 */
export const BUN_RUN_SMOKE = readSample("bun-run-smoke.txt");

/** The KNOWN GAP: a script whose OWN output contains a `$ ` line. The second one
 * here is printed BY the script, not echoed by bun, and is stripped all the
 * same — the stages are stateless per line, so "only at the top" cannot be
 * expressed. Pinned so the behaviour is a decision, not a surprise. */
export const BUN_RUN_ECHOING_SCRIPT = `$ node scripts/deploy.js
preparing release 1.2.3
$ rsync -a dist/ server:/srv/app
uploaded 412 files
`;
