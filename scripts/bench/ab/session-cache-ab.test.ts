import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  analyzeSession,
  bashInfo,
  catReadsOf,
  claudinPartsOf,
  editsOnNeverRead,
  readsOfShownFiles,
  readTargetsOf,
  shownWholeFiles,
  turnsBeforeFirstEdit,
} from './session-cache-ab.ts'

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
