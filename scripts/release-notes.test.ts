import { describe, expect, test } from 'bun:test'
import { classify, groupCommits, renderNotes } from './release-notes.ts'

describe('classify', () => {
  test('maps conventional types to their section', () => {
    expect(classify('feat(typecheck): baseline-aware Typecheck tool')).toBe('feat')
    expect(classify('fix(vertex): hand the stub a real Headers')).toBe('fix')
    expect(classify('perf(cache): reuse the clip frontier')).toBe('perf')
    expect(classify('refactor(api): split the shim')).toBe('refactor')
    expect(classify('docs(readme): center the logo')).toBe('docs')
    expect(classify('test(diff): cover the hunk parser')).toBe('test')
    expect(classify('ci: skip the workflow on bot commits')).toBe('ci')
    expect(classify('build: bump the bundler')).toBe('ci')
  })

  test('routes dependency bumps to their own section, whatever the type', () => {
    expect(classify('chore(deps): bump google-auth-library from 10.9.1 to 11.0.0')).toBe('deps')
    expect(classify('build(deps-dev): bump typescript')).toBe('deps')
    expect(classify('chore(deps,build): dedupe google-auth-library')).toBe('deps')
  })

  test('a ! marker wins over the type', () => {
    expect(classify('feat(api)!: drop the --provider flag')).toBe('breaking')
    expect(classify('fix!: rename the config dir')).toBe('breaking')
  })

  test('drops the release bot bookkeeping commits', () => {
    expect(classify('chore(release): v1.1.7')).toBeNull()
    expect(classify('chore(changelog): v1.1.7')).toBeNull()
  })

  test('falls back to misc for chores and unparseable subjects', () => {
    expect(classify('chore: tidy up')).toBe('misc')
    expect(classify('Merge branch main into feature')).toBe('misc')
    expect(classify('wip')).toBe('misc')
  })
})

describe('renderNotes', () => {
  const commits = [
    { subject: 'feat(typecheck): baseline-aware Typecheck tool (#48)', hash: 'c3b86a3' },
    { subject: 'chore(deps): dedupe google-auth-library via a $-ref override', hash: '241f6af' },
    { subject: 'fix(vertex): hand the SKIP_VERTEX_AUTH stub a real Headers', hash: 'ea0fefb' },
    { subject: 'chore(release): v1.1.7', hash: '3c739ae' },
  ]

  test('groups the commits under emoji headings in a fixed order', () => {
    expect(renderNotes(commits)).toMatchSnapshot()
  })

  test('omits sections with no commits and the bookkeeping commit', () => {
    const out = renderNotes(commits)
    expect(out).not.toContain('Documentation')
    expect(out).not.toContain('chore(release)')
    expect(out.indexOf('✨ Features')).toBeLessThan(out.indexOf('🐛 Bug Fixes'))
    expect(out.indexOf('🐛 Bug Fixes')).toBeLessThan(out.indexOf('📦 Dependencies'))
  })

  test('neutralizes @mentions so GitHub does not add its own contributors strip', () => {
    const out = renderNotes([{ subject: 'chore(deps): bump @opentelemetry/api', hash: 'abc1234' }])
    expect(out).toContain('@\u200bopentelemetry/api')
  })

  test('keeps the empty-range wording used by the release body', () => {
    expect(renderNotes([])).toBe('_No user-facing commits since previous tag._')
    expect(renderNotes([{ subject: 'chore(release): v1.1.7', hash: '3c739ae' }])).toBe(
      '_No user-facing commits since previous tag._',
    )
  })
})

describe('groupCommits', () => {
  test('preserves git order inside a section', () => {
    const groups = groupCommits([
      { subject: 'fix: second', hash: 'bbb1111' },
      { subject: 'fix: first', hash: 'aaa1111' },
    ])
    expect(groups.get('fix')?.map(c => c.hash)).toEqual(['bbb1111', 'aaa1111'])
  })
})
