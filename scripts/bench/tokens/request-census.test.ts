import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  callRows,
  discover,
  modelFamily,
  parseArgs,
  renderReport,
  resolveProjectDirs,
  runCensus,
  type Call,
  type Census,
  type ThreadFile,
  type ThreadKind,
} from './request-census.ts'

// ---------------------------------------------------------------------------
// Fixture builders — transcript records as the app writes them
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>

const CWD = '/work/app'
let clock = 0
const stamp = (): string => new Date(Date.UTC(2026, 8, 20, 12) + 1000 * clock++).toISOString()

function prompt(text: string, extra: Rec = {}): Rec {
  return { type: 'user', cwd: CWD, timestamp: stamp(), message: { role: 'user', content: text }, ...extra }
}

function reply(id: string, blocks: Rec[], model = 'claude-opus-5-5'): Rec {
  return { type: 'assistant', cwd: CWD, timestamp: stamp(), message: { id, model, role: 'assistant', content: blocks } }
}

function toolUse(id: string, name: string, input: Rec): Rec {
  return { type: 'tool_use', id, name, input }
}

function results(...rs: { id: string; content: unknown; isError?: boolean }[]): Rec {
  return {
    type: 'user',
    cwd: CWD,
    timestamp: stamp(),
    message: {
      role: 'user',
      content: rs.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
    },
  }
}

type ToolStep = [name: string, input: Rec, result: unknown, isError?: boolean]

/** One response carrying `calls`, then the user record with their results. */
function step(id: string, calls: ToolStep[]): Rec[] {
  const ids = calls.map((_, i) => `${id}_t${i}`)
  return [
    reply(
      id,
      calls.map(([name, input], i) => toolUse(ids[i], name, input)),
    ),
    results(...calls.map(([, , content, isError], i) => ({ id: ids[i], content, isError }))),
  ]
}

function threadFile(kind: ThreadKind, session: string, agentId = '', firstTs = 0): ThreadFile {
  const agentType = kind === 'main' ? 'main' : kind === 'compact' ? 'compact' : 'fork'
  return { path: `/fixtures/${session}/${agentId || 'main'}.jsonl`, kind, session, project: '-work-app', agentType, agentId, firstTs }
}

