import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'
import {
  memoryHygieneNotesIn,
  memoryWriteNotes,
  notesToAdvice,
  type MemoryWrite,
} from 'src/memory/memdir/memoryFormatGuard.js'
import { memoryTokens, type VisibleMemory } from 'src/memory/memdir/memoryHygiene.js'
import { getGlobalMemPath, getPrivateMemPath } from 'src/memory/memdir/paths.js'
import { applyPatchMemoryIndexAdvice } from 'src/tools/ApplyPatchTool/applyPatch.js'

const GLOBAL = '/home/u/.claudin/memory/'
const PRIVATE = '/repo/.claudin/memory/'
const TEAM = '/repo/.claudin/memory/team/'
const dirs = testMemoryDirs({ global: GLOBAL, private: PRIVATE, team: TEAM })

const memory = (lines: string[], body = 'Body.'): string => `---\n${lines.join('\n')}\n---\n\n${body}\n`
const visible = (scope: VisibleMemory['scope'], path: string, name: string, description: string): VisibleMemory => ({
  scope,
  path,
  name,
  tokens: memoryTokens(path, name, description),
})

const SAVED = [visible('team', `${TEAM}notes-sc-14.md`, 'notes-sc-14', 'adding a runtime dependency needs a review in the #deps channel first')]
const DEPS = memory(['name: runtime-deps-review', 'description: new runtime dependencies need a review in #deps before landing', 'type: project'])
const fresh = (content: string | null): MemoryWrite => ({ content, isNew: true, indexNote: true })

describe('memoryHygieneNotesIn', () => {
  test('a new memory that reads like a saved one names it', () => {
    const [note] = memoryHygieneNotesIn(dirs, `${TEAM}runtime-deps-review.md`, fresh(DEPS), () => SAVED)
    expect(note).toContain('`runtime-deps-review.md` reads like a memory already saved: `team:notes-sc-14.md`')
    expect(note).toContain('update that one and delete this one')
  })

  test('an update of a memory already on disk, or a write with no known content, gets none', () => {
    expect(memoryHygieneNotesIn(dirs, `${TEAM}runtime-deps-review.md`, { content: DEPS, isNew: false, indexNote: false }, () => SAVED)).toEqual([])
    expect(memoryHygieneNotesIn(dirs, `${TEAM}runtime-deps-review.md`, fresh(null), () => SAVED)).toEqual([])
  })

  test('the memory itself is never its own near-duplicate', () => {
    const self = [visible('team', `${TEAM}runtime-deps-review.md`, 'runtime-deps-review', 'new runtime dependencies need a review in #deps before landing')]
    expect(memoryHygieneNotesIn(dirs, `${TEAM}runtime-deps-review.md`, fresh(DEPS), () => self)).toEqual([])
  })

  test('a dated measurement or status without expires: is asked for one; with it, or a lasting fact, is not', () => {
    const bench = memory(['name: bench-cache-2026-10-31', 'description: the new cache cut 12% of the cost', 'type: project'])
    const [note] = memoryHygieneNotesIn(dirs, `${TEAM}bench-cache-2026-10-31.md`, fresh(bench), () => [])
    expect(note).toContain('reads like a dated measurement or status. Give it `expires: YYYY-MM-DD`')
    const dated = memory(['name: bench-cache-2026-10-31', 'description: the new cache cut 12%', 'type: project', 'expires: 2026-12-31'])
    expect(memoryHygieneNotesIn(dirs, `${TEAM}bench-cache-2026-10-31.md`, fresh(dated), () => [])).toEqual([])
    expect(memoryHygieneNotesIn(dirs, `${TEAM}runtime-deps-review.md`, fresh(DEPS), () => [])).toEqual([])
    const pr = memory(['name: pr-292-review', 'description: PR #292 review, merged', 'type: project'])
    expect(memoryHygieneNotesIn(dirs, `${PRIVATE}pr-292-review.md`, fresh(pr), () => [])).toHaveLength(1)
  })

  test('an index the write leaves over its cap is named with what it loses; one within it is not', () => {
    const line = (n: number) => `- [Note ${n}](note-${n}.md) — ${'a hook that carries far too much of the memory into the index '.repeat(3)}`
    const over = Array.from({ length: 150 }, (_, i) => line(i)).join('\n')
    const [note] = memoryHygieneNotesIn(dirs, `${TEAM}MEMORY.md`, { content: over, isNew: false, indexNote: false }, () => [])
    expect(note).toContain('over its cap (200 lines, 25,000 bytes)')
    expect(note).toMatch(/\d+ entries would load without their hook/)
    // Never delete to make room (team decision memory-hygiene): the forks read this note too
    expect(note).not.toMatch(/retire/i)
    expect(note).toContain('a memory is never deleted to make room')
    expect(memoryHygieneNotesIn(dirs, `${TEAM}MEMORY.md`, { content: line(1), isNew: false, indexNote: false }, () => [])).toEqual([])
  })

  test('a file outside the memory dirs gets none', () => {
    expect(memoryHygieneNotesIn(dirs, '/repo/src/notes.md', fresh(DEPS), () => SAVED)).toEqual([])
  })
})

