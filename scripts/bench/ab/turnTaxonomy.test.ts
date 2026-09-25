import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseJsonl } from './cliUsage'
import {
  analyzeBash,
  analyzeSession,
  classifySession,
  loadSession,
  mechanismOf,
  parseShell,
  renderListing,
  renderReport,
  repsOf,
  sessionFromEntries,
  stampsMatching,
  summarizeArm,
  workspaceOf,
} from './turnTaxonomy'

const WS = '/tmp/session-cache-ab/20260101-000000/arm-r1'
const dirs: string[] = []
/** A pristine project of four files, as the `.tpl` tree the classifier reads. */
let fixture = ''

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'turn-taxonomy-fixture-'))
  dirs.push(fixture)
  for (const f of ['src/a.ts', 'src/b.ts', 'test/a.test.ts', 'README.md']) {
    mkdirSync(dirname(join(fixture, f)), { recursive: true })
    writeFileSync(join(fixture, `${f}.tpl`), `// ${f}\n`)
  }
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type Entry = Record<string, unknown>
type Step = { name: string; input: Record<string, unknown>; result?: string; isError?: boolean; structured?: unknown }

const jsonl = (...entries: Entry[]): string => entries.map(e => JSON.stringify(e)).join('\n') + '\n'
const prompt = (text: string, timestamp?: string): Entry => ({ type: 'user', timestamp, message: { role: 'user', content: text } })
const text = (id: string, body: string, timestamp?: string): Entry => ({ type: 'assistant', timestamp, message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: body }] } })

/** One API response: its assistant entry with every tool_use, then one tool_result entry per call. */
function response(id: string, steps: Step[]): Entry[] {
  const content = steps.map((s, i) => ({ type: 'tool_use', id: `${id}.${i}`, name: s.name, input: s.input }))
  return [
    { type: 'assistant', message: { id, model: 'claude-opus-5-5', content, usage: { input_tokens: 1, output_tokens: 1 } } },
    ...steps.map((s, i) => ({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `${id}.${i}`, content: s.result ?? 'ok', is_error: s.isError === true }] },
      toolUseResult: s.structured,
    })),
  ]
}

/** A session read from inline JSONL, the way a transcript file is. */
const sessionOf = (...entries: Entry[]) => sessionFromEntries(parseJsonl(jsonl(...entries)), WS)
const classify = (...entries: Entry[]) => classifySession(sessionOf(...entries), fixture)

const patch = (...files: string[]) => ({ patchText: ['*** Begin Patch', ...files.flatMap(f => [`*** Update File: ${f}`, '@@', '-a', '+b']), '*** End Patch'].join('\n') })
const read = (rel: string): Step => ({ name: 'Read', input: { file_path: `${WS}/${rel}` } })
const runTests = (exitCode: number, result = 'ok'): Step => ({ name: 'RunTests', input: {}, result, structured: { exitCode } })
const commit = (msg: string, extra: Partial<Step> = {}): Step => ({ name: 'Git', input: { commands: ['git add src/a.ts', `git commit -m "${msg}"`] }, ...extra })
const SKIPPED = '<tool_use_error>Skipped: RunTests failed earlier in this response, so this Git call did not run. Re-send it if it still applies.</tool_use_error>'

describe('sessionFromEntries', () => {
  test('groups the entries of one response by message.id, keeping the longest text and the final usage', () => {
    const s = sessionOf(
      prompt('go'),
      { type: 'assistant', message: { id: 'm1', model: 'm', content: [{ type: 'text', text: 'Let me' }], usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'assistant', message: { id: 'm1', model: 'm', content: [{ type: 'text', text: 'Let me look.' }], usage: { input_tokens: 5, output_tokens: 9 } } },
      { type: 'assistant', message: { id: 'm1', model: 'm', content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: `${WS}/src/a.ts` } }], usage: { output_tokens: 12 } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'export const a = 1' }] }] } },
      { type: 'assistant', message: { id: 'm2', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
      { type: 'assistant', isSidechain: true, message: { id: 'm3', model: 'm', content: [{ type: 'text', text: 'a sub-agent' }] } },
      text('m4', 'Done.'),
    )
    expect(s.calls.map(c => [c.k, c.id])).toEqual([
      [1, 'm1'],
      [2, 'm4'],
    ])
    expect(s.calls[0]!.texts).toEqual(['Let me look.'])
    expect(s.calls[0]!.usage).toMatchObject({ in: 5, out: 12 })
    expect(s.calls[0]!.tools).toMatchObject([{ name: 'Read', result: 'export const a = 1', hasResult: true, isError: false }])
  })

  test('starts phase 2 at the second human prompt; harness text is not a prompt', () => {
    const s = sessionOf(prompt('first'), text('m1', 'one'), prompt('<system-reminder>ignore</system-reminder>'), text('m2', 'two'), prompt('second'), text('m3', 'three'))
    expect(s.prompts).toEqual(['first', 'second'])
    expect(s.calls.map(c => c.phase)).toEqual([1, 1, 2])
  })
})

describe('classifySession', () => {
  test('labels each request by what it did', () => {
    const infos = classify(
      prompt('go'),
      ...response('r1', [read('src/a.ts')]),
      ...response('r2', [{ name: 'ToolSearch', input: { query: 'select:RunTests' } }]),
      ...response('r3', [{ name: 'Patch', input: patch('src/a.ts') }]),
      ...response('r4', [runTests(0)]),
      ...response('r5', [commit('x')]),
      text('r6', 'All done.'),
    )
    expect(infos.map(i => i.label)).toEqual(['ORIENT', 'META', 'EDIT', 'VERIFY', 'COMMIT', 'FINAL'])
  })

  test('M-chain: a check or commit right after a clean edit or check, not after failing tests', () => {
    const chained = classify(
      prompt('go'),
      ...response('r1', [{ name: 'Patch', input: patch('src/a.ts') }]),
      ...response('r2', [{ name: 'Bash', input: { command: 'bun test' }, result: ' 3 pass\n 0 fail' }]),
      ...response('r3', [commit('x')]),
    )
    expect(chained.map(i => i.levers)).toEqual([[], ['M-chain'], ['M-chain']])

    const afterFailure = classify(
      prompt('go'),
      ...response('r1', [{ name: 'Bash', input: { command: 'bun test' }, result: '(fail) a > b\n 1 fail' }]),
      ...response('r2', [{ name: 'Bash', input: { command: 'bun test' } }]),
    )
    expect(afterFailure[1]).toMatchObject({ label: 'VERIFY', levers: [], softReact: true })
  })

  test('REACT: the request after a hard error, when it touches what failed', () => {
    const readGate = { name: 'Patch', input: patch('src/a.ts'), isError: true, result: '<tool_use_error>Patch: src/a.ts has not been read yet. Read it first before writing to it.</tool_use_error>' }
    const reacted = classify(prompt('go'), ...response('r1', [readGate]), ...response('r2', [read('src/a.ts')]))
    expect(reacted[1]).toMatchObject({ label: 'REACT', base: 'ORIENT', reactCat: 'read-gate' })

    const unrelated = classify(prompt('go'), ...response('r1', [readGate]), ...response('r2', [read('src/b.ts')]))
    expect(unrelated[1]).toMatchObject({ label: 'ORIENT', reactCat: null })
  })
})

