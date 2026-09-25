import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  analyzeSession,
  bashInfo,
  catReadsOf,
  CENSUS_ROWS,
  claudinPartsOf,
  editsOnNeverRead,
  isCatReadMiss,
  isGlobReadCommand,
  parseArgs,
  phaseArgs,
  readsOfShownFiles,
  readTargetsOf,
  requestCensus,
  shownWholeFiles,
  turnsBeforeFirstEdit,
} from './session-cache-ab.ts'
import type { KindedRequest } from './wire-proxy.ts'

// The mechanism rows are what the cat-as-read and batch-Read A/B arms are
// judged on, so each counter is run against synthetic calls here, negative
// cases included, rather than trusted on a recorded run.

type Call = Parameters<typeof bashInfo>[0]

const ws = mkdtempSync(join(tmpdir(), 'session-cache-ab-'))
for (const rel of ['README.md', 'src/a.ts', 'src/b.ts', 'src/c.json']) {
  mkdirSync(dirname(join(ws, rel)), { recursive: true })
  writeFileSync(join(ws, rel), `${rel}\n`)
}
afterAll(() => rmSync(ws, { recursive: true, force: true }))

let lastTurn = 0

/** A call in its own API call unless `turn` says otherwise. */
function call(name: string, input: Record<string, unknown>, extra: Partial<Call> = {}): Call {
  return { turn: ++lastTurn, phase: 1, name, input, chars: 0, isError: false, refused: false, ...extra }
}

function bash(command: string, text = 'output', extra: Partial<Call> = {}): Call {
  return call('Bash', { command }, { text, chars: text.length, ...extra })
}

const at = (rel: string) => join(ws, rel)
const words = (command: string) => catReadsOf(command).map(w => (w.glob ? `glob:${w.text}` : w.text))

const COUNT_AS_READ_2 =
  '(2 files printed whole — they count as read: Edit, Patch and Write accept them without a Read.)'
const COUNT_AS_READ_1 = '(1 file printed whole — it counts as read: Edit, Patch and Write accept it without a Read.)'

describe('catReadsOf — the files a command prints whole', () => {
  test('the cats of a chain, a glob flagged as one', () => {
    expect(words('git ls-files && cat README.md package.json && cat src/*.ts')).toEqual([
      'README.md',
      'package.json',
      'glob:src/*.ts',
    ])
  })

  test("a for loop's words stand for its variable, quoted or not", () => {
    expect(words('for f in src/a.ts src/*.json; do echo "=== $f"; cat -n "$f"; done')).toEqual([
      'src/a.ts',
      'glob:src/*.json',
    ])
  })

  test('a cat piped onward, or inside a loop piped at its done, names nothing', () => {
    expect(words('cat a | head')).toEqual([])
    expect(words('for f in a b; do cat $f; done | head -50')).toEqual([])
    expect(words('cat a; bun test | tail -5')).toEqual(['a'])
  })

  test('an output redirect names nothing, except 2>/dev/null', () => {
    expect(words('cat a > b')).toEqual([])
    expect(words('cat a; bun test 2>&1 | tail -5')).toEqual([])
    expect(words('cat a b 2>/dev/null')).toEqual(['a', 'b'])
  })

  test('a heredoc, a substitution, a variable or a flag that changes the bytes names nothing', () => {
    expect(words("cat > src/x.ts <<'EOF'\nx\nEOF")).toEqual([])
    expect(words('wc -l $(git ls-files) && cat a')).toEqual([])
    expect(words('cat $HOME/a')).toEqual([])
    expect(words('cat -A a')).toEqual([])
    expect(words('if true; then cat a; fi')).toEqual([])
  })

  test('a newline ends a command, unless it follows an operator', () => {
    expect(words('cat a\ncat b |\n  head')).toEqual(['a'])
  })
})

describe('bashInfo — the read markers', () => {
  test('a pure read wrapped whole, with both lines after it', () => {
    const text =
      '<bash-output-read>a\n</bash-output-read>\n' +
      'Not shown — over the 28k a Bash result shows whole: dump/f18.ts, dump/f19.ts. cat them in another call, or Read them.\n' +
      COUNT_AS_READ_2
    expect(bashInfo(bash('cat a dump/*', text))).toMatchObject({ marker: 'read', notShown: true, countsAsRead: true })
  })

  test('the one-file line, with files not counted, after any output', () => {
    const text = `a\n${COUNT_AS_READ_1} Not counted: src/types.ts (cut).`
    expect(bashInfo(bash('git status && cat a', text))).toMatchObject({ marker: null, notShown: false, countsAsRead: true })
  })
})

describe('isCatReadMiss — a cat the pure-read grammar refused', () => {
  const capped = '<bash-output-filtered original="" lines="30/568" reduction="96%">x</bash-output-filtered>'
  const miss = (command: string, text: string, extra: Partial<Call> = {}) =>
    isCatReadMiss(bashInfo(bash(command, text, extra)))

  test('a successful cat that did not come back in the read wrapper', () => {
    // The two misses of 20260924-212723, capped where the pass-through was on.
    expect(miss('cd src && cat catalog.ts cli.ts', capped)).toBe(true)
    expect(miss('cat -n src/types.ts; head -c 1500 data/catalog.json; echo; cat b.json', capped)).toBe(true)
    // Short enough that nothing wrapped it.
    expect(miss('git status && cat a.ts', 'a')).toBe(true)
    expect(miss('for f in a b; do echo $f; cat $f; done', capped)).toBe(true)
    expect(miss('ls\ncat a.ts', 'a')).toBe(true)
  })

  test('not a read the pass-through took, a failure, a refusal, nor a command without a cat', () => {
    expect(miss('cd src && cat a.ts', '<bash-output-read>a\n</bash-output-read>')).toBe(false)
    expect(miss('cat missing.ts', 'Exit code 1\ncat: missing.ts: No such file or directory', { isError: true })).toBe(false)
    // A harness message, whether or not the call was flagged as an error.
    expect(miss('cat a.ts', 'Permission to use Bash has been denied.', { isError: true })).toBe(false)
    expect(miss('cat a.ts', '[Request interrupted by user for tool use]')).toBe(false)
    // A pipe's sink, a word inside another, an argument.
    expect(miss('git diff | cat', 'diff')).toBe(false)
    expect(miss('bun test src/concat.test.ts', 'ok')).toBe(false)
    expect(miss('echo cat', 'cat')).toBe(false)
    expect(miss('docat a.ts', 'a')).toBe(false)
  })
})

describe('shownWholeFiles — the proxy for a file printed whole', () => {
  test('every file an uncut cat named, globs expanded against the workspace', () => {
    expect(shownWholeFiles(bash('git ls-files && cat README.md && cat src/*.ts'), ws)).toEqual([
      at('README.md'),
      at('src/a.ts'),
      at('src/b.ts'),
    ])
  })

  test('a capped result shows nothing whole; a pass-through that kept every line does', () => {
    const capped = '<bash-output-filtered original="" lines="30/700" reduction="95%">x</bash-output-filtered>'
    const kept = '<bash-output-filtered original="" lines="700/700" reduction="0%">x</bash-output-filtered>'
    expect(shownWholeFiles(bash('cat src/a.ts', capped), ws)).toEqual([])
    expect(shownWholeFiles(bash('cat src/a.ts', kept), ws)).toEqual([at('src/a.ts')])
  })

  test('a read wrapper, minus the files it did not show and those not counted', () => {
    const text =
      '<bash-output-read>src/a.ts\n</bash-output-read>\n' +
      'Not shown — over the 28k a Bash result shows whole: src/b.ts. cat them in another call, or Read them.\n' +
      `${COUNT_AS_READ_1} Not counted: README.md (one line).`
    expect(shownWholeFiles(bash('cat src/a.ts src/b.ts README.md', text), ws)).toEqual([at('src/a.ts')])
  })

  test('a failed, persisted or out-of-project read shows nothing, beyond what the credit counted', () => {
    expect(shownWholeFiles(bash('cat src/a.ts', 'Exit code 1\nx', { isError: true }), ws)).toEqual([])
    expect(shownWholeFiles(bash('cat src/a.ts', '<persisted-output>\nOutput too large'), ws)).toEqual([])
    expect(shownWholeFiles(bash('cat /etc/hosts ../x'), ws)).toEqual([])
    const credited = bash('cat src/a.ts; bun test 2>&1 | tail', 'x', { credited: [at('src/a.ts')] })
    expect(shownWholeFiles(credited, ws)).toEqual([at('src/a.ts')])
  })
})