describe('the write notes through the session dirs', () => {
  const saved = { config: process.env.CLAUDIN_CONFIG_DIR, hygiene: process.env.CLAUDIN_MEMORY_HYGIENE }
  let savedProjectRoot: string
  let root: string
  let teamDir: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'write-notes-'))
    mkdirSync(join(root, 'project', '.git'), { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    savedProjectRoot = getProjectRoot()
    setProjectRoot(join(root, 'project'))
    getPrivateMemPath.cache.clear?.()
    getGlobalMemPath.cache.clear?.()
    teamDir = join(getPrivateMemPath(), 'team')
    mkdirSync(teamDir, { recursive: true })
    writeFileSync(
      join(teamDir, 'notes-sc-14.md'),
      memory(['name: notes-sc-14', 'description: adding a runtime dependency needs a review in the #deps channel first', 'type: project']),
    )
    writeFileSync(join(teamDir, 'MEMORY.md'), '- [Supply chain note 14](notes-sc-14.md)\n')
  })

  afterEach(() => {
    if (saved.hygiene === undefined) delete process.env.CLAUDIN_MEMORY_HYGIENE
    else process.env.CLAUDIN_MEMORY_HYGIENE = saved.hygiene
  })

  afterAll(() => {
    setProjectRoot(savedProjectRoot)
    getPrivateMemPath.cache.clear?.()
    getGlobalMemPath.cache.clear?.()
    if (saved.config === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = saved.config
    rmSync(root, { recursive: true, force: true })
  })

  test('a new memory gets the index note and the near-duplicate note, read from disk', () => {
    const message = notesToAdvice(memoryWriteNotes(join(teamDir, 'runtime-deps-review.md'), fresh(DEPS)))?.message ?? ''
    expect(message).toContain('is not in the team memory index yet')
    expect(message).toContain('reads like a memory already saved: `team:notes-sc-14.md`')
  })

  test('CLAUDIN_MEMORY_HYGIENE=0 leaves the index note alone', () => {
    process.env.CLAUDIN_MEMORY_HYGIENE = '0'
    const message = notesToAdvice(memoryWriteNotes(join(teamDir, 'runtime-deps-review.md'), fresh(DEPS)))?.message ?? ''
    expect(message).toContain('is not in the team memory index yet')
    expect(message).not.toContain('reads like')
  })

  test('a Patch gets one index note and every hygiene note, an index Update included', () => {
    const index = join(teamDir, 'MEMORY.md')
    const longLine = `- [Long](long.md) — ${'detail that belongs in the topic file '.repeat(800)}`
    const patchText = [
      '*** Begin Patch',
      `*** Add File: ${join(teamDir, 'runtime-deps-review.md')}`,
      ...DEPS.trimEnd().split('\n').map(l => `+${l}`),
      `*** Update File: ${index}`,
      '@@',
      ' - [Supply chain note 14](notes-sc-14.md)',
      `+${longLine}`,
      '*** End Patch',
    ].join('\n')
    const message = applyPatchMemoryIndexAdvice({ patchText })?.message ?? ''
    expect(message.match(/is not in the team memory index yet/g)).toHaveLength(1)
    expect(message).toContain('reads like a memory already saved')
    expect(message).toContain('over its cap')
  })
})
