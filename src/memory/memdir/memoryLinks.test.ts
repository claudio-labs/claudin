import { describe, expect, test } from 'bun:test'
import type { AuditedFile } from 'src/memory/memdir/memoryAudit.js'
import { findLinkFindings } from 'src/memory/memdir/memoryLinks.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'

const DIRS = testMemoryDirs({ global: '/g', private: '/r/m', team: '/r/m/team' })

const memory = (name: string, body = '', extra: string[] = []): string =>
  ['---', `name: ${name}`, 'description: d', 'type: project', ...extra, '---', '', body].join('\n')

const files = (scope: AuditedFile['scope'], entries: Record<string, string>): AuditedFile[] =>
  Object.entries(entries).map(([path, content]) => ({ scope, path, content }))

describe('findLinkFindings — broken links', () => {
  test('a team memory linking a private name is broken; the same link from a private memory resolves', () => {
    const all = [
      ...files('private', { '/r/m/MEMORY.md': '- [P](p.md) — p\n', '/r/m/p.md': memory('p', 'See [[t-note]] and [[mine]].'), '/r/m/mine.md': memory('mine') }),
      ...files('team', { '/r/m/team/MEMORY.md': '- [T](t-note.md) — t\n', '/r/m/team/t-note.md': memory('t-note', 'From [[mine]].') }),
    ]
    const findings = findLinkFindings(all, DIRS).filter(f => f.kind === 'broken-link')
    expect(findings).toEqual([{ kind: 'broken-link', scope: 'team', path: '/r/m/team/t-note.md', target: '[[mine]]' }])
  })

  test('a global memory only sees global ones', () => {
    const all = [
      ...files('global', { '/g/MEMORY.md': '- [G](g.md) — g\n', '/g/g.md': memory('g', 'Like [[p]].') }),
      ...files('private', { '/r/m/MEMORY.md': '- [P](p.md) — p\n', '/r/m/p.md': memory('p') }),
    ]
    expect(findLinkFindings(all, DIRS)).toEqual([{ kind: 'broken-link', scope: 'global', path: '/g/g.md', target: '[[p]]' }])
  })

  test('a [[link]] matches a file stem or a frontmatter name, and reaches the memory either way', () => {
    const all = files('team', {
      '/r/m/team/MEMORY.md': '- [A](a.md) — a\n',
      '/r/m/team/a.md': memory('a', 'By stem [[stem-only]], by name [[Pretty Name]].'),
      '/r/m/team/bugs/stem-only.md': memory('another-name'),
      '/r/m/team/bugs/by-name.md': memory('Pretty Name'),
    })
    expect(findLinkFindings(all, DIRS)).toEqual([])
  })

  test('a [[link]] to a memory not written yet is a forward link, not a finding', () => {
    const all = files('team', { '/r/m/team/MEMORY.md': '- [A](a.md) — a\n', '/r/m/team/a.md': memory('a', 'Later: [[worth-writing]].') })
    expect(findLinkFindings(all, DIRS)).toEqual([])
  })

  test('a markdown link to a missing memory is broken; anchors, URLs and targets outside the directory are not checked', () => {
    const all = [
      ...files('team', {
        '/r/m/team/MEMORY.md': [
          '- [A](a.md#why) — a',
          '- [Gone](decisions/gone.md) — g',
          '- [Skill](../../skills/x/SKILL.md) — s',
          '- [Site](https://example.test/page.md) — u',
        ].join('\n'),
        '/r/m/team/a.md': memory('a'),
      }),
      ...files('private', { '/r/m/MEMORY.md': '- [T](team/a.md) — reached through team\n' }),
    ]
    expect(findLinkFindings(all, DIRS)).toEqual([
      { kind: 'broken-link', scope: 'team', path: '/r/m/team/MEMORY.md', target: 'decisions/gone.md' },
    ])
  })

  test('text in code spans and fences is not a link', () => {
    const all = files('team', {
      '/r/m/team/MEMORY.md': '- [A](a.md) — a\n',
      '/r/m/team/a.md': memory('a', 'Write `[[name]]` or `- [Title](file.md)`.\n\n```\n[[other]]\n```\n'),
    })
    expect(findLinkFindings(all, DIRS)).toEqual([])
  })

  test('one finding per file and target, however often or however spaced it is written', () => {
    const all = [
      ...files('private', { '/r/m/MEMORY.md': '- [M](mine.md) — m\n', '/r/m/mine.md': memory('mine') }),
      ...files('team', {
        '/r/m/team/MEMORY.md': '- [A](a.md) — a\n- [B](b.md) — b\n',
        '/r/m/team/a.md': memory('a', '[[mine]] and again [[mine]]'),
        '/r/m/team/b.md': memory('b', '[[ mine ]]'),
      }),
    ]
    expect(findLinkFindings(all, DIRS).map(f => f.path)).toEqual(['/r/m/team/a.md', '/r/m/team/b.md'])
  })
})

