import { describe, expect, test } from 'bun:test'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'
import { memoryHygieneNotesIn, type MemoryWrite } from 'src/memory/memdir/memoryFormatGuard.js'

const PRIVATE = '/repo/.claudin/memory/'
const TEAM = '/repo/.claudin/memory/team/'
const dirs = testMemoryDirs({ global: '/home/u/.claudin/memory/', private: PRIVATE, team: TEAM })
const fresh = (content: string): MemoryWrite => ({ content, isNew: true, indexNote: true })
const memory = (lines: string[]) => `---\n${lines.join('\n')}\n---\n\nBody.\n`

// Found by the 2026-10-31 review round: 58 of this repo's 62 team decisions
// matched the detector, so every new decision was asked to expire.
describe('the snapshot note', () => {
  // Frontmatter shaped like this repo's own team decisions (58 of 62 match the detector).
  test('a durable decision that only carries the day it was taken is not asked to expire', () => {
    const decision = memory([
      'name: batch-read-default-on',
      'description: 2026-09-24 — the batch Read (file_paths, symbol lists) is ON by default; CLAUDIN_READ_MULTI=0 is the killswitch',
      'type: project',
    ])
    expect(memoryHygieneNotesIn(dirs, `${TEAM}decisions/batch-read-default-on.md`, fresh(decision), () => [])).toEqual([])
  })

  test('a memory about a status pill is not a status snapshot', () => {
    const doc = memory([
      'name: pr-status-gitlab-gitea',
      'description: How the prompt-input PR/MR status pill resolves host to CLI, and the accepted limitations for GitLab/Gitea',
      'type: project',
    ])
    expect(memoryHygieneNotesIn(dirs, `${TEAM}decisions/pr-status-gitlab-gitea.md`, fresh(doc), () => [])).toEqual([])
  })

  test('at the team root too, a date alone or a bare status is not a snapshot', () => {
    const rotation = memory(['name: oncall-rotation', 'description: 2026-09-24 — the on-call rotation moved to Mondays; status page owners unchanged', 'type: project'])
    expect(memoryHygieneNotesIn(dirs, `${TEAM}oncall-rotation.md`, fresh(rotation), () => [])).toEqual([])
  })

  test('a decision that cites a bench is filed to last; the same words at the team root are a snapshot', () => {
    const lines = ['name: cache-ttl-1h', 'description: keep the 1h cache TTL — the bench showed it 12% cheaper', 'type: project']
    expect(memoryHygieneNotesIn(dirs, `${TEAM}decisions/cache-ttl-1h.md`, fresh(memory(lines)), () => [])).toEqual([])
    expect(memoryHygieneNotesIn(dirs, `${TEAM}cache-ttl-1h.md`, fresh(memory(lines)), () => [])).toEqual([
      expect.stringContaining('reads like a dated measurement or status'),
    ])
  })
})
