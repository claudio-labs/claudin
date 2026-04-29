import type * as React from 'react';
import { useEffect, useState } from 'react';
import {
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
} from '../cost-tracker.js';
import { Box, Text } from '../ink.js';
import { formatTokens } from '../utils/format.js';

type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

const POLL_INTERVAL_MS = 2000;

function readTotals(): Totals {
  return {
    input: getTotalInputTokens(),
    output: getTotalOutputTokens(),
    cacheRead: getTotalCacheReadInputTokens(),
    cacheWrite: getTotalCacheCreationInputTokens(),
  };
}

function totalsEqual(a: Totals, b: Totals): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  );
}

/**
 * Compact session-wide token totals shown in the right-side notification
 * row. Numbers are pulled from `cost-tracker` (which already sums every
 * turn's usage and persists totals into the project config on save/exit),
 * so this component is read-only — no extra state, no extra writes.
 *
 * Polled every 2s instead of subscribed because the underlying state lives
 * outside React (bootstrap/state.ts) and exposes no event API. Polling is
 * cheap: each getter is a property read, no I/O.
 *
 * Renders nothing until at least one counter has moved off zero so the
 * footer doesn't grow a "0 0 0" placeholder before the first turn.
 */
export function SessionTokensIndicator(): React.ReactNode {
  const [totals, setTotals] = useState<Totals>(() => readTotals());

  useEffect(() => {
    const interval = setInterval(() => {
      setTotals(prev => {
        const next = readTotals();
        return totalsEqual(prev, next) ? prev : next;
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const hasUsage =
    totals.input > 0 ||
    totals.output > 0 ||
    totals.cacheRead > 0 ||
    totals.cacheWrite > 0;
  if (!hasUsage) return null;

  const cache = totals.cacheRead + totals.cacheWrite;

  return (
    <Box>
      <Text dimColor wrap="truncate">
        {`↑ ${formatTokens(totals.input)}  ↓ ${formatTokens(totals.output)}`}
        {cache > 0 ? `  ⊙ ${formatTokens(cache)}` : ''}
      </Text>
    </Box>
  );
}
