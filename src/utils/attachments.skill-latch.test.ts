import { beforeEach, describe, expect, test } from 'bun:test'
import {
  filterToBundledAndMcp,
  resetSentSkillNames,
  suppressNextSkillListing,
  _getSkillLatchSnapshotForTests,
  _seedSentSkillNamesForTests,
} from './attachments.js'
import type { Command } from 'src/commands.js'

function cmd(name: string, loadedFrom: Command['loadedFrom']): Command {
  return { name, loadedFrom } as unknown as Command
}

describe('filterToBundledAndMcp', () => {
  test('keeps bundled + mcp, drops everything else', () => {
    const input: Command[] = [
      cmd('a', 'bundled'),
      cmd('b', 'mcp'),
      cmd('c', 'skills'),
      cmd('d', 'plugin'),
    ]
    const out = filterToBundledAndMcp(input)
    expect(out.map(c => c.name).sort()).toEqual(['a', 'b'])
  })

  test('when bundled+mcp combined exceeds 30 entries, falls back to bundled-only', () => {
    const bundled = Array.from({ length: 25 }, (_, i) => cmd(`b${i}`, 'bundled'))
    const mcps = Array.from({ length: 10 }, (_, i) => cmd(`m${i}`, 'mcp'))
    const out = filterToBundledAndMcp([...bundled, ...mcps])
    expect(out).toHaveLength(25)
    expect(out.every(c => c.loadedFrom === 'bundled')).toBe(true)
  })

  test('exact boundary: bundled+mcp == 30 keeps both', () => {
    const bundled = Array.from({ length: 20 }, (_, i) => cmd(`b${i}`, 'bundled'))
    const mcps = Array.from({ length: 10 }, (_, i) => cmd(`m${i}`, 'mcp'))
    const out = filterToBundledAndMcp([...bundled, ...mcps])
    expect(out).toHaveLength(30)
    expect(out.some(c => c.loadedFrom === 'mcp')).toBe(true)
  })

  test('boundary +1: 31 falls back', () => {
    const bundled = Array.from({ length: 20 }, (_, i) => cmd(`b${i}`, 'bundled'))
    const mcps = Array.from({ length: 11 }, (_, i) => cmd(`m${i}`, 'mcp'))
    const out = filterToBundledAndMcp([...bundled, ...mcps])
    expect(out).toHaveLength(20)
    expect(out.every(c => c.loadedFrom === 'bundled')).toBe(true)
  })

  test('empty input returns []', () => {
    expect(filterToBundledAndMcp([])).toEqual([])
  })
})

describe('skill-listing latch — reset and suppress semantics', () => {
  beforeEach(() => {
    resetSentSkillNames()
  })

  test('initial latch state is clean', () => {
    const snap = _getSkillLatchSnapshotForTests()
    expect(snap.suppressNext).toBe(false)
    expect(snap.sentByAgent).toEqual({})
  })

  test('suppressNextSkillListing flips the flag', () => {
    suppressNextSkillListing()
    expect(_getSkillLatchSnapshotForTests().suppressNext).toBe(true)
  })

  test('resetSentSkillNames clears the suppress flag', () => {
    suppressNextSkillListing()
    resetSentSkillNames()
    expect(_getSkillLatchSnapshotForTests().suppressNext).toBe(false)
  })

  test('resetSentSkillNames clears all per-agent sent sets', () => {
    _seedSentSkillNamesForTests('', ['bundled-a', 'mcp-b'])
    _seedSentSkillNamesForTests('subagent-1', ['bundled-c'])
    expect(_getSkillLatchSnapshotForTests().sentByAgent).toEqual({
      '': ['bundled-a', 'mcp-b'],
      'subagent-1': ['bundled-c'],
    })

    resetSentSkillNames()

    expect(_getSkillLatchSnapshotForTests().sentByAgent).toEqual({})
  })

  test('per-agent keying: main thread ("") and subagent ids are independent', () => {
    _seedSentSkillNamesForTests('', ['skill-A'])
    _seedSentSkillNamesForTests('subagent-1', ['skill-B'])
    _seedSentSkillNamesForTests('subagent-2', ['skill-C'])

    const snap = _getSkillLatchSnapshotForTests()
    expect(snap.sentByAgent['']).toEqual(['skill-A'])
    expect(snap.sentByAgent['subagent-1']).toEqual(['skill-B'])
    expect(snap.sentByAgent['subagent-2']).toEqual(['skill-C'])
  })

  test('reset is a single atomic operation across all keys', () => {
    _seedSentSkillNamesForTests('', ['x'])
    _seedSentSkillNamesForTests('subagent-1', ['y'])
    suppressNextSkillListing()

    resetSentSkillNames()

    const snap = _getSkillLatchSnapshotForTests()
    expect(snap.suppressNext).toBe(false)
    expect(snap.sentByAgent).toEqual({})
  })
})
