// Feature-gated module handles shared across the headless streaming units,
// extracted from `src/platform/headless/print/runHeadless.ts` as part of ROADMAP 11b.
//
// These are `require()`d behind a `feature()` ternary rather than imported so
// `scripts/build.ts` can fold the condition to a literal and drop the whole
// subtree from builds where the flag is off. The ternary must stay DIRECTLY on
// the `feature()` call — see `.claudin/rules/typescript-patterns.md`.
//
// This module exists because `proactiveModule` has four consumers after the
// split (runHeadless, runHeadlessStreaming, turnLoop, controlLoop). Handles
// with a single consumer deliberately stay in that consumer's file.
//
// Relative specifiers are preserved verbatim from the original file, which sat
// at this same directory depth (`src/platform/headless/print/`).

import { feature } from 'bun:bundle'

/* eslint-disable @typescript-eslint/no-require-imports */
export const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../../proactive/index.js') as typeof import('../../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */
