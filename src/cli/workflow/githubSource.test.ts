import { describe, expect, test } from 'bun:test'

import {
  extractPrUrl,
  parseDefaultBranch,
  parseTriggerIssues,
} from './githubSource.js'

describe('parseTriggerIssues', () => {
  test('parses a well-formed gh issue list payload', () => {
    const stdout = JSON.stringify([
      { number: 12, title: 'Fix the bug', body: 'details', updatedAt: '2026-07-17T00:00:00Z' },
      { number: 13, title: 'Add feature', body: '', updatedAt: '2026-07-16T00:00:00Z' },
    ])
    const issues = parseTriggerIssues(stdout)
    expect(issues).toHaveLength(2)
    expect(issues[0]!.number).toBe(12)
    expect(issues[1]!.title).toBe('Add feature')
  })

  test('drops entries without a numeric number', () => {
    const stdout = JSON.stringify([
      { number: 1, title: 'ok', body: '', updatedAt: '' },
      { title: 'missing number' },
      null,
    ])
    expect(parseTriggerIssues(stdout).map(i => i.number)).toEqual([1])
  })

  test('returns [] for non-array or malformed JSON', () => {
    expect(parseTriggerIssues('{}')).toEqual([])
    expect(parseTriggerIssues('not json')).toEqual([])
    expect(parseTriggerIssues('')).toEqual([])
  })
})

describe('parseDefaultBranch', () => {
  test('strips the origin/ prefix', () => {
    expect(parseDefaultBranch('origin/main\n')).toBe('main')
    expect(parseDefaultBranch('origin/develop')).toBe('develop')
  })

  test('handles a bare branch name', () => {
    expect(parseDefaultBranch('trunk')).toBe('trunk')
  })

  test('falls back to main on empty input', () => {
    expect(parseDefaultBranch('')).toBe('main')
    expect(parseDefaultBranch('   ')).toBe('main')
  })
})

describe('extractPrUrl', () => {
  test('extracts a github PR URL from gh output', () => {
    const stdout =
      'Creating pull request for worktree-x into main\n\nhttps://github.com/acme/repo/pull/42\n'
    expect(extractPrUrl(stdout)).toBe('https://github.com/acme/repo/pull/42')
  })

  test('accepts a bare http(s) URL line as the PR url', () => {
    expect(extractPrUrl('https://git.example.com/x/y/pull/3\n')).toBe(
      'https://git.example.com/x/y/pull/3',
    )
  })

  test('returns null on non-URL stdout (no bogus fallback)', () => {
    expect(extractPrUrl('some-branch\n')).toBeNull()
    expect(extractPrUrl('warning: something happened\n')).toBeNull()
  })

  test('returns null on empty output', () => {
    expect(extractPrUrl('')).toBeNull()
    expect(extractPrUrl('   \n')).toBeNull()
  })
})