describe('mechanism metrics', () => {
  test('chainResponses: an edit and, later in the same response, a check', () => {
    const s = sessionOf(
      prompt('go'),
      ...response('r1', [{ name: 'Patch', input: patch('src/a.ts') }, runTests(0)]),
      ...response('r2', [{ name: 'Bash', input: { command: 'bun test' } }, { name: 'Patch', input: patch('src/b.ts') }]),
      ...response('r3', [{ name: 'Patch', input: patch('src/a.ts') }, read('src/b.ts')]),
    )
    expect(classifySession(s, fixture).map(ci => mechanismOf([ci]).chainResponses)).toEqual([1, 0, 0])
    expect(analyzeSession(s, fixture).row.chainResponses).toBe(1)
  })

  test('gitReadWithCheck: a check and a read-only git call, Git tool or Bash, in one response', () => {
    const infos = classify(
      prompt('go'),
      ...response('r1', [runTests(0), { name: 'Git', input: { commands: ['git status', 'git diff --stat', 'git log --oneline -3'] } }]),
      ...response('r2', [{ name: 'Bash', input: { command: 'bun test' } }, { name: 'Bash', input: { command: 'git log --oneline | head -3' } }]),
      ...response('r3', [runTests(0), commit('x')]),
      ...response('r4', [{ name: 'Git', input: { commands: ['git status'] } }]),
      // one call that checks and reads git: not a read-only git call beside a check
      ...response('r5', [{ name: 'Bash', input: { command: 'bun test && git status' } }]),
    )
    expect(infos.map(ci => mechanismOf([ci]).gitReadWithCheck)).toEqual([1, 1, 0, 0, 0])
  })

  test('multiKindPatch: an applied patch mixing source and tests, and those that also carry a doc', () => {
    const infos = classify(
      prompt('go'),
      ...response('r1', [{ name: 'Patch', input: patch('src/a.ts', 'test/a.test.ts', 'README.md') }]),
      ...response('r2', [{ name: 'apply_patch', input: { input: patch('src/b.ts', 'test/a.test.ts').patchText } }]),
      ...response('r3', [{ name: 'Patch', input: patch('src/a.ts', 'test/a.test.ts'), isError: true, result: '<tool_use_error>Patch found 2 problems</tool_use_error>' }]),
      ...response('r4', [{ name: 'Patch', input: patch('src/a.ts', 'src/b.ts', 'README.md') }]),
    )
    expect(mechanismOf(infos)).toMatchObject({ multiKindPatch: 2, multiKindPatchDoc: 1 })
  })

  test('skipped: the tool_results the same-response guard refused', () => {
    const infos = classify(
      prompt('go'),
      ...response('r1', [runTests(1), { name: 'Bash', input: { command: 'bun run build' }, isError: true, result: SKIPPED.replace('Git', 'Bash') }, commit('x', { isError: true, result: SKIPPED })]),
    )
    expect(mechanismOf(infos)).toMatchObject({ skipped: 2, commitAfterFailure: 0 })
  })

  test('commitAfterFailure: a commit that ran after an earlier call of its response failed', () => {
    const infos = classify(
      prompt('go'),
      // counted: RunTests exits 1, which never sets is_error
      ...response('r1', [runTests(1, '✗ bun · 2 passed, 1 failed (3 total)'), commit('r1')]),
      // counted: a stripped `| tail` whose base failed, disclosed only on the filter marker
      ...response('r2', [
        { name: 'Bash', input: { command: 'bun test 2>&1 | tail -5' }, result: '<bash-output-filtered original="bun test 2&gt;&amp;1 | tail -5" actual="bun test 2&gt;&amp;1" exit="1" lines="5/9" reduction="40%">Ran 9 tests</bash-output-filtered>' },
        { name: 'Bash', input: { command: 'git commit -am "r2"' } },
      ]),
      // counted: failing tests in the output of a pipeline that exited 0
      ...response('r3', [{ name: 'Bash', input: { command: 'bun test 2>&1 | tail -3' }, result: ' 8 pass\n 1 fail' }, { name: 'Bash', input: { command: 'git commit -am "r3"' } }]),
      // counted: an error result
      ...response('r4', [{ name: 'Bash', input: { command: 'bun test' }, isError: true, result: 'Exit code 1' }, commit('r4')]),
      // not counted: the commit came first
      ...response('r5', [commit('r5'), runTests(1)]),
      // not counted: the guard skipped it
      ...response('r6', [runTests(1), commit('r6', { isError: true, result: SKIPPED })]),
      // not counted: its own `git add` failed, so the Git tool never ran the commit
      ...response('r7', [runTests(1), commit('r7', { isError: true, result: '$ git add src/a.ts\nfatal: pathspec', structured: { outcomes: [{ command: 'git add src/a.ts', exitCode: 128 }], notRun: ['git commit -m "r7"'] } })]),
      // not counted: a revert check fails on purpose, in one Bash call…
      ...response('r8', [
        {
          name: 'Bash',
          input: { command: 'git stash -q && bun test 2>&1 | tail -3; git stash pop -q' },
          result: '<bash-output-filtered original="git stash -q &amp;&amp; bun test 2&gt;&amp;1 | tail -3; git stash pop -q" actual="…" exit="1" lines="3/9" reduction="60%"> 1 fail</bash-output-filtered>',
        },
        commit('r8'),
      ]),
      // …or as an Edit and the Edit undoing it around a test run
      ...response('r9', [
        { name: 'Edit', input: { file_path: `${WS}/src/a.ts`, old_string: 'x', new_string: 'y' } },
        { name: 'Bash', input: { command: 'bun test' }, result: '(fail) a > b\n 1 fail' },
        { name: 'Edit', input: { file_path: `${WS}/src/a.ts`, old_string: 'y', new_string: 'x' } },
        commit('r9'),
      ]),
      // not counted: everything before it passed
      ...response('r10', [runTests(0), commit('r10')]),
    )
    expect(infos.map(ci => mechanismOf([ci]).commitAfterFailure)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0])
  })

  test('gitOnlyCalls: responses of git calls only, a head/tail piped after git allowed, none that edits', () => {
    const bash = (command: string): Step => ({ name: 'Bash', input: { command } })
    const infos = classify(
      prompt('go'),
      ...response('r1', [{ name: 'Git', input: { commands: ['git status', 'git diff --stat', 'git log --oneline -3'] } }]),
      ...response('r2', [bash("git add -A && git commit -q -F - <<'EOF'\nfeat: x\n\nbody | head\nEOF\ngit log --oneline | head -2; git status --short")]),
      ...response('r3', [bash('git status'), commit('x')]),
      // not git-only: an edit beside it, a head reading a file, a cd, a meta call
      ...response('r4', [{ name: 'Edit', input: { file_path: `${WS}/README.md`, old_string: 'a', new_string: 'b' } }, commit('x')]),
      ...response('r5', [bash('git status && head -3 README.md')]),
      ...response('r6', [bash('cd /tmp && git status')]),
      ...response('r7', [{ name: 'ToolSearch', input: { query: 'select:Git' } }, { name: 'Git', input: { commands: ['git status'] } }]),
      // not the commit protocol: git undoing a revert check edits the tree
      ...response('r8', [bash('git restore --staged src/a.ts && git status --short | head -3 && git stash list')]),
      ...response('r9', [{ name: 'Git', input: { commands: ['git checkout -- src/a.ts'] } }]),
      text('r10', 'Committed.'),
    )
    expect(infos.map(ci => mechanismOf([ci]).gitOnlyCalls)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0])
  })

  test('globReads: Read calls with a glob in file_paths, and the files their results showed', () => {
    const shown = (...rels: string[]) => rels.map(rel => `==> ${rel} <==\n     1→// ${rel}\n     2→==> not a header <==`).join('\n\n')
    const readAll = (paths: string[], result: string, extra: Partial<Step> = {}): Step => ({
      name: 'Read',
      input: { file_paths: paths.map(p => `${WS}/${p}`) },
      result,
      ...extra,
    })
    const infos = classify(
      prompt('go'),
      ...response('r1', [readAll(['src/*.ts'], shown('src/a.ts', 'src/b.ts'))]),
      // a glob among literal paths, with a file past the budget named but not shown; a brace glob beside it
      ...response('r2', [
        readAll(['README.md', 'test/*.test.ts'], `${shown('README.md', 'test/a.test.ts')}\n\nNot shown — over the 25k tokens one Read returns: test/b.test.ts. Read them in another call.`),
        readAll(['src/{a,b}.ts'], shown('src/a.ts', 'src/b.ts')),
      ]),
      // refused: a glob Read all the same, showing nothing
      ...response('r3', [readAll(['src/?.ts', 'test/[ab].test.ts'], '<tool_use_error>Too many files</tool_use_error>', { isError: true })]),
      // not a glob Read: literal paths — an escaped `[` included — a glob as file_path, the Glob tool
      ...response('r4', [
        readAll(['src/a.ts', 'src/b.ts', 'src/\\[id].ts'], shown('src/a.ts', 'src/b.ts')),
        { name: 'Read', input: { file_path: `${WS}/src/*.ts` } },
        { name: 'Glob', input: { pattern: 'src/*.ts' } },
      ]),
    )
    expect(infos.map(ci => mechanismOf([ci]))).toMatchObject([
      { globReads: 1, globReadFiles: 2 },
      { globReads: 2, globReadFiles: 4 },
      { globReads: 1, globReadFiles: 0 },
      { globReads: 0, globReadFiles: 0 },
    ])
  })

  test('firstEditTurn: phase 1 responses before its first edit, as resume counts them in phase 2', () => {
    const s = sessionOf(
      prompt('go'),
      ...response('r1', [read('src/a.ts')]),
      ...response('r2', [runTests(0)]),
      // a refused patch is the first edit all the same
      ...response('r3', [{ name: 'Patch', input: patch('src/a.ts'), isError: true, result: '<tool_use_error>Patch found 1 problem</tool_use_error>' }]),
      ...response('r4', [{ name: 'Patch', input: patch('src/a.ts') }]),
      text('r5', 'Done.'),
      prompt('more'),
      ...response('r6', [read('src/b.ts')]),
      ...response('r7', [{ name: 'Bash', input: { command: "sed -i 's/a/b/' src/b.ts" } }]),
      text('r8', 'Done.'),
    )
    expect(analyzeSession(s, fixture).row).toMatchObject({ firstEditTurn: 2, resume: 1 })
    // a phase that never edits spends all its responses
    const idle = sessionOf(prompt('go'), ...response('r1', [read('src/a.ts')]), text('r2', 'Nothing to change.'))
    expect(analyzeSession(idle, fixture).row).toMatchObject({ firstEditTurn: 2, resume: 0 })
  })
})

