import type * as React from 'react';
import { useEffect, useState } from 'react';
import {
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../cost-tracker.js';
import { Box, Text } from '../ink.js';
import { tryGetActiveProvider } from '../services/api/activeProvider.js';
import { resolveCacheProvider } from '../services/api/cacheMetrics.js';
import { getSessionCacheMetrics } from '../services/api/cacheStatsTracker.js';
import { formatTokens } from '../utils/format.js';
import { getAPIProvider, isGithubNativeAnthropicMode } from '../utils/model/providers.js';

type Snapshot = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  supportsCache: boolean;
};

const POLL_INTERVAL_MS = 2000;
const ICON_CREATED = '\u{F0193}'; // nf-md-content_save — cache write
const ICON_CACHED = '\u{F1C0}';   // nf-fa-database — cache read
const ICON_TOTAL = '\u{F0AA8}';   // nf-md-sigma — sum

/**
 * Whether the active provider is one we expect to report cache fields. Drives
 * which layout the indicator picks, independently of the historical counters
 * — so a provider switch (e.g. Anthropic → Ollama via /provider) flips the
 * display to the no-cache layout immediately, instead of latching on the
 * leftover non-zero `cacheCreation` from the previous provider.
 *
 * `copilot` and `ollama` are hard-wired unsupported in `extractCacheMetrics`;
 * `self-hosted` is heuristic (private URL) and treated as unsupported here.
 */
function activeProviderSupportsCache(): boolean {
  const profile = tryGetActiveProvider();
  if (!profile) return false;
  const cacheProvider = resolveCacheProvider(getAPIProvider(), {
    githubNativeAnthropic: isGithubNativeAnthropicMode(),
    openAiBaseUrl: profile.baseUrl,
  });
  return cacheProvider !== 'copilot' && cacheProvider !== 'ollama' && cacheProvider !== 'self-hosted';
}

/**
 * Reads session-wide token totals straight from the trackers, no per-model
 * bucketing:
 *
 * - `input` / `output` come from cost-tracker globals.
 * - `cacheRead` / `cacheCreation` come from `cacheStatsTracker.session`, the
 *   same aggregate that powers `/cache-stats`. The shims feed it normalized
 *   metrics (Anthropic-shaped) for every provider, so we don't need to know
 *   which model was used.
 *
 * Earlier versions tried to scope the snapshot to the active profile's
 * configured models to prevent cross-provider leakage on `/provider` switch.
 * That broke whenever the resolved model name (`claude-opus-4-7[1m]`)
 * diverged from `profile.model` (raw alias / empty string), making the pill
 * disappear entirely. The cross-provider concern is still handled — but at
 * the *layout* level via `supportsCache`: when the active provider doesn't
 * report cache, the indicator hides the cache groups regardless of any
 * lingering non-zero counters from a prior provider.
 *
 * Trade-off: input/output globals can include tokens from prior providers
 * in the same session if the user switches without `/clear`. Acceptable —
 * a session-spanning rollup, not a per-provider tally.
 */
export function readSnapshot(): Snapshot {
  const cache = getSessionCacheMetrics();
  return {
    input: getTotalInputTokens(),
    output: getTotalOutputTokens(),
    cacheRead: cache.read,
    cacheCreation: cache.created,
    supportsCache: activeProviderSupportsCache(),
  };
}

function snapshotEqual(a: Snapshot, b: Snapshot): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheCreation === b.cacheCreation &&
    a.supportsCache === b.supportsCache
  );
}

/**
 * Compact session-wide token totals shown in the right-side notification
 * row. The layout is decided by the *current* active provider, not by the
 * historical counters — providers that report cache fields (Anthropic,
 * Bedrock, Vertex, Foundry, Gemini, Codex, Kimi, DeepSeek, Copilot-Claude,
 * plain OpenAI) show `created · cached · total`; providers that don't
 * (Ollama, vanilla Copilot, self-hosted OpenAI-compatible) show the legacy
 * `↑ input  ↓ output · total` so input/output stay visible.
 *
 * Cache groups (`cached`, `created`) are individually omitted while their
 * counter is zero so the row doesn't grow placeholders during a cold start.
 *
 * Polled every 2s; underlying state lives in cost-tracker (no event API).
 */
export function SessionTokensIndicator(): React.ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => readSnapshot());

  useEffect(() => {
    const interval = setInterval(() => {
      setSnapshot(prev => {
        const next = readSnapshot();
        return snapshotEqual(prev, next) ? prev : next;
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const grandTotal =
    snapshot.input + snapshot.output + snapshot.cacheRead + snapshot.cacheCreation;
  if (grandTotal === 0) return null;

  const parts: string[] = [];
  if (snapshot.supportsCache) {
    if (snapshot.cacheCreation > 0) {
      parts.push(`${ICON_CREATED} ${formatTokens(snapshot.cacheCreation)} created`);
    }
    if (snapshot.cacheRead > 0) {
      parts.push(`${ICON_CACHED} ${formatTokens(snapshot.cacheRead)} cached`);
    }
  } else {
    parts.push(`↑ ${formatTokens(snapshot.input)}  ↓ ${formatTokens(snapshot.output)}`);
  }
  parts.push(`${ICON_TOTAL} ${formatTokens(grandTotal)} tokens`);

  return (
    <Box>
      <Text dimColor wrap="truncate">
        {parts.join(' · ')}
      </Text>
    </Box>
  );
}
