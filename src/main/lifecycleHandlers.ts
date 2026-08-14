// ROADMAP 11g Fase 6: process-wide lifecycle handlers extracted from main.tsx.
//
// Two responsibilities, intentionally bundled because they all install
// process-level listeners that must run exactly once, early in boot:
//
//   1. Node warning handler — pretty-prints Node deprecations/warnings.
//   2. `exit` listener — restores the terminal cursor on every exit path.
//   3. `SIGINT` listener — in print mode defers to print.ts's own handler
//      (which aborts the in-flight query and runs gracefulShutdown);
//      otherwise exits cleanly.
//
// Kept as a single `installLifecycleHandlers()` so main.tsx remains a
// linear boot sequence: install → checkpoint → continue.

import { initializeWarningHandler } from 'src/utils/warningHandler.js';
import { resetCursor } from './helpers.js';

export function installLifecycleHandlers(): void {
  initializeWarningHandler();

  process.on('exit', () => {
    resetCursor();
  });

  process.on('SIGINT', () => {
    // In print mode, print.ts registers its own SIGINT handler that aborts
    // the in-flight query and calls gracefulShutdown; skip here to avoid
    // preempting it with a synchronous process.exit().
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return;
    }
    process.exit(0);
  });
}
