import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  formatCost,
  getTotalCost,
  getTotalInputTokens,
  getTotalOutputTokens,
} from 'src/agent/cost-tracker.js';
import { Box, Text } from 'src/terminal/ink.js';
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js';
import { resolveCacheProvider } from 'src/providers/cache/cacheMetrics.js';
import { getSessionCacheMetrics } from 'src/providers/cache/cacheStatsTracker.js';
import { formatTokens } from 'src/shared/text/format.js';
import { getAPIProvider, isGithubNativeAnthropicMode } from 'src/providers/model/providers.js';
import { hasNerdFontGlyphs } from 'src/terminal/terminalFont.js';
import { getCurrentUsage } from 'src/agent/context/tokens.js';
import { getContextWindowForModel } from 'src/agent/context/context.js';
import { useMainLoopModel } from 'src/agent/hooks/useMainLoopModel.js';
import { getSdkBetas } from 'src/platform/bootstrap/state.js';
import type { Message } from 'src/shared/types/message.js';

type Snapshot = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  supportsCache: boolean;
  cost: number;
};

const POLL_INTERVAL_MS = 2000;
const ICON_WRITE = '\u{F163E}'; // Nerd Font — cache write
const ICON_READ = '\u{F163B}';  // Nerd Font — cache read
const GAUGE_EMPTY = '\u{F0766}';  // nf-md-circle_outline
const GAUGE_SLICE_BASE = 0xf0a9d; // + 1..8 → nf-md-circle_slice_1..8
// One divider for every group boundary and before the cost.
const SEP = ' · ';

/**
 * Thousands drop the decimal (86.3k → 86k) to keep the row short; millions
 * keep it, since 1.4m → 1m would hide a swing of 400k tokens.
 */
export function formatPillTokens(count: number): string {
  if (count < 1000) return formatTokens(count);
  const thousands = Math.round(count / 1000);
  if (thousands < 1000) return `${thousands}k`;
  // 999.5k–999.9k would round to "1000k"; formatTokens alone prints "999.6k".
  return formatTokens(Math.max(count, 1_000_000));
}

/** The row's groups, cost excluded: the context size unlabelled, then the
 *  cache groups, marked by icon when Nerd Font glyphs render and by `wrt:` /
 *  `rd:` otherwise. */
export function formatTokenParts(snapshot: Snapshot, contextTokens: number, nerdFont: boolean): string[] {
  const parts: string[] = [];
  if (contextTokens > 0) {
    parts.push(formatPillTokens(contextTokens));
  }
  if (snapshot.supportsCache) {
    if (snapshot.cacheCreation > 0) {
      parts.push(`${nerdFont ? ICON_WRITE : 'wrt:'} ${formatPillTokens(snapshot.cacheCreation)}`);
    }
    if (snapshot.cacheRead > 0) {
      parts.push(`${nerdFont ? ICON_READ : 'rd:'} ${formatPillTokens(snapshot.cacheRead)}`);
    }
  } else {
    parts.push(`in: ${formatPillTokens(snapshot.input)}`);
    parts.push(`out: ${formatPillTokens(snapshot.output)}`);
  }
  return parts;
}

/** The context gauge (Nerd Font): a circle filled in eighths of the window.
 *  It keeps the row's own color until 60%, then takes the theme's warning,
 *  and its error red from 80%. */
export function contextGauge(ratio: number): { glyph: string; color: 'warning' | 'error' | null } {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const step = Math.round(clamped * 8);
  const glyph = step === 0 ? GAUGE_EMPTY : String.fromCodePoint(GAUGE_SLICE_BASE + step);
  const color = clamped < 0.6 ? null : clamped < 0.8 ? 'warning' : 'error';
  return { glyph, color };
}

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
  const model = useMainLoopModel();
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

  const nerdFont = hasNerdFontGlyphs();
  const parts = formatTokenParts(displaySnapshot, contextTokens, nerdFont);
  const gauge =
    nerdFont && contextTokens > 0
      ? contextGauge(contextTokens / getContextWindowForModel(model, getSdkBetas()))
      : null;
  const costValue = displaySnapshot.cost > 0 ? formatCost(displaySnapshot.cost) : null;

  return (
    <Box>
      {gauge ? <Text color={gauge.color ?? undefined} dimColor={!gauge.color}>{gauge.glyph} </Text> : null}
      <Text dimColor wrap="truncate">
        {parts.join(SEP)}
        {costValue ? SEP : ''}
      </Text>
      {costValue ? <Text color="claude">{costValue}</Text> : null}
    </Box>
  );
}
