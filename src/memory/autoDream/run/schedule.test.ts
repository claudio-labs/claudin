import { describe, expect, test } from 'bun:test'

import {
  type BeforeScan,
  decideAfterScan,
  decideBeforeScan,
  type DreamThresholds,
  type ScheduleFacts,
} from 'src/memory/autoDream/run/schedule.js'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const THRESHOLDS: DreamThresholds = { minHours: 24, minSessions: 5, scanIntervalMs: 10 * MINUTE }
const NOW = 1_000 * HOUR

const facts = (overrides: Partial<ScheduleFacts>): ScheduleFacts => ({
  gatesOpen: true,
  now: NOW,
  lastConsolidatedAt: NOW - 30 * HOUR,
  lastScanAt: undefined,
  ...overrides,
})

describe('decideBeforeScan', () => {
  const cases: Array<[string, Partial<ScheduleFacts>, BeforeScan['kind']]> = [
    ['a closed gate wins over everything', { gatesOpen: false, lastConsolidatedAt: NOW, lastScanAt: NOW }, 'closed'],
    ['never consolidated, never scanned', { lastConsolidatedAt: 0 }, 'scan'],
    ['one millisecond short of 24 hours', { lastConsolidatedAt: NOW - 24 * HOUR + 1 }, 'notDue'],
    ['exactly 24 hours', { lastConsolidatedAt: NOW - 24 * HOUR }, 'scan'],
    ['not due also wins over the throttle', { lastConsolidatedAt: NOW - HOUR, lastScanAt: NOW }, 'notDue'],
    ['scanned one millisecond short of 10 minutes ago', { lastScanAt: NOW - 10 * MINUTE + 1 }, 'throttled'],
    ['scanned exactly 10 minutes ago', { lastScanAt: NOW - 10 * MINUTE }, 'scan'],
  ]
  test.each(cases)('%s', (_, overrides, kind) => {
    expect(decideBeforeScan(facts(overrides), THRESHOLDS).kind).toBe(kind)
  })
})

describe('decideAfterScan', () => {
  test('fewer than the minimum is too few, with the count; the minimum is due, with the sessions and the period start', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    expect(decideAfterScan(ids.slice(0, 4), 7, THRESHOLDS)).toEqual({ kind: 'tooFewSessions', count: 4 })
    expect(decideAfterScan(ids, 7, THRESHOLDS)).toEqual({ kind: 'due', sessionIds: ids, lastAt: 7 })
  })
})