describe('editsOnNeverRead — the gate let an edit through with no Read', () => {
  test('an Edit of a pristine file that was only cat-ed', () => {
    const calls = [bash('cat test/quote.test.ts'), call('Edit', { file_path: at('test/quote.test.ts') })]
    expect(editsOnNeverRead(calls, ws)).toBe(1)
  })

  test('not after a Read, a batch one included', () => {
    const calls = [
      call('Read', { file_paths: [at('src/quote.ts'), at('src/cart.ts')] }),
      call('Patch', { patchText: '*** Begin Patch\n*** Update File: src/quote.ts\n@@\n*** Update File: src/cart.ts\n@@\n*** End Patch' }),
    ]
    expect(editsOnNeverRead(calls, ws)).toBe(0)
  })

  test("a patch counts each Update and Delete target, never an Add", () => {
    const patchText = '*** Begin Patch\n*** Add File: src/dates.ts\n+x\n*** Update File: src/types.ts\n@@\n*** Delete File: src/tax.ts\n*** End Patch'
    expect(editsOnNeverRead([call('Patch', { patchText })], ws)).toBe(2)
  })

  test('a refused edit does not count, and one that served its lines makes them read', () => {
    const patchText = '*** Begin Patch\n*** Update File: src/quote.ts\n@@\n*** End Patch'
    const calls = [
      call('Patch', { patchText }, { isError: true, refused: true, served: true }),
      call('Patch', { patchText: '*** Resubmit' }),
      call('Edit', { file_path: at('src/quote.ts') }),
      call('Edit', { file_path: at('src/cart.ts') }, { isError: true, refused: true }),
    ]
    expect(editsOnNeverRead(calls, ws)).toBe(0)
  })

  test('an accepted `*** Resubmit` edits the files of the patch it refers to', () => {
    const patchText = '*** Begin Patch\n*** Update File: src/quote.ts\n@@\n*** End Patch'
    const calls = [call('Patch', { patchText }, { isError: true, refused: true }), call('Patch', { patchText: '*** Resubmit' })]
    expect(editsOnNeverRead(calls, ws)).toBe(1)
  })

  test('a file the session created needs no Read', () => {
    const calls = [call('Write', { file_path: at('src/dates.ts') }), call('Edit', { file_path: at('src/dates.ts') })]
    expect(editsOnNeverRead(calls, ws)).toBe(0)
  })
})

describe('readsOfShownFiles — a Read of a file a cat had printed whole', () => {
  test('a Read in a later API call counts, each file of a batch Read too', () => {
    const calls = [bash('cat src/a.ts src/b.ts'), call('Read', { file_path: at('src/a.ts') }), call('Read', { file_paths: [at('src/a.ts'), at('src/b.ts')] })]
    expect(readsOfShownFiles(calls, ws)).toBe(3)
  })

  test('a Read sent beside the cat had not seen it', () => {
    const cat = bash('cat src/a.ts')
    expect(readsOfShownFiles([cat, call('Read', { file_path: at('src/a.ts') }, { turn: cat.turn })], ws)).toBe(0)
  })

  test('not after a capped cat, nor once the file was edited since', () => {
    const capped = '<bash-output-filtered original="" lines="30/700" reduction="95%">x</bash-output-filtered>'
    expect(readsOfShownFiles([bash('cat src/a.ts', capped), call('Read', { file_path: at('src/a.ts') })], ws)).toBe(0)
    const edited = [bash('cat src/a.ts src/b.ts'), call('Edit', { file_path: at('src/a.ts') }), bash("sed -i 's/x/y/' src/b.ts")]
    expect(readsOfShownFiles([...edited, call('Read', { file_paths: [at('src/a.ts'), at('src/b.ts')] })], ws)).toBe(0)
  })

  test('a file created after the cat is not one it printed, though the glob now names it', () => {
    const calls = [
      bash('cat src/*.ts'),
      call('Patch', { patchText: '*** Begin Patch\n*** Add File: src/b.ts\n+x\n*** End Patch' }),
      call('Read', { file_paths: [at('src/a.ts'), at('src/b.ts')] }),
    ]
    expect(readsOfShownFiles(calls, ws)).toBe(1)
  })
})

describe('analyzeSession — the read credit list rides onto the Bash call', () => {
  const assistant = (id: string, tools: [string, string][]) => ({
    type: 'assistant',
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: tools.map(([useId, command]) => ({ type: 'tool_use', id: useId, name: 'Bash', input: { command } })),
    },
  })
  const result = (useId: string, structured: Record<string, unknown>, key = 'toolUseResult') => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: useId, content: 'a' }] },
    [key]: structured,
  })

  test("from the transcript's toolUseResult or the stream's tool_use_result, and only when it counted a file", () => {
    const transcript = [
      assistant('m1', [['u1', 'cat a.ts']]),
      result('u1', { stdout: 'a', creditedFiles: ['/w/a.ts'] }),
      assistant('m2', [['u2', 'cat b.ts']]),
      result('u2', { stdout: 'b' }),
    ]
    const stream = [assistant('m3', [['u3', 'cat c.ts']]), result('u3', { creditedFiles: ['/w/c.ts'] }, 'tool_use_result')]
    const { calls } = analyzeSession([stream], new Set(), transcript)
    expect(calls.map(c => c.credited)).toEqual([['/w/a.ts'], undefined, ['/w/c.ts']])
  })
})

describe('turnsBeforeFirstEdit — phase 1 up to the first edit', () => {
  test("Claude Code's python heredoc is its first edit", () => {
    lastTurn = 0
    const calls = [
      bash('git ls-files && cat README.md'),
      bash("python3 -c \"import json; print(json.load(open('data/catalog.json')))\""),
      bash("python3 - <<'EOF'\np='src/types.ts'; s=open(p).read()\nopen(p,'w').write(s)\nEOF"),
    ]
    expect(turnsBeforeFirstEdit(calls, 9)).toBe(2)
  })

  test('a refused patch is the first edit all the same', () => {
    lastTurn = 0
    const calls = [call('Read', { file_path: at('src/a.ts') }), call('Patch', { patchText: 'x' }, { isError: true, refused: true })]
    expect(turnsBeforeFirstEdit(calls, 9)).toBe(1)
  })

  test('sed -n and a redirect into the scratchpad are not edits; sed -i is', () => {
    lastTurn = 0
    const calls = [
      bash('sed -n 1,20p src/a.ts'),
      bash("cat > /tmp/x.json <<'EOF'\n{}\nEOF"),
      bash('cat > "$S/c.json" <<EOF\n{}\nEOF'),
      bash("sed -i 's/a/b/' src/a.ts"),
    ]
    expect(turnsBeforeFirstEdit(calls, 9)).toBe(3)
  })

  test('a phase with no edit spends all its turns', () => {
    expect(turnsBeforeFirstEdit([bash('ls'), call('Edit', { file_path: 'x' }, { phase: 2 })], 7)).toBe(7)
  })
})

describe("claudinPartsOf — calls into the project's .claudin/", () => {
  const parts = (c: Call) => [...claudinPartsOf(c, ws)].sort()

  test('memory, rules and the rest, from one command', () => {
    expect(parts(bash('ls .claudin .claudin/memory; cat .claudin/memory/MEMORY.md .claudin/rules/*'))).toEqual([
      'memory',
      'other',
      'rules',
    ])
    expect(parts(call('Glob', { pattern: '.claudin/**/*' }))).toEqual(['other'])
    expect(parts(call('Read', { file_path: at('.claudin/rules/search-strategy.md') }))).toEqual(['rules'])
  })

  test("the home config dir is not the project's: a persisted result read back", () => {
    expect(parts(call('Read', { file_path: '/home/u/.claudin/projects/-tmp-x/abc/tool-results/b.txt' }))).toEqual([])
    expect(parts(bash('cat ~/.claudin/settings.json $HOME/.claudin/x ../.claudin/y'))).toEqual([])
  })

  test("a patch's headers count, its body does not; a lookalike name does not", () => {
    expect(parts(call('Patch', { patchText: '*** Begin Patch\n*** Update File: .gitignore\n+.claudin/\n*** End Patch' }))).toEqual([])
    expect(parts(call('Patch', { patchText: '*** Begin Patch\n*** Add File: .claudin/rules/x.md\n+x\n*** End Patch' }))).toEqual([
      'rules',
    ])
    expect(parts(bash('cat .claudinrc x.claudin .claudin.json'))).toEqual([])
  })
})