describe('parseShell', () => {
  test('attaches a heredoc body, untokenized, to the segment that opened it', () => {
    const cmd = "cat > src/x.ts <<'EOF'\nexport const x = 'a | b; c && d'\n  $notExpanded\nEOF\nbun test"
    expect(parseShell(cmd)).toEqual([
      { words: ['cat'], redirects: [{ fd: '', op: '>', target: 'src/x.ts' }], heredoc: "export const x = 'a | b; c && d'\n  $notExpanded", opBefore: null },
      { words: ['bun', 'test'], redirects: [], heredoc: null, opBefore: ';' },
    ])
    expect(analyzeBash(cmd, WS, new Set(['src/a.ts']))).toMatchObject({ mutates: true, editTargets: ['src/x.ts'], created: ['src/x.ts'], verifies: true, heads: ['cat', 'bun test'] })
  })

  test('`<<-` matches the delimiter past leading tabs, and a redirect after the operator still lands', () => {
    const [heredoc, next] = parseShell('cat <<-END > out.txt\n\tbody\n\tEND\necho done')
    expect(heredoc).toMatchObject({ words: ['cat'], redirects: [{ op: '>', target: 'out.txt' }], heredoc: '\tbody' })
    expect(next!.words).toEqual(['echo', 'done'])
  })
})