/** Runs the census over in-memory transcripts; a string entry is written as a raw line. */
function census(...threads: [ThreadFile, (Rec | string)[]][]): Census {
  const raw = new Map(threads.map(([f, recs]) => [f.path, recs.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n']))
  return runCensus(
    threads.map(([f]) => f),
    f => raw.get(f.path) ?? '',
  )
}

const flagsOf = (c: Call): string[] => [...c.flags].sort()

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe('one API call per message.id', () => {
  test('a response streamed over several records is one call, and a repeated tool_use counts once', () => {
    const c = census([
      threadFile('main', 's1'),
      [
        prompt('read both files'),
        reply('msg_1', [{ type: 'thinking', thinking: 'plan' }]),
        reply('msg_1', [{ type: 'text', text: 'Reading both.' }]),
        reply('msg_1', [toolUse('tu_a', 'Read', { file_path: 'src/a.ts' })]),
        reply('msg_1', [toolUse('tu_b', 'Read', { file_path: 'src/b.ts' })]),
        reply('msg_1', [toolUse('tu_b', 'Read', { file_path: 'src/b.ts' })]),
        results({ id: 'tu_a', content: 'A' }, { id: 'tu_b', content: [{ type: 'text', text: 'B' }] }),
        reply('msg_2', [{ type: 'text', text: 'Both read.' }]),
      ],
    ])

    expect(c.main.map(x => x.id)).toEqual(['msg_1', 'msg_2'])
    expect(c.main[0].uses.map(u => [u.name, u.res?.text])).toEqual([
      ['Read', 'A'],
      ['Read', 'B'],
    ])
    expect(c.main.map(x => x.primary)).toEqual(['ORIENT', 'FINAL'])
    expect(c.main[1].prev).toBe(c.main[0])
  })

  test('an unparseable line and a <synthetic> message are skipped and counted, not called', () => {
    const c = census([
      threadFile('main', 's1'),
      [prompt('go'), '{"type":"assistant", truncated', reply('msg_syn', [{ type: 'text', text: 'API error' }], '<synthetic>'), reply('msg_1', [{ type: 'text', text: 'ok' }])],
    ])

    expect(c.parseErrors).toBe(1)
    expect(c.syntheticSkipped).toBe(1)
    expect(c.main.map(x => x.id)).toEqual(['msg_1'])
  })
})

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

describe('user-turn boundaries', () => {
  const c = census([
    threadFile('main', 's1'),
    [
      prompt('first ask'),
      ...step('m1', [['Read', { file_path: 'src/a.ts' }, 'a']]),
      ...step('m2', [['Read', { file_path: 'src/b.ts' }, 'b']]),
      prompt('<system-reminder>context</system-reminder>', { isMeta: true }),
      ...step('m3', [['Grep', { pattern: 'foo' }, 'src/a.ts:1:foo']]),
      prompt('[Request interrupted by user]'),
      ...step('m4', [['Read', { file_path: 'src/c.ts' }, 'c']]),
      prompt('<task-notification>agent done</task-notification>'),
      ...step('m5', [['Read', { file_path: 'src/d.ts' }, 'd']]),
      prompt('second ask'),
      ...step('m6', [['Read', { file_path: 'src/e.ts' }, 'e']]),
      { type: 'system', subtype: 'compact_boundary', timestamp: stamp() },
      ...step('m7', [['Read', { file_path: 'src/f.ts' }, 'f']]),
      prompt('Summary of the conversation so far', { isCompactSummary: true }),
      ...step('m8', [['Read', { file_path: 'src/g.ts' }, 'g']]),
      ...step('m9', [['Bash', { command: 'bun test' }, '[Request interrupted by user for tool use]', true]]),
      ...step('m10', [['Read', { file_path: 'src/h.ts' }, 'h']]),
    ],
  ])

  test('only a human prompt opens a turn', () => {
    expect(c.main.map(x => x.turn)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2])
    expect(c.threads[0].humanPrompts).toBe(2)
    expect([...c.threads[0].turnsWithCalls]).toEqual([1, 2])
  })

  test('a prompt, an interrupt or a compaction breaks the k-1 chain; meta and notifications do not', () => {
    expect(c.main.map(x => x.prev?.id ?? null)).toEqual([null, 'm1', 'm2', null, 'm4', null, null, null, 'm8', null])
  })
})

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

describe('main vs sub-agent, and mirrored history', () => {
  const parent = [
    prompt('fix it'),
    ...step('p1', [['Read', { file_path: 'src/a.ts' }, 'a']]),
    ...step('p2', [['Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, 'ok']]),
  ]
  const fork = [...parent, prompt('Fork directive: check the callers'), ...step('f1', [['Grep', { pattern: 'callers' }, 'none']]), reply('f2', [{ type: 'text', text: 'No callers.' }])]
  const compaction = [...parent, reply('c1', [{ type: 'text', text: 'Summary.' }])]
  // Listed compaction-first, and the sub-agent starting before its parent: the
  // claim order is by kind, then first timestamp — never the input order.
  const c = census([threadFile('compact', 's1', 'agent-acompact-1', 0), compaction], [threadFile('sub', 's1', 'agent-f', 0), fork], [threadFile('main', 's1', '', 5), parent])

  test('the main thread owns its calls; the fork owns only what it added', () => {
    expect(c.main.map(x => x.id)).toEqual(['p1', 'p2'])
    expect(c.sub.map(x => x.id)).toEqual(['f1', 'f2'])
    expect(c.all.map(x => x.id)).toEqual(['p1', 'p2', 'f1', 'f2'])
    expect(c.files).toEqual({ main: 1, sub: 1, compact: 1 })
  })

  test('mirrored calls stay in the fork thread, unowned, and keep its chain', () => {
    const forkThread = c.threads.find(t => t.f.kind === 'sub')
    expect(forkThread?.calls.map(x => [x.id, x.owned])).toEqual([
      ['p1', false],
      ['p2', false],
      ['f1', true],
      ['f2', true],
    ])
    expect(c.sub.map(x => x.prev?.id ?? null)).toEqual([null, 'f1'])
  })

  test('a compaction agent is counted only for the calls nobody else held', () => {
    expect(c.compactionCalls).toBe(1)
    expect(c.threads.map(t => t.f.kind)).toEqual(['main', 'sub'])
  })

  test('calls.jsonl keys a sub-agent row by session/agentId', () => {
    expect(callRows(c).map(r => r.thread)).toEqual(['s1', 's1', 's1/agent-f', 's1/agent-f'])
  })
})

// ---------------------------------------------------------------------------
// Labels and levers
// ---------------------------------------------------------------------------

describe('labels and levers', () => {
  const recs = [
    prompt('make a.ts pass its test'),
    ...step('k0', [['Read', { file_path: 'src/a.ts' }, '1→export const a = 1']]),
    ...step('k1', [['Edit', { file_path: 'src/a.ts', old_string: '1', new_string: '2' }, 'ok']]),
    ...step('k2', [['Edit', { file_path: 'src/a.ts', old_string: '2', new_string: '3' }, 'ok']]),
    ...step('k3', [['Bash', { command: 'bun test src/a.test.ts' }, '3 pass\n0 fail']]),
    ...step('k4', [['Bash', { command: 'bun test src/a.test.ts' }, '2 pass\n1 fail']]),
    ...step('k5', [['Edit', { file_path: 'src/a.ts', old_string: '3', new_string: '4' }, 'ok']]),
    ...step('k6', [['Git', { commands: ['git add src/a.ts', 'git commit -m "fix a"'] }, 'ok']]),
    ...step('k7', [['TaskUpdate', { taskId: '1', status: 'completed' }, 'ok']]),
    ...step('k8', [['ToolSearch', { query: 'select:WebFetch' }, [{ type: 'tool_reference', tool_name: 'WebFetch' }]]]),
    ...step('k9', [['WebFetch', { url: 'https://example.com/spec', prompt: 'read it' }, 'spec']]),
  ]
  const c = census([threadFile('main', 's1'), recs])

  test('primary labels', () => {
    expect(c.main.map(x => x.primary)).toEqual(['ORIENT', 'EDIT', 'EDIT', 'VERIFY', 'VERIFY', 'REACT', 'COMMIT', 'META', 'META', 'ORIENT'])
    expect(c.main[5].reactCause).toBe('test/typecheck/build failure')
  })

  test('lever flags', () => {
    expect(c.main.map(flagsOf)).toEqual([
      [],
      [], // k-1 was a read, not an edit
      ['M-edit'], // a.ts known since k0, before k-1
      ['M-chain', 'M-chain:step'], // a check right after a clean edit
      ['M-chain', 'M-chain:rerun'], // the same check again
      [], // REACT to the failed check
      ['M-chain', 'M-chain:step'], // the commit after a clean edit
      ['M-task'],
      ['M-toolsearch'], // the ToolSearch-only call is the avoidable one…
      ['M-toolsearch(k)'], // …because this call used what it loaded
    ])
  })

  test('a serial read of targets the prompt named is M-batch:fresh; reading one again is reread:paging', () => {
    const b = census([
      threadFile('main', 's2'),
      [
        prompt('compare src/x.ts with src/y.ts'),
        ...step('b0', [['Read', { file_path: 'src/x.ts' }, 'x body']]),
        ...step('b1', [['Read', { file_path: 'src/y.ts' }, 'y body']]),
        ...step('b2', [['Read', { file_path: 'src/x.ts', offset: 40 }, 'x tail']]),
        ...step('b3', [['Read', { file_path: 'src/z.ts' }, 'z body']]),
      ],
    ])
    expect(b.main.map(flagsOf)).toEqual([
      [],
      ['M-batch', 'M-batch:fresh', 'M-batch:fresh:readonly', 'M-batch:strict', 'M-batch:tight'],
      ['M-batch', 'M-batch:reread', 'M-batch:reread:paging', 'M-batch:strict', 'M-batch:tight'],
      [], // z.ts was never named before: not mergeable
    ])
  })

  test('a commit after a failed check is no chain, and an edit on a file first known in k-1 no M-edit', () => {
    const q = census([
      threadFile('main', 's4'),
      [
        prompt('ship it'),
        ...step('q0', [['Read', { file_path: 'src/a.ts' }, 'a']]),
        ...step('q1', [
          ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'ok'],
          ['Typecheck', { path: 'src' }, '✗ 2 errors'],
        ]),
        ...step('q2', [['Git', { commands: ['git add src/a.ts', 'git commit -m "wip"'] }, 'ok']]),
        ...step('q3', [['Edit', { file_path: 'src/c.ts', old_string: 'c', new_string: 'd' }, 'ok']]),
        ...step('q4', [['Edit', { file_path: 'src/c.ts', old_string: 'd', new_string: 'e' }, 'ok']]),
      ],
    ])
    expect(q.main.map(x => x.primary)).toEqual(['ORIENT', 'EDIT', 'COMMIT', 'EDIT', 'EDIT'])
    expect(q.main.map(flagsOf)).toEqual([[], [], [], [], []])
  })

  test('harness refusals are REACT with their cause', () => {
    const r = census([
      threadFile('main', 's3'),
      [
        prompt('find the handler'),
        // A second tool that succeeded, so only the refusal's "Grep is available"
        // can tie r1 to r0 (with every tool failed, any next call is a REACT).
        ...step('r0', [
          ['Bash', { command: 'grep -rn handler src' }, 'Blocked: searching has a dedicated tool, and Grep is available.', true],
          ['Read', { file_path: 'README.md' }, 'readme'],
        ]),
        ...step('r1', [['Grep', { pattern: 'handler', path: 'src' }, 'src/h.ts:3:handler']]),
        ...step('r2', [['Edit', { file_path: 'src/h.ts', old_string: 'a', new_string: 'b' }, 'File has not been read yet. Read it first before writing to it.', true]]),
        ...step('r3', [['Read', { file_path: 'src/h.ts' }, '1→a']]),
      ],
    ])
    expect(r.main.map(x => [x.primary, x.reactCause])).toEqual([
      ['ORIENT', null],
      ['REACT', 'Bash redirect refusal'],
      ['EDIT', null],
      ['REACT', 'read gate'],
    ])
  })

  test('the report tables carry the counts', () => {
    const report = renderReport(c, { since: '2026-09-14', projects: ['-work-app'], dirsWalked: 1, excluded: [] })
    expect(report).toContain('| main | 1 sessions | 1 (of 1 human prompts) | 10 | 10.0 |')
    expect(report).toContain('| M-chain | 3 | 30.0% | 0 | - | 3 | 30.0% |')
    expect(report).toContain('| **core union: M-chain:step + M-toolsearch + M-batch:fresh + M-edit + M-task** | 5 | 50.0% | 0 | - | 5 | 50.0% |')
    // family | calls | 1-tool share | M-chain:step | fresh | reread | M-edit | M-task | REACT harness | core | core+reread+harness
    expect(report).toContain('| opus-5.5 | 10 | 100.0% | 20.0% | 0.0% | 0.0% | 10.0% | 10.0% | 0.0% | 50.0% | 50.0% |')
  })

  test('calls.jsonl rows', () => {
    const k5 = callRows(c)[5]
    expect(k5).toMatchObject({ thread: 's1', kind: 'main', seq: 5, turn: 1, primary: 'REACT', base: 'EDIT', tools: ['Edit'], brief: ['Edit(src/a.ts)'], prevSeq: 4 })
  })
})

// ---------------------------------------------------------------------------
// Model families
// ---------------------------------------------------------------------------

describe('modelFamily', () => {
  const cases: [string, string][] = [
    ['claude-opus-5-5', 'opus-5.5'],
    ['claude-opus-5', 'opus-5'],
    ['claude-fable-5-1', 'fable-5.1'],
    ['claude-opus-4-5-20251101', 'opus-4.5'],
    ['claude-sonnet-4-20250514', 'sonnet-4'],
    ['qwen/qwen3.8-max-0902', 'qwen'],
    ['z-ai/glm-5.3-flash', 'glm'],
    ['moonshotai/kimi-k3', 'kimi'],
    ['gpt-5', 'gpt-5'],
  ]
  for (const [model, family] of cases) {
    test(`${model} → ${family}`, () => {
      expect(modelFamily(model)).toBe(family)
    })
  }
})

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('reads every flag, lists split on commas', () => {
    expect(parseArgs(['--since=2026-09-14', '--projects=a,b', '--exclude-session=x,y', '--out=/tmp/o'])).toEqual({
      since: '2026-09-14',
      projects: ['a', 'b'],
      exclude: ['x', 'y'],
      out: '/tmp/o',
    })
  })

  test('--since is required and must be a date', () => {
    expect(() => parseArgs([])).toThrow('--since')
    expect(() => parseArgs(['--since=09-14'])).toThrow('--since')
  })

  test('an unknown flag is refused rather than ignored', () => {
    expect(() => parseArgs(['--since=2026-09-14', '--exclude=abc'])).toThrow('unknown argument: --exclude=abc')
  })
})

// ---------------------------------------------------------------------------
// Discovery, on disk
// ---------------------------------------------------------------------------

describe('discover', () => {
  let root = ''
  const sinceMs = Date.parse('2026-09-14T00:00:00')
  const recent = new Date('2026-09-20T12:00:00')
  const old = new Date('2026-09-01T12:00:00')

  const put = (rel: string, body: string, mtime = recent): void => {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
    utimesSync(path, mtime, mtime)
  }
  const transcript = (...recs: Rec[]): string => recs.map(r => JSON.stringify(r)).join('\n') + '\n'

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'request-census-test-'))
    const app = '-home-u-projects-app'
    put(`${app}/s1.jsonl`, transcript({ type: 'summary' }, prompt('hi'), reply('a1', [{ type: 'text', text: 'hello' }])))
    put(`${app}/s1/subagents/agent-a1.jsonl`, transcript(prompt('sub task'), reply('a2', [{ type: 'text', text: 'done' }])))
    put(`${app}/s1/subagents/agent-a1.meta.json`, JSON.stringify({ agentType: 'Code' }))
    put(`${app}/s1/subagents/agent-a2.jsonl`, transcript(prompt('fork task')))
    put(`${app}/s1/subagents/agent-acompact-9.jsonl`, transcript(prompt('compact')))
    put(`${app}/s1/tool-results/x.jsonl`, transcript(prompt('not a thread')))
    put(`${app}/s-old.jsonl`, transcript(prompt('old')), old)
    put(`${app}/s-excluded.jsonl`, transcript(prompt('excluded')))
    put(`${app}/s-excluded/subagents/agent-a3.jsonl`, transcript(prompt('excluded sub')))
    put('-tmp-bench-abc/s9.jsonl', transcript(prompt('bench')))
    put('-tmp/s8.jsonl', transcript(prompt('bench')))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('the default project set skips the /tmp dirs; a named one is taken as given', () => {
    expect(resolveProjectDirs(root, [])).toEqual([join(root, '-home-u-projects-app')])
    expect(resolveProjectDirs(root, ['-tmp-bench-abc'])).toEqual([join(root, '-tmp-bench-abc')])
    expect(() => resolveProjectDirs(root, ['-missing'])).toThrow('no such project dir')
  })

  test('main threads, sub-agents and compaction files, by layout, mtime and exclusion', () => {
    const files = discover(resolveProjectDirs(root, []), sinceMs, new Set(['s-excluded']))
    const seen = files.map(f => [f.kind, f.session, f.agentId, f.agentType]).sort()
    expect(seen).toEqual([
      ['compact', 's1', 'agent-acompact-9', 'compact'],
      ['main', 's1', '', 'main'],
      ['sub', 's1', 'agent-a1', 'Code'],
      ['sub', 's1', 'agent-a2', 'unknown'],
    ])
    const main = files.find(f => f.kind === 'main')
    // the first record WITH a timestamp, not the first line
    expect(main?.firstTs).toBe(Date.parse(String(JSON.parse(readFileSync(main?.path ?? '', 'utf8').split('\n')[1] ?? '{}').timestamp)))
  })

  test('the discovered files run end to end', () => {
    const files = discover(resolveProjectDirs(root, []), sinceMs, new Set(['s-excluded']))
    const c = runCensus(files, f => readFileSync(f.path, 'utf8'))
    expect(c.main.map(x => x.id)).toEqual(['a1'])
    expect(c.sub.map(x => [x.id, x.t.f.agentType])).toEqual([['a2', 'Code']])
    expect(c.files).toEqual({ main: 1, sub: 2, compact: 1 })
  })
})
