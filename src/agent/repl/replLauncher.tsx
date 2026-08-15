import React from 'react';
import type { StatsStore } from 'src/terminal/contexts/stats.js';
import type { Root } from 'src/terminal/ink.js';
import type { Props as REPLProps } from 'src/agent/repl/REPL.js';
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js';
type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};

/**
 * Pre-resolved chunk promises — set by main.tsx during startup to overlap
 * dynamic import resolution with other async work. When set, launchRepl
 * reuses them instead of issuing fresh import() calls, saving ~30-50ms.
 */
type AppModule = typeof import('src/agent/ui/App.js');
type REPLModule = typeof import('src/agent/repl/REPL.js');

let preloadedApp: Promise<AppModule> | undefined;
let preloadedREPL: Promise<REPLModule> | undefined;

export function setPreloadedChunks(
  app: Promise<AppModule>,
  repl: Promise<REPLModule>,
): void {
  preloadedApp = app;
  preloadedREPL = repl;
}

export async function launchRepl(root: Root, appProps: AppWrapperProps, replProps: REPLProps, renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>): Promise<void> {
  const appImport = preloadedApp ?? import('src/agent/ui/App.js');
  const replImport = preloadedREPL ?? import('src/agent/repl/REPL.js');
  // Clear refs so a second call (unlikely) falls back to fresh imports
  preloadedApp = undefined;
  preloadedREPL = undefined;
  const [{ App }, { REPL }] = await Promise.all([appImport, replImport]);
  await renderAndRun(root, <App {...appProps}>
      <REPL {...replProps} />
    </App>);
}
