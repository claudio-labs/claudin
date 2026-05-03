/**
 * Regression tests for the provider-switch token bleed fix.
 *
 * Background: prior to the per-provider scoping, `SessionTokensIndicator`
 * read four global getters (`getTotalInputTokens`, `getTotalCacheReadInputTokens`,
 * etc.) that summed *all* `modelUsage` entries regardless of which provider
 * those tokens were billed under. Switching from Anthropic to Ollama (or back)
 * left cache tokens from the prior provider in `total`, producing visibly
 * inconsistent rows like `↑ X ↓ Y · total Z` with `Z ≠ X+Y`.
 *
 * These tests pin the new contract: `readSnapshot()` only sums `modelUsage`
 * entries whose key appears in the active profile's `model` list.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

let usage: { [model: string]: ModelUsage } = {};
let profile: { id: string; model: string; baseUrl: string } | undefined;

function setUsage(next: { [model: string]: ModelUsage }) {
  usage = next;
}

function setProfile(next: typeof profile) {
  profile = next;
}

mock.module('../cost-tracker.js', () => ({
  getModelUsage: () => usage,
  // Globals sum every model — used by the no-active-provider fallback path
  getTotalInputTokens: () =>
    Object.values(usage).reduce((s, m) => s + m.inputTokens, 0),
  getTotalOutputTokens: () =>
    Object.values(usage).reduce((s, m) => s + m.outputTokens, 0),
  getTotalCacheReadInputTokens: () =>
    Object.values(usage).reduce((s, m) => s + m.cacheReadInputTokens, 0),
  getTotalCacheCreationInputTokens: () =>
    Object.values(usage).reduce((s, m) => s + m.cacheCreationInputTokens, 0),
}));

mock.module('../services/api/activeProvider.js', () => ({
  tryGetActiveProvider: () => profile,
}));

let cacheProviderResolution = 'anthropic';
function setCacheProvider(name: string) {
  cacheProviderResolution = name;
}

mock.module('../services/api/cacheMetrics.js', () => ({
  resolveCacheProvider: () => cacheProviderResolution,
}));

mock.module('../utils/model/providers.js', () => ({
  getAPIProvider: () => 'anthropic',
  isGithubNativeAnthropicMode: () => false,
}));

let resolvedMainLoopModel: string | undefined;
function setResolvedMainLoopModel(name: string | undefined) {
  resolvedMainLoopModel = name;
}
mock.module('../utils/model/model.js', () => ({
  getMainLoopModel: () => resolvedMainLoopModel,
}));

mock.module('../ink.js', () => ({
  Box: () => null,
  Text: () => null,
}));

// `readSnapshot` is the only export under test. The component itself uses
// `useAppState`, which transitively pulls in Ink's `useInput` — irrelevant
// here, so stub the hook surface.
mock.module('../state/AppState.js', () => ({
  useAppState: () => undefined,
  useSetAppState: () => () => undefined,
}));

const { readSnapshot } = await import('./SessionTokensIndicator.js');

afterEach(() => {
  setUsage({});
  setProfile(undefined);
  setCacheProvider('anthropic');
  setResolvedMainLoopModel(undefined);
});

describe('readSnapshot — per-provider scoping', () => {
  test('Anthropic→Ollama: cache tokens from Anthropic do not leak into Ollama snapshot', () => {
    // Sequence: user used Anthropic (recorded under "claude-3-5-sonnet"),
    // then switched to Ollama. Both buckets exist in modelUsage; snapshot
    // for the *active* Ollama profile must only see Ollama's numbers.
    setUsage({
      'claude-3-5-sonnet': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 4000,
        cacheCreationInputTokens: 1000,
      },
      'llama3.1:8b': {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    setProfile({ id: 'ollama-1', model: 'llama3.1:8b', baseUrl: 'http://localhost:11434' });

    const snap = readSnapshot();

    expect(snap.input).toBe(20);
    expect(snap.output).toBe(10);
    expect(snap.cacheRead).toBe(0);
    expect(snap.cacheCreation).toBe(0);
  });

  test('Ollama→Anthropic: snapshot omits Ollama and includes only Anthropic models', () => {
    setUsage({
      'llama3.1:8b': {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      'claude-3-5-sonnet': {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 11,
      },
    });
    setProfile({ id: 'anthropic-1', model: 'claude-3-5-sonnet', baseUrl: 'https://api.anthropic.com' });

    const snap = readSnapshot();

    expect(snap.input).toBe(7);
    expect(snap.output).toBe(3);
    expect(snap.cacheRead).toBe(50);
    expect(snap.cacheCreation).toBe(11);
  });

  test('multi-model profile: sums all configured models for the active profile', () => {
    setUsage({
      'glm-4.7': {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      'glm-4.7-flash': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      'unrelated-model': {
        inputTokens: 999,
        outputTokens: 999,
        cacheReadInputTokens: 999,
        cacheCreationInputTokens: 999,
      },
    });
    setProfile({ id: 'zai-1', model: 'glm-4.7, glm-4.7-flash', baseUrl: 'https://example' });

    const snap = readSnapshot();

    expect(snap.input).toBe(110);
    expect(snap.output).toBe(55);
  });

  test('no active profile: falls back to global totals', () => {
    setUsage({
      'a': {
        inputTokens: 1, outputTokens: 2,
        cacheReadInputTokens: 3, cacheCreationInputTokens: 4,
      },
      'b': {
        inputTokens: 10, outputTokens: 20,
        cacheReadInputTokens: 30, cacheCreationInputTokens: 40,
      },
    });
    setProfile(undefined);

    const snap = readSnapshot();

    expect(snap.input).toBe(11);
    expect(snap.output).toBe(22);
    expect(snap.cacheRead).toBe(33);
    expect(snap.cacheCreation).toBe(44);
  });

  test('/model drift: tokens recorded under a sibling model not in profile.model are still counted via extraModels', () => {
    // Profile is configured with one model, but the user used `/model` to
    // switch to a sibling Anthropic model not present in profile.model.
    // mainLoopModel (passed as extraModels) must bring that bucket back in.
    setUsage({
      'claude-opus-4-7': {
        inputTokens: 0, outputTokens: 0,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      },
      'claude-sonnet-4-6': {
        inputTokens: 500, outputTokens: 200,
        cacheReadInputTokens: 1000, cacheCreationInputTokens: 300,
      },
    });
    setProfile({ id: 'anthropic-1', model: 'claude-opus-4-7', baseUrl: 'https://api.anthropic.com' });

    const snap = readSnapshot(['claude-sonnet-4-6', null]);

    expect(snap.input).toBe(500);
    expect(snap.output).toBe(200);
    expect(snap.cacheRead).toBe(1000);
    expect(snap.cacheCreation).toBe(300);
  });

  test('resolved mainLoopModel ([1m] suffix) is counted even when profile.model lacks it', () => {
    // Reproduces the bug where the indicator went blank: cost-tracker keys
    // usage by the *resolved* model name (e.g. `claude-opus-4-7[1m]`), but
    // profile.model often holds the unresolved form (no suffix), and
    // appState.mainLoopModel can be the user alias (`opus[1m]`) or null.
    // getMainLoopModel() is the only source for the resolved name.
    setUsage({
      'claude-opus-4-7[1m]': {
        inputTokens: 12, outputTokens: 8,
        cacheReadInputTokens: 116000, cacheCreationInputTokens: 63800,
      },
    });
    setProfile({ id: 'anthropic-1', model: 'claude-opus-4-7', baseUrl: 'https://api.anthropic.com' });
    setResolvedMainLoopModel('claude-opus-4-7[1m]');

    const snap = readSnapshot();

    expect(snap.input).toBe(12);
    expect(snap.output).toBe(8);
    expect(snap.cacheRead).toBe(116000);
    expect(snap.cacheCreation).toBe(63800);
  });

  test('extraModels deduplicates against profile.model (no double-count)', () => {
    setUsage({
      'claude-opus-4-7': {
        inputTokens: 10, outputTokens: 5,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      },
    });
    setProfile({ id: 'anthropic-1', model: 'claude-opus-4-7', baseUrl: 'https://api.anthropic.com' });

    // mainLoopModel matches profile.model — must not be summed twice.
    const snap = readSnapshot(['claude-opus-4-7']);

    expect(snap.input).toBe(10);
    expect(snap.output).toBe(5);
  });

  test('active profile model not yet recorded in modelUsage: returns zeros', () => {
    setUsage({
      'other-model': {
        inputTokens: 9999, outputTokens: 9999,
        cacheReadInputTokens: 9999, cacheCreationInputTokens: 9999,
      },
    });
    setProfile({ id: 'cold-1', model: 'just-activated-model', baseUrl: 'https://example' });

    const snap = readSnapshot();

    expect(snap.input).toBe(0);
    expect(snap.output).toBe(0);
    expect(snap.cacheRead).toBe(0);
    expect(snap.cacheCreation).toBe(0);
  });
});

describe('readSnapshot — layout flip via supportsCache', () => {
  // The bug being regression-tested is "layout flips on /provider switch but
  // numbers don't" — so we pin both halves of that contract: layout flag
  // tracks the resolved cache provider, while numbers track the active
  // profile's models. These two must agree per provider.

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
