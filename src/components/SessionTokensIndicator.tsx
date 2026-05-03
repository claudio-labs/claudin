import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  getModelUsage,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../cost-tracker.js';
import { Box, Text } from '../ink.js';
import { tryGetActiveProvider } from '../services/api/activeProvider.js';
import { resolveCacheProvider } from '../services/api/cacheMetrics.js';
import { useAppState } from '../state/AppState.js';
import { formatTokens } from '../utils/format.js';
import { parseUserSpecifiedModel } from '../utils/model/model.js';
import { getAPIProvider, isGithubNativeAnthropicMode } from '../utils/model/providers.js';
import { parseModelList } from '../utils/providerModels.js';

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
 * Reads token totals scoped to the *active provider's* configured models, so
 * switching providers via /provider doesn't leak counters across the boundary
 * (e.g. Anthropic's cacheRead/cacheCreation bleeding into Ollama's `total`).
 *
 * `STATE.modelUsage` is already keyed by model name and tracks input/output/
 * cacheRead/cacheCreation per model (see addToTotalModelUsage in
 * cost-tracker.ts). We sum only the entries whose model names belong to the
 * active profile's configured list, plus any extra models passed in
 * (typically `appState.mainLoopModel` / `mainLoopModelForSession`) so that
 * `/model` switches to a sibling model that isn't in the profile's static
 * list still get counted. When no provider is active yet (cold first-run
 * path), fall back to the global totals so the indicator still works.
 *
 * Caveat: `modelUsage` is keyed by model name, not by profile id, so two
 * profiles sharing a model name (e.g. "claude-3-5-sonnet" in both an
 * Anthropic-native and a Bedrock profile) will share that bucket. Acceptable
 * trade-off — the alternative (per-profile-id bucketing) would require
 * threading the active profile through every usage-recording call site.
 */
export function readSnapshot(extraModels: readonly (string | null)[] = []): Snapshot {
  const profile = tryGetActiveProvider();
  const supportsCache = activeProviderSupportsCache();

  if (!profile) {
    return {
      input: getTotalInputTokens(),
      output: getTotalOutputTokens(),
      cacheRead: getTotalCacheReadInputTokens(),
      cacheCreation: getTotalCacheCreationInputTokens(),
      supportsCache,
    };
  }

  // Orphan-during-stream caveat: if /provider switches mid-response, in-flight
  // usage chunks keep landing under the *old* mainLoopModel, which is no
  // longer in profile.model nor in the new extraModels — those tokens become
  // invisible here for the rest of the session. They still flow into /cost
  // (they live in modelUsage), so this is a display gap, not a data loss.
  const models = new Set<string>(parseModelList(profile.model));
  // cost-tracker keys usage by the *resolved* model name (e.g. an alias like
  // `opus[1m]` is stored as `claude-opus-4-7[1m]`). `extraModels` carries the
  // raw appState fields (`mainLoopModel`, `mainLoopModelForSession`) — pass
  // each one through `parseUserSpecifiedModel` so it matches the cost-tracker
  // bucket. Mirrors the resolution chain in query.ts (where `options.model`
  // is built before `addToTotalSessionCost` is called).
  for (const m of extraModels) {
    if (!m || m.length === 0) continue;
    models.add(m);
    models.add(parseUserSpecifiedModel(m));
  }
  const usage = getModelUsage();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const model of models) {
    const entry = usage[model];
    if (!entry) continue;
    input += entry.inputTokens;
    output += entry.outputTokens;
    cacheRead += entry.cacheReadInputTokens;
    cacheCreation += entry.cacheCreationInputTokens;
  }

  return { input, output, cacheRead, cacheCreation, supportsCache };
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
  // Pull the runtime-active model(s) from app state so `/model` switches to a
  // sibling model not listed in `profile.model` still get counted. Stored in
  // a ref so the polling effect doesn't have to be torn down on every change.
  const mainLoopModel = useAppState(s => s.mainLoopModel);
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession);
  const extraModelsRef = useRef<readonly (string | null)[]>([]);
  extraModelsRef.current = [mainLoopModel, mainLoopModelForSession];

  const [snapshot, setSnapshot] = useState<Snapshot>(() =>
    readSnapshot(extraModelsRef.current),
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setSnapshot(prev => {
        const next = readSnapshot(extraModelsRef.current);
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