describe('the session-cache A/B layout', () => {
  const stamp = '20260101-000000'
  const arm = 'chain+onepatch'
  let home = ''
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'turn-taxonomy-home-'))
    dirs.push(home)
    const root = join(home, '.claudin', 'projects')
    for (const rep of [1, 2, 10]) mkdirSync(join(root, `-tmp-session-cache-ab-${stamp}-chain-onepatch-r${rep}`), { recursive: true })
    mkdirSync(join(root, `-tmp-session-cache-ab-${stamp}-chain-onepatch-x-r1`), { recursive: true })
    mkdirSync(join(home, '.claude', 'projects', `-tmp-session-cache-ab-${stamp}-claude-r1`), { recursive: true })
  })

  test('finds the reps of an arm under its sanitized project-dir name, and a run by its stamp ending', () => {
    expect(repsOf(stamp, arm, home)).toEqual([1, 2, 10])
    expect(repsOf(stamp, 'claude', home)).toEqual([1])
    expect(stampsMatching('000000', home)).toEqual([stamp])
    expect(stampsMatching('231111', home)).toEqual([])
  })

  test('joins the transcript files of one session by first timestamp and counts its sub-agent calls', () => {
    const dir = join(home, '.claudin', 'projects', `-tmp-session-cache-ab-${stamp}-chain-onepatch-r1`)
    // The resumed phase sorts first by name; the timestamps put it second.
    writeFileSync(join(dir, 'a-resumed.jsonl'), jsonl(prompt('second', '2026-01-01T00:10:00Z'), text('m2', 'two')))
    writeFileSync(join(dir, 'b-first.jsonl'), jsonl(prompt('first', '2026-01-01T00:00:00Z'), text('m1', 'one')))
    mkdirSync(join(dir, 'b-first', 'subagents'), { recursive: true })
    const sub = jsonl(text('s1', 'a'), text('s1', 'a b'), text('s2', 'c'), { type: 'assistant', message: { id: 's3', model: '<synthetic>', content: [] } })
    writeFileSync(join(dir, 'b-first', 'subagents', 'agent-1.jsonl'), sub)

    const s = loadSession(stamp, arm, 1, home)!
    expect(s.ws).toBe(workspaceOf(stamp, arm, 1))
    expect(s.ws).toBe('/tmp/session-cache-ab/20260101-000000/chain+onepatch-r1')
    expect(s.calls.map(c => [c.id, c.phase])).toEqual([
      ['m1', 1],
      ['m2', 2],
    ])
    expect(s.subagentCalls).toBe(2)
    expect(loadSession(stamp, arm, 3, home)).toBeNull()
  })
})