describe('readTargetsOf', () => {
  test('file_path, or file_paths for a batch, with the Codex placeholders ignored', () => {
    expect(readTargetsOf({ file_path: '/a' })).toEqual(['/a'])
    expect(readTargetsOf({ file_paths: ['/a', '/b'] })).toEqual(['/a', '/b'])
    expect(readTargetsOf({ file_path: null, file_paths: ['/a', ''] })).toEqual(['/a'])
    expect(readTargetsOf({ file_path: '/a', file_paths: null })).toEqual(['/a'])
    expect(readTargetsOf({ file_path: '' })).toEqual([])
  })
})

describe('phaseArgs — which arms bypass permissions', () => {
  const args = parseArgs([
    '--variant=auto',
    '--arm-args=auto:--permission-mode auto',
    '--variant=planned',
    '--arm-args=planned:--permission-mode=plan',
    '--variant=nopatch',
    '--arm-args=nopatch:--disallowedTools Patch',
  ])
  const bothPhases = (arm: string) => [phaseArgs(args, arm, 1, 'first prompt', null), phaseArgs(args, arm, 2, 'second prompt', 'sid')]

  test('an arm whose --arm-args choose a permission mode runs in that mode, in both phases', () => {
    for (const cli of bothPhases('auto')) {
      expect(cli).not.toContain('--dangerously-skip-permissions')
      expect(cli[cli.indexOf('--permission-mode') + 1]).toBe('auto')
    }
    for (const cli of bothPhases('planned')) {
      expect(cli).not.toContain('--dangerously-skip-permissions')
      expect(cli).toContain('--permission-mode=plan')
    }
  })

  test('every other arm bypasses, whatever else its --arm-args add', () => {
    for (const arm of ['claude', 'claudindev', 'nopatch']) {
      for (const cli of bothPhases(arm)) expect(cli).toContain('--dangerously-skip-permissions')
    }
    expect(bothPhases('nopatch')[1]).toContain('--disallowedTools')
  })

  test('the prompt and the resume belong to their phase', () => {
    const [p1, p2] = bothPhases('auto')
    expect(p1!.slice(0, 2)).toEqual(['-p', 'first prompt'])
    expect(p1).not.toContain('--resume')
    expect(p2!.slice(-2)).toEqual(['--resume', 'sid'])
  })
})

