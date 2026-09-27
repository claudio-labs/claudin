/**
 * Tests for the session-token indicator's snapshot reader.
 *
 * The reader is intentionally dumb: it forwards session-wide totals from
 * `cost-tracker` (input/output) and `cacheStatsTracker.session` (cache
 * read/created). The interesting policy is in `supportsCache`, which
 * decides whether the layout shows the cache groups or the legacy
 * input/output pair.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';

let totalInput = 0;
let totalOutput = 0;
let cacheRead = 0;
let cacheCreated = 0;

function setTotals(next: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreated?: number;
}) {
  totalInput = next.input ?? 0;
  totalOutput = next.output ?? 0;
  cacheRead = next.cacheRead ?? 0;
  cacheCreated = next.cacheCreated ?? 0;
}

const realCostTracker = { ...(await import('src/agent/cost-tracker.js')) };
const realCacheStatsTracker = { ...(await import('src/providers/cache/cacheStatsTracker.js')) };
const realActiveProvider = { ...(await import('src/providers/presets/activeProvider.js')) };
const realCacheMetrics = { ...(await import('src/providers/cache/cacheMetrics.js')) };
const realProviders = { ...(await import('src/providers/model/providers.js')) };
const realInk = { ...(await import('src/terminal/ink.js')) };

mock.module('src/agent/cost-tracker.js', () => ({
  getTotalInputTokens: () => totalInput,
  getTotalOutputTokens: () => totalOutput,
}));

mock.module('src/providers/cache/cacheStatsTracker.js', () => ({
  getSessionCacheMetrics: () => ({
    read: cacheRead,
    created: cacheCreated,
    total: 0,
    hitRate: null,
    fresh: 0,
    supported: true,
  }),
}));

let profile: { id: string; model: string; baseUrl: string } | undefined;
function setProfile(next: typeof profile) {
  profile = next;
}
mock.module('src/providers/presets/activeProvider.js', () => ({
  tryGetActiveProvider: () => profile,
}));

let cacheProviderResolution = 'anthropic';
function setCacheProvider(name: string) {
  cacheProviderResolution = name;
}
mock.module('src/providers/cache/cacheMetrics.js', () => ({
  resolveCacheProvider: () => cacheProviderResolution,
}));

// This file used to pin providers.js to getAPIProvider: () => 'anthropic' here,
// at module scope. It never needed it — resolveCacheProvider above is the only
// seam these tests read — and it is the earliest registration for that
// specifier in the whole run, which under Bun means it OWNED it: five other
// files (withRetry, apiPreconnect, officialRegistry, domainCheck,
// conversationRecovery) got 'anthropic', a value that is not even in the
// APIProvider union, no matter what they mocked afterwards.

mock.module('src/terminal/ink.js', () => ({
  Box: () => null,
  Text: () => null,
}));

const { contextGauge, formatPillTokens, formatTokenParts, readSnapshot } = await import('src/providers/ui/SessionTokensIndicator.js');

afterEach(() => {
  setTotals({});
  setProfile(undefined);
  setCacheProvider('anthropic');
});

describe('readSnapshot — totals forwarding', () => {
  test('forwards cost-tracker globals for input/output', () => {
    setTotals({ input: 123, output: 45 });
    setProfile({ id: 'a', model: 'claude-opus-4-7', baseUrl: 'https://api.anthropic.com' });

    const snap = readSnapshot();

    expect(snap.input).toBe(123);
    expect(snap.output).toBe(45);
  });

  test('forwards cacheStatsTracker session metrics for cache fields', () => {
    setTotals({ cacheRead: 116000, cacheCreated: 63800 });
    setProfile({ id: 'a', model: 'claude-opus-4-7', baseUrl: 'https://api.anthropic.com' });

    const snap = readSnapshot();

    expect(snap.cacheRead).toBe(116000);
    expect(snap.cacheCreation).toBe(63800);
  });

  test('regression: indicator is not blank when profile.model is empty', () => {
    // /cache-stats reported tokens just fine, but the older bucketed reader
    // returned all-zeros when profile.model was an empty string (no models
    // to match against), making the pill disappear.
    setTotals({ input: 10, output: 5, cacheRead: 100, cacheCreated: 50 });
    setProfile({ id: 'a', model: '', baseUrl: 'https://api.anthropic.com' });

    const snap = readSnapshot();

    expect(snap.input).toBe(10);
    expect(snap.output).toBe(5);
    expect(snap.cacheRead).toBe(100);
    expect(snap.cacheCreation).toBe(50);
  });
});

describe('readSnapshot — supportsCache layout flag', () => {
  // The bug being regression-tested is "layout flips on /provider switch
  // but cache numbers from the prior provider stay shown" — the indicator
  // hides cache groups based on supportsCache, regardless of counters.

  test('Anthropic-shaped resolution → supportsCache=true', () => {
    setCacheProvider('anthropic');
    setProfile({ id: 'a', model: 'claude-opus-4-7', baseUrl: 'https://api.anthropic.com' });
    expect(readSnapshot().supportsCache).toBe(true);
  });

  test('Ollama resolution → supportsCache=false', () => {
    setCacheProvider('ollama');
    setProfile({ id: 'o', model: 'llama3.1:8b', baseUrl: 'http://localhost:11434' });
    expect(readSnapshot().supportsCache).toBe(false);
  });

  test('Copilot resolution → supportsCache=false', () => {
    setCacheProvider('copilot');
    setProfile({ id: 'c', model: 'gpt-4o', baseUrl: 'https://api.githubcopilot.com' });
    expect(readSnapshot().supportsCache).toBe(false);
  });

  test('self-hosted resolution → supportsCache=false', () => {
    setCacheProvider('self-hosted');
    setProfile({ id: 's', model: 'mistral-large', baseUrl: 'https://internal.example' });
    expect(readSnapshot().supportsCache).toBe(false);
  });

  test('no active profile → supportsCache=false (cold first-run)', () => {
    setProfile(undefined);
    expect(readSnapshot().supportsCache).toBe(false);
  });
});

describe('formatPillTokens', () => {
  test('thousands drop the decimal', () => {
    expect(formatPillTokens(86_300)).toBe('86k');
    expect(formatPillTokens(74_400)).toBe('74k');
    expect(formatPillTokens(1_000)).toBe('1k');
  });

  test('millions keep one decimal', () => {
    expect(formatPillTokens(1_400_000)).toBe('1.4m');
    expect(formatPillTokens(999_600)).toBe('1m');
  });

  test('below a thousand stays exact', () => {
    expect(formatPillTokens(950)).toBe('950');
  });
});

describe('formatTokenParts', () => {
  const cached = { input: 0, output: 0, cacheRead: 1_400_000, cacheCreation: 74_400, supportsCache: true, cost: 1 };

  test('context is unlabelled; cache groups take icons under a Nerd Font', () => {
    expect(formatTokenParts(cached, 86_300, true)).toEqual(['86k', '\u{F163E} 74k', '\u{F163B} 1.4m']);
  });

  test('cache groups fall back to text labels without a Nerd Font', () => {
    expect(formatTokenParts(cached, 86_300, false)).toEqual(['86k', 'wrt: 74k', 'rd: 1.4m']);
  });

  test('providers without cache keep in/out', () => {
    const plain = { ...cached, input: 12_000, output: 3_400, supportsCache: false };
    expect(formatTokenParts(plain, 0, true)).toEqual(['in: 12k', 'out: 3k']);
  });
});

describe('contextGauge', () => {
  test('fills the circle in eighths', () => {
    expect(contextGauge(0).glyph).toBe('\u{F0766}');
    expect(contextGauge(0.05).glyph).toBe('\u{F0766}');
    expect(contextGauge(0.125).glyph).toBe('\u{F0A9E}');
    expect(contextGauge(0.47).glyph).toBe('\u{F0AA1}');
    expect(contextGauge(0.66).glyph).toBe('\u{F0AA2}');
    expect(contextGauge(0.75).glyph).toBe('\u{F0AA3}');
    expect(contextGauge(1).glyph).toBe('\u{F0AA5}');
  });

  test('keeps the row color below 60%, then warning, then error from 80%', () => {
    expect(contextGauge(0.59).color).toBeNull();
    expect(contextGauge(0.6).color).toBe('warning');
    expect(contextGauge(0.79).color).toBe('warning');
    expect(contextGauge(0.8).color).toBe('error');
  });

  test('clamps past the window and survives a non-finite ratio', () => {
    expect(contextGauge(1.3)).toEqual({ glyph: '\u{F0AA5}', color: 'error' });
    expect(contextGauge(Number.NaN)).toEqual({ glyph: '\u{F0766}', color: null });
  });
});

afterAll(() => {
  mock.module('src/agent/cost-tracker.js', () => realCostTracker);
  mock.module('src/agent/cost-tracker.js', () => realCostTracker);
  mock.module('src/providers/cache/cacheStatsTracker.js', () => realCacheStatsTracker);
  mock.module('src/providers/cache/cacheStatsTracker.js', () => realCacheStatsTracker);
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProvider);
  mock.module('src/providers/presets/activeProvider.js', () => realActiveProvider);
  mock.module('src/providers/cache/cacheMetrics.js', () => realCacheMetrics);
  mock.module('src/providers/cache/cacheMetrics.js', () => realCacheMetrics);
  mock.module('src/providers/model/providers.js', () => realProviders);
  mock.module('src/providers/model/providers.js', () => realProviders);
  mock.module('src/terminal/ink.js', () => realInk);
  mock.module('src/terminal/ink.js', () => realInk);
});
