import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  formatCost,
  getTotalCost,
  getTotalInputTokens,
  getTotalOutputTokens,
} from 'src/cost-tracker.js';
import { Box, Text } from 'src/ink.js';
import { tryGetActiveProvider } from 'src/services/api/activeProvider.js';
import { resolveCacheProvider } from 'src/services/api/cacheMetrics.js';
import { getSessionCacheMetrics } from 'src/services/api/cacheStatsTracker.js';
import { formatTokens } from 'src/utils/format.js';
import { getAPIProvider, isGithubNativeAnthropicMode } from 'src/utils/model/providers.js';
import { hasNerdFontGlyphs } from 'src/utils/terminalFont.js';
import { getCurrentUsage } from 'src/utils/tokens.js';
import type { Message } from 'src/types/message.js';

type Snapshot = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  supportsCache: boolean;
  cost: number;
};

const POLL_INTERVAL_MS = 2000;
const ICON_CREATED = '\u{F0193}'; // nf-md-content_save — cache write
const ICON_CACHED = '\u{F1C0}';   // nf-fa-database — cache read
const ICON_TOTAL = '\u{F0AA8}';   // nf-md-sigma — sum
const SEP_NF = '\uE0B1';          // nf powerline right chevron — used for every divider (Nerd Font)
const SEP_FALLBACK = '·';         // dot fallback when Nerd Font glyphs are unavailable

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
    cost: getTotalCost(),
  };
}

function snapshotEqual(a: Snapshot, b: Snapshot): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheCreation === b.cacheCreation &&
    a.supportsCache === b.supportsCache &&
    a.cost === b.cost
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
export function SessionTokensIndicator({ messages }: { messages?: Message[] } = {}): React.ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => readSnapshot());
  // Keep the last non-zero snapshot so the indicator doesn't unmount during
  // the 2-second poll interval (which causes a visible flicker when the
  // component re-mounts mid-stream or at turn boundaries).
  const lastNonZeroRef = useRef<Snapshot | null>(null);

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
  if (grandTotal > 0) {
    lastNonZeroRef.current = snapshot;
  } else if (lastNonZeroRef.current) {
    // Snapshot collapsed back to all-zero (session reset / new conversation).
    // Without this, the stale non-zero ref would freeze the indicator on the
    // previous session's totals forever, which is worse than the brief
    // flicker the ref was added to avoid.
    lastNonZeroRef.current = null;
  }
  const displaySnapshot = lastNonZeroRef.current;
  if (!displaySnapshot) return null;

  const usage = messages ? getCurrentUsage(messages) : null;
  const contextTokens = usage
    ? usage.input_tokens +
      usage.output_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens
    : 0;

  const parts: string[] = [];
  if (contextTokens > 0) {
    parts.push(`ctx: ${formatTokens(contextTokens)}`);
  }
  if (displaySnapshot.supportsCache) {
    if (displaySnapshot.cacheCreation > 0) {
      parts.push(`wrt: ${formatTokens(displaySnapshot.cacheCreation)}`);
    }
    if (displaySnapshot.cacheRead > 0) {
      parts.push(`rd: ${formatTokens(displaySnapshot.cacheRead)}`);
    }
  } else {
    parts.push(`in: ${formatTokens(displaySnapshot.input)}`);
    parts.push(`out: ${formatTokens(displaySnapshot.output)}`);
  }

  const costValue = displaySnapshot.cost > 0 ? formatCost(displaySnapshot.cost) : null;
  // Same divider for every group boundary and before the cost; dot as the fallback.
  const sep = hasNerdFontGlyphs() ? ` ${SEP_NF} ` : ` ${SEP_FALLBACK} `;

  return (
    <Box>
      <Text dimColor wrap="truncate">
        {parts.join(sep)}
        {costValue ? sep : ''}
      </Text>
      {costValue ? <Text color="claude">{costValue}</Text> : null}
    </Box>
  );
}