describe('requestCensus — the classifier requests around each agent-loop response', () => {
  const request = (kind: KindedRequest['kind'], extra: Partial<KindedRequest> = {}): KindedRequest => ({
    n: 0,
    kind,
    model: 'claude-opus-5-5',
    usage: null,
    ...extra,
  })
  const judged = (action: string, judgment: string, extra: Partial<KindedRequest> = {}) =>
    request('classifier', { action, judgment, ...extra })

  test('windows, judged actions and repeats, over two phases', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 },
    }
    const phase1 = [
      request('other'), // a title, before any response: no window yet
      request('main'),
      judged('Bash rm', 'j1', { usage }), // stage 1 blocked…
      judged('Bash rm', 'j1'), // …stage 2 of the same judgment: two requests, one action
      request('main'),
      judged('Bash build', 'j2'),
      judged('Bash deploy', 'j3'), // two actions in one response: what a batch would merge
      request('main'),
      judged('Bash rm', 'j4'), // the same action judged again, later: a cache would answer it
      request('main'),
    ]
    const phase2 = [
      request('main'),
      judged('Bash build', 'j5'),
      judged('Bash build', 'j5'), // both stages of a re-judged action count
      request('main'),
    ]
    const census = requestCensus([phase1, phase2])
    expect(census).toMatchObject({ main: 6, classifier: 7, other: 1, multiRequest: 3, multiAction: 1, repeated: 3 })
    // Opus 5.5 at $4 in / $20 out / $0.20 read / $8 per 1M written at 1h.
    expect(census.classifierCost).toBeCloseTo((1000 * 4 + 100 * 20 + 10_000 * 0.2 + 2000 * 8) / 1e6, 10)
  })

  test('a window closes with its phase, and a session without the classifier counts none', () => {
    const census = requestCensus([
      [request('main'), judged('Bash a', 'j1')],
      [judged('Bash b', 'j2'), request('main'), request('other')],
    ])
    expect(census).toMatchObject({ main: 2, classifier: 2, other: 1, multiRequest: 0, multiAction: 0, repeated: 0 })
    expect(requestCensus([[request('main'), request('main')], []])).toMatchObject({ main: 2, classifier: 0, classifierCost: 0 })
  })

  test('requests judging a read command with a glob, whichever way the action is written', () => {
    const census = requestCensus([
      [
        request('main'),
        judged('Bash git ls-files && cat README.md && cat src/*.ts\n', 'j1'),
        judged('Bash git ls-files && cat README.md && cat src/*.ts\n', 'j1'), // stage 2 of the same judgment counts too
        judged('{"Bash":"ls test* 2>/dev/null"}\n', 'j2'), // the JSONL transcript
        judged('Bash cat data/carts/*.json && bun test 2>&1 | tail -5\n', 'j3'), // a check beside the read
        judged('Read {"file_path":"/w/src/*.ts"}\n', 'j4'), // not Bash
      ],
      [request('main'), judged('Bash wc -l src/*.ts\n', 'j5')],
    ])
    expect(census).toMatchObject({ classifier: 6, globReadRequests: 4 })
  })

  test('every count of the census has its row in the report', () => {
    expect(CENSUS_ROWS.map(([, key]) => key).sort()).toEqual(Object.keys(requestCensus([])).sort())
  })
})

describe('isGlobReadCommand — a read command the classifier judges for its glob alone', () => {
  test('read commands, chained, with an unquoted glob among their words', () => {
    for (const command of [
      'git ls-files && cat README.md package.json && cat src/*.ts',
      'ls test* tests* 2>/dev/null',
      'wc -l src/*.ts | tail -1',
      'grep -n coupon src/*.ts || head -20 test/?.test.ts',
      'git diff --stat -- src/[ab].ts',
      'git -C /w log --oneline -- "src/a.ts" src/*.ts 2>&1 | head -5',
      'cat src/a.ts\ncat test/*.ts',
    ]) {
      expect([command, isGlobReadCommand(command)]).toEqual([command, true])
    }
  })

  test('no glob: none at all, a quoted or escaped one, a parameter, a comment', () => {
    for (const command of [
      'git ls-files && cat README.md package.json',
      'cat "src/*.ts"',
      "grep -E 'a*b' src/a.ts",
      'cat src/\\*.ts',
      'wc -l src/a.ts $?',
      'cat src/a.ts # and src/*.ts later',
    ]) {
      expect([command, isGlobReadCommand(command)]).toEqual([command, false])
    }
  })

  test('not a plain read: another command, a substitution, a heredoc, a subshell, a job, a write', () => {
    for (const command of [
      'cat data/carts/*.json && bun test 2>&1 | tail -5',
      'ls src/*.ts || true',
      'cd src && cat *.ts',
      'sed -n 1,5p src/*.ts',
      'python *',
      'git add src/*.ts',
      'git checkout -- src/*.ts',
      'wc -l $(git ls-files src/*.ts)',
      'cat `ls src/*.ts`',
      "cat <<'EOF'\nsrc/*.ts\nEOF",
      '(cat src/*.ts)',
      'cat src/*.ts &',
      'cat src/*.ts > all.txt',
    ]) {
      expect([command, isGlobReadCommand(command)]).toEqual([command, false])
    }
  })
})
