import type * as React from 'react';
import { useEffect, useState } from 'react';
import {
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../cost-tracker.js';
import { Box, Text } from '../ink.js';
import { tryGetActiveProvider } from '../services/api/activeProvider.js';
import { resolveCacheProvider } from '../services/api/cacheMetrics.js';
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

function readSnapshot(): Snapshot {
  return {
    input: getTotalInputTokens(),
    output: getTotalOutputTokens(),
    cacheRead: getTotalCacheReadInputTokens(),
    cacheCreation: getTotalCacheCreationInputTokens(),
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
 * plain OpenAI) show `cached · created · total`; providers that don't
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
    if (snapshot.cacheRead > 0) {
      parts.push(`${ICON_CACHED} ${formatTokens(snapshot.cacheRead)} cached`);
    }
    if (snapshot.cacheCreation > 0) {
      parts.push(`${ICON_CREATED} ${formatTokens(snapshot.cacheCreation)} created`);
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
