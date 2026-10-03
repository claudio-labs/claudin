/**
 * The memory-directory listing: which files of a memory directory are listed,
 * what is read from each one's frontmatter, and the one-line-per-file manifest
 * the extraction and recall prompts embed. Every test builds a real directory
 * in a fresh temp root.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { formatMemoryManifest, scanMemoryFiles, type MemoryHeader } from 'src/memory/memdir/memoryScan.js'

let root = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'teammem-scan-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A fixed instant, so the manifest timestamps are exact. */
const BASE = Date.UTC(2026, 3, 14, 9, 30, 0)

/** Writes `rel` under the root, with its modification time `minutes` after BASE. */
function put(rel: string, text: string, minutes = 0): string {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  const at = new Date(BASE + minutes * 60_000)
  utimesSync(path, at, at)
  return path
}

function memory(fields: Record<string, string>, bodyText = 'The fact itself.\n'): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`)
  return ['---', ...lines, '---', '', bodyText].join('\n')
}

const scan = (dir = root, signal = new AbortController().signal): Promise<MemoryHeader[]> =>
  scanMemoryFiles(dir, signal)

const names = (headers: MemoryHeader[]): string[] => headers.map(h => h.filename)

describe('scanMemoryFiles: which files are listed', () => {
  test('every .md file down to two directories deep, newest first, without any index', async () => {
    put('user_role.md', memory({ description: 'role' }), 1)
    put('team/deploy.md', memory({ description: 'deploy' }), 5)
    put('team/bugs/flaky.md', memory({ description: 'flaky' }), 3)
    put('team/bugs/old/too-deep.md', memory({ description: 'deep' }), 9)
    put('MEMORY.md', '- index\n', 8)
    put('team/MEMORY.md', '- team index\n', 7)
    put('notes.txt', 'not a memory', 6)
    put('draft.MD', memory({ description: 'upper' }), 6)
    put('memory.md', memory({ description: 'lower-case index name' }), 2)

    expect(names(await scan())).toEqual([
      join('team', 'deploy.md'),
      join('team', 'bugs', 'flaky.md'),
      'memory.md',
      'user_role.md',
    ])
  })

  test('each entry carries the relative name, the absolute path and the modification time', async () => {
    const path = put('team/deploy.md', memory({ description: 'how to deploy', type: 'project' }), 30)
    expect(await scan()).toEqual([
      {
        filename: join('team', 'deploy.md'),
        filePath: path,
        mtimeMs: BASE + 30 * 60_000,
        description: 'how to deploy',
        type: 'project',
      },
    ])
  })

  test('the list keeps the 200 newest files', async () => {
    for (let i = 0; i < 205; i++) put(`m${String(i).padStart(3, '0')}.md`, memory({ description: `n${i}` }), i)
    const headers = await scan()
    expect(headers).toHaveLength(200)
    expect(headers[0]!.filename).toBe('m204.md')
    expect(headers[199]!.filename).toBe('m005.md')
    expect(names(headers)).not.toContain('m004.md')
  })

  test('a directory named like a memory file is skipped, and the rest still listed', async () => {
    mkdirSync(join(root, 'looks-like.md'))
    put('real.md', memory({ description: 'real' }))
    expect(names(await scan())).toEqual(['real.md'])
  })

  test('a symlinked directory is walked like a real one, under the name of the link', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'teammem-outside-')))
    try {
      const shared = join(outside, 'shared.md')
      writeFileSync(shared, memory({ description: 'linked in' }))
      utimesSync(shared, new Date(BASE + 60_000), new Date(BASE + 60_000))
      symlinkSync(outside, join(root, 'linked'))
      put('own.md', memory({ description: 'own' }))
      const headers = await scan()
      expect(names(headers)).toEqual([join('linked', 'shared.md'), 'own.md'])
      expect(headers[0]!.filePath).toBe(join(root, 'linked', 'shared.md'))
      expect(headers[0]!.description).toBe('linked in')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('scanMemoryFiles: what is read from each file', () => {
  const cases: Array<[string, string, string | null, string | undefined]> = [
    ['a description and a known type', memory({ description: 'deploy steps', type: 'feedback' }), 'deploy steps', 'feedback'],
    ['each of the four types', memory({ type: 'user' }), null, 'user'],
    ['the reference type', memory({ type: 'reference' }), null, 'reference'],
    ['an unknown type', memory({ description: 'd', type: 'decision' }), 'd', undefined],
    ['a type in capitals', memory({ type: 'Project' }), null, undefined],
    ['an empty description', memory({ description: '""', type: 'project' }), null, 'project'],
    ['a description needing quotes', memory({ description: 'use: the vault, not env' }), 'use: the vault, not env', undefined],
    ['no frontmatter', '# Just a heading\n\nbody\n', null, undefined],
    ['frontmatter that never closes', '---\ndescription: open\ntype: user\n\nbody\n', null, undefined],
  ]
  test.each(cases)('%s', async (_what, text, description, type) => {
    put('note.md', text)
    const [header] = await scan()
    expect(header!.description).toBe(description)
    expect(header!.type).toBe(type as MemoryHeader['type'])
  })

  test('only the head of a file is read: frontmatter closing past line 30 is not seen', async () => {
    const padding = Array.from({ length: 30 }, (_, i) => `k${i}: v`)
    put('long.md', ['---', 'description: hidden', 'type: user', ...padding, '---', 'body'].join('\n'))
    put('short.md', ['---', 'description: seen', ...padding.slice(0, 26), '---', 'body'].join('\n'))
    const byName = Object.fromEntries((await scan()).map(h => [h.filename, h]))
    expect(byName['long.md']!.description).toBeNull()
    expect(byName['long.md']!.type).toBeUndefined()
    expect(byName['short.md']!.description).toBe('seen')
  })

  test('a large body does not stop the frontmatter from being read', async () => {
    put('big.md', memory({ description: 'big one', type: 'reference' }, 'line\n'.repeat(50_000)))
    const [header] = await scan()
    expect(header!.description).toBe('big one')
  })
})

describe('scanMemoryFiles: failures come back as an empty list', () => {
  test('a directory that does not exist', async () => {
    expect(await scan(join(root, 'missing'))).toEqual([])
  })

  test('a path that is a file', async () => {
    expect(await scan(put('plain.md', 'x'))).toEqual([])
  })

  test('an empty directory', async () => {
    expect(await scan()).toEqual([])
  })

  test('a signal already aborted', async () => {
    put('a.md', memory({ description: 'a' }))
    const controller = new AbortController()
    controller.abort()
    expect(await scan(root, controller.signal)).toEqual([])
  })
})

describe('formatMemoryManifest', () => {
  const header = (over: Partial<MemoryHeader>): MemoryHeader => ({
    filename: 'note.md',
    filePath: join(root, 'note.md'),
    mtimeMs: BASE,
    description: null,
    type: undefined,
    ...over,
  })

  const cases: Array<[string, Partial<MemoryHeader>, string]> = [
    ['type and description', { type: 'project', description: 'deploy steps' }, '- [project] note.md (2026-04-14T09:30:00.000Z): deploy steps'],
    ['no type', { description: 'deploy steps' }, '- note.md (2026-04-14T09:30:00.000Z): deploy steps'],
    ['no description', { type: 'user' }, '- [user] note.md (2026-04-14T09:30:00.000Z)'],
    ['neither', {}, '- note.md (2026-04-14T09:30:00.000Z)'],
    ['an empty description', { description: '' }, '- note.md (2026-04-14T09:30:00.000Z)'],
    ['a nested name and milliseconds', { filename: join('team', 'bugs', 'x.md'), mtimeMs: BASE + 1_234 }, `- ${join('team', 'bugs', 'x.md')} (2026-04-14T09:30:01.234Z)`],
  ]
  test.each(cases)('%s', (_what, over, line) => {
    expect(formatMemoryManifest([header(over)])).toBe(line)
  })

  test('one line per header, in the order given, with no trailing newline', () => {
    const text = formatMemoryManifest([
      header({ filename: 'b.md', mtimeMs: BASE }),
      header({ filename: 'a.md', mtimeMs: BASE + 60_000, type: 'feedback' }),
    ])
    expect(text).toBe('- b.md (2026-04-14T09:30:00.000Z)\n- [feedback] a.md (2026-04-14T09:31:00.000Z)')
  })

  test('no headers give an empty manifest', () => {
    expect(formatMemoryManifest([])).toBe('')
  })

  test('a scanned directory renders as its manifest', async () => {
    put('user_role.md', memory({ description: 'senior backend dev', type: 'user' }), 0)
    put('team/deploy.md', memory({ description: 'deploy from main only' }), 2)
    expect(formatMemoryManifest(await scan())).toBe(
      [
        `- ${join('team', 'deploy.md')} (2026-04-14T09:32:00.000Z): deploy from main only`,
        '- [user] user_role.md (2026-04-14T09:30:00.000Z): senior backend dev',
      ].join('\n'),
    )
  })
})
