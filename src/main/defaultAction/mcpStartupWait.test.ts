import { describe, expect, test } from 'bun:test';
import { DEFAULT_MCP_STARTUP_TIMEOUT_MS, getMcpStartupTimeoutMs, raceConnectTimeout } from './mcpStartupWait.js';

describe('getMcpStartupTimeoutMs', () => {
  test('defaults to 30000ms when env var is unset', () => {
    expect(getMcpStartupTimeoutMs({})).toBe(30_000);
    expect(getMcpStartupTimeoutMs({})).toBe(DEFAULT_MCP_STARTUP_TIMEOUT_MS);
  });

  test('respects CLAUDIN_MCP_STARTUP_TIMEOUT_MS override', () => {
    expect(getMcpStartupTimeoutMs({ CLAUDIN_MCP_STARTUP_TIMEOUT_MS: '5000' })).toBe(5_000);
    expect(getMcpStartupTimeoutMs({ CLAUDIN_MCP_STARTUP_TIMEOUT_MS: '120000' })).toBe(120_000);
  });

  test('falls back to default on NaN, empty, zero, and negative values', () => {
    // Fallback pattern — never throw, return best-effort
    expect(getMcpStartupTimeoutMs({ CLAUDIN_MCP_STARTUP_TIMEOUT_MS: 'abc' })).toBe(DEFAULT_MCP_STARTUP_TIMEOUT_MS);
    expect(getMcpStartupTimeoutMs({ CLAUDIN_MCP_STARTUP_TIMEOUT_MS: '' })).toBe(DEFAULT_MCP_STARTUP_TIMEOUT_MS);
    expect(getMcpStartupTimeoutMs({ CLAUDIN_MCP_STARTUP_TIMEOUT_MS: '0' })).toBe(DEFAULT_MCP_STARTUP_TIMEOUT_MS);
    expect(getMcpStartupTimeoutMs({ CLAUDIN_MCP_STARTUP_TIMEOUT_MS: '-100' })).toBe(DEFAULT_MCP_STARTUP_TIMEOUT_MS);
    expect(getMcpStartupTimeoutMs({ CLAUDIN_MCP_STARTUP_TIMEOUT_MS: 'Infinity' })).toBe(DEFAULT_MCP_STARTUP_TIMEOUT_MS);
  });
});

describe('raceConnectTimeout', () => {
  test('fast connect resolves false without waiting for the timeout', async () => {
    const start = Date.now();
    const timedOut = await raceConnectTimeout(Promise.resolve(), 10_000);
    expect(timedOut).toBe(false);
    // Must not block until the 10s cap — fast path is unaffected
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test('timeout fires on a hung connect and resolves true', async () => {
    const never = new Promise(() => {});
    const start = Date.now();
    const timedOut = await raceConnectTimeout(never, 50);
    expect(timedOut).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  test('connect that settles just before the cap resolves false', async () => {
    const slow = new Promise<void>(resolve => setTimeout(resolve, 20));
    const timedOut = await raceConnectTimeout(slow, 5_000);
    expect(timedOut).toBe(false);
  });

  test('env override drives the effective cap end-to-end', async () => {
    const ms = getMcpStartupTimeoutMs({ CLAUDIN_MCP_STARTUP_TIMEOUT_MS: '50' });
    expect(ms).toBe(50);
    const timedOut = await raceConnectTimeout(new Promise(() => {}), ms);
    expect(timedOut).toBe(true);
  });
});