describe('findLinkFindings — unindexed', () => {
  test('a chain of links from the index reaches a memory; nothing reaching it is a finding', () => {
    const all = files('team', {
      '/r/m/team/MEMORY.md': '- [A](a.md) — a\n',
      '/r/m/team/a.md': memory('a', 'Rounds: [[b]].'),
      '/r/m/team/b.md': memory('b', 'Then [c](decisions/c.md).'),
      '/r/m/team/decisions/c.md': memory('c'),
      '/r/m/team/lost.md': memory('lost'),
    })
    expect(findLinkFindings(all, DIRS)).toEqual([{ kind: 'unindexed', scope: 'team', path: '/r/m/team/lost.md' }])
  })

  test('orphans linking each other are still orphans, and a paths: memory needs no index line', () => {
    const all = files('team', {
      '/r/m/team/MEMORY.md': '- [A](a.md) — a\n',
      '/r/m/team/a.md': memory('a'),
      '/r/m/team/x.md': memory('x', '[[y]]'),
      '/r/m/team/y.md': memory('y', '[[x]]'),
      '/r/m/team/bugs/scoped.md': memory('scoped', '', ['paths:', '  - "src/**"']),
    })
    expect(findLinkFindings(all, DIRS).map(f => [f.kind, f.path])).toEqual([
      ['unindexed', '/r/m/team/x.md'],
      ['unindexed', '/r/m/team/y.md'],
    ])
  })

  test('a directory with memories and no index: every memory is unindexed', () => {
    const all = files('private', { '/r/m/a.md': memory('a') })
    expect(findLinkFindings(all, DIRS)).toEqual([{ kind: 'unindexed', scope: 'private', path: '/r/m/a.md' }])
  })

  test('a link into another directory does not index a memory there', () => {
    const all = [
      ...files('private', { '/r/m/MEMORY.md': '- [P](p.md) — p\n', '/r/m/p.md': memory('p', '[[t]]') }),
      ...files('team', { '/r/m/team/MEMORY.md': '', '/r/m/team/t.md': memory('t') }),
    ]
    expect(findLinkFindings(all, DIRS)).toEqual([{ kind: 'unindexed', scope: 'team', path: '/r/m/team/t.md' }])
  })
})

describe('findLinkFindings — duplicate names', () => {
  test('two memories of one directory sharing a name are each a finding; across directories they are not', () => {
    const all = [
      ...files('team', {
        '/r/m/team/MEMORY.md': '- [A](a.md) — a\n- [B](bugs/b.md) — b\n',
        '/r/m/team/a.md': memory('same'),
        '/r/m/team/bugs/b.md': memory('same'),
      }),
      ...files('private', { '/r/m/MEMORY.md': '- [C](c.md) — c\n', '/r/m/c.md': memory('same') }),
    ]
    expect(findLinkFindings(all, DIRS)).toEqual([
      { kind: 'duplicate-name', scope: 'team', path: '/r/m/team/a.md', name: 'same' },
      { kind: 'duplicate-name', scope: 'team', path: '/r/m/team/bugs/b.md', name: 'same' },
    ])
  })
})
