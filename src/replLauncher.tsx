import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from './ink.js';
import type { Props as REPLProps } from './screens/REPL.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
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
type AppModule = typeof import('./components/App.js');
type REPLModule = typeof import('./screens/REPL.js');

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
  const appImport = preloadedApp ?? import('./components/App.js');
  const replImport = preloadedREPL ?? import('./screens/REPL.js');
  // Clear refs so a second call (unlikely) falls back to fresh imports
  preloadedApp = undefined;
  preloadedREPL = undefined;
  const [{ App }, { REPL }] = await Promise.all([appImport, replImport]);
  await renderAndRun(root, <App {...appProps}>
      <REPL {...replProps} />
    </App>);
}