describe('renderReport', () => {
  test('gives each mechanism metric as median [min–max], the sessions with at least one and the mean', () => {
    const session = (chainResponses: number, reactCats: [string, number][]) => ({
      infos: [],
      row: { total: 1, chainResponses, gitOnlyCalls: chainResponses > 0 ? 2 : 0, firstEditTurn: chainResponses + 3 },
      reactCats: new Map(reactCats),
    })
    const arm = summarizeArm('x', [session(1, [['read-gate', 1]]), session(0, [['string-not-found', 2], ['read-gate', 1]]), session(3, [])])
    expect([...arm.reactCats]).toEqual([
      ['read-gate', 2],
      ['string-not-found', 2],
    ])
    const lines = renderReport('run1', [arm]).split('\n')
    const row = (metric: string, cell: string) => metric.padEnd(22) + ' ' + cell.padEnd(24)
    expect(lines.find(l => l.startsWith('chainResponses'))).toBe(row('chainResponses', '1 [0–3] · 2/3 · 1.3'))
    expect(lines.find(l => l.startsWith('commitAfterFailure'))).toBe(row('commitAfterFailure', '0 · 0/3 · 0.0'))
    expect(lines.find(l => l.startsWith('gitOnlyCalls'))).toBe(row('gitOnlyCalls', '2 [0–2] · 2/3 · 1.3'))
    expect(lines.find(l => l.startsWith('globReadFiles'))).toBe(row('globReadFiles', '0 · 0/3 · 0.0'))
    expect(lines.find(l => l.startsWith('firstEditTurn'))).toBe(row('firstEditTurn', '4 [3–6] · 3/3 · 4.3'))
  })
})

describe('renderListing', () => {
  test('tags git-only responses, glob Reads with the files they showed, and each phase’s first edit', () => {
    const infos = classify(
      prompt('go'),
      ...response('r1', [{ name: 'Read', input: { file_paths: [`${WS}/src/*.ts`] }, result: '==> src/a.ts <==\n     1→a\n\n==> src/b.ts <==\n     1→b' }]),
      ...response('r2', [{ name: 'Patch', input: patch('src/a.ts') }]),
      ...response('r3', [{ name: 'Patch', input: patch('src/b.ts') }]),
      text('r4', 'Done.'),
      prompt('commit it'),
      ...response('r5', [{ name: 'Git', input: { commands: ['git status', 'git diff'] } }]),
      ...response('r6', [{ name: 'Edit', input: { file_path: `${WS}/README.md`, old_string: 'a', new_string: 'b' } }]),
      ...response('r7', [commit('x')]),
    )
    const tagsOf = (k: number) => renderListing('run arm r1', infos).split('\n').find(l => l.startsWith(`${String(k).padStart(2)} p`)) ?? ''
    expect(tagsOf(1)).toContain(' glob-read:2 ')
    expect(tagsOf(2)).toContain(' first-edit ')
    expect(tagsOf(3)).not.toContain('first-edit')
    expect(tagsOf(5)).toContain(' git-only ')
    expect(tagsOf(6)).toContain(' first-edit ')
    expect(tagsOf(7)).toContain(' git-only ')
    expect([1, 2, 3, 6].map(k => tagsOf(k).includes('git-only'))).toEqual([false, false, false, false])
  })
})
