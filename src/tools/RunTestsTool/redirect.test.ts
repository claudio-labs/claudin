import { describe, expect, test, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import {
  isRedirectableTestCommand,
  MEMO_LIMIT,
  noteRunTestsExecution,
  renderRunTestsRedirect,
  resetRunTestsRedirectMemoForTesting,
  shouldRedirectToRunTests,
  stripOutputTrimTail,
} from 'src/tools/RunTestsTool/redirect.js'

describe('isRedirectableTestCommand — fires on a bare test run', () => {
  const REDIRECTED = [
    'bun test',
    'bun test src/tools/RunTestsTool/detect.test.ts',
    'npm test',
    'yarn test',
    'pnpm run test',
    'npx vitest run',
    'npx jest src/foo',
    'pytest',
    'pytest tests/unit',
    'python -m pytest tests',
    // Python projects run the suite through their env manager — the bare form
    // is the one that does NOT work there, so the redirect has to see these.
    'uv run pytest',
    'uv run pytest modules/backend',
    'uv run python -m pytest',
    'poetry run pytest',
    'pipenv run pytest',
    'pdm run pytest',
    '.venv/bin/pytest',
    'go test ./...',
    'go test -run TestFoo ./pkg',
    'cargo test',
    'cargo nextest run',
    'bundle exec rspec',
    'mix test',
    'dotnet test',
    'mvn test',
    './gradlew test',
    'deno test',
    'node --test',
    'CI=true bun test',
    // A trailing stderr merge is not a filter: still a bare run.
    'bun test 2>&1',
    'cargo test -p ferrous-dns-infrastructure --test cache_bloom_rotation_test 2>&1',
  ]
  for (const cmd of REDIRECTED) {
    test(cmd, () => expect(isRedirectableTestCommand(cmd)).toBe(true))
  }
})

describe('isRedirectableTestCommand — stands down', () => {
  const NOT_REDIRECTED: Array<[string, string]> = [
    // The command only MENTIONS a runner. Anchoring on the head is what keeps
    // a search from being refused by the test tool.
    ['grep -rn "bun test" src', 'mentions a runner, does not run one'],
    ['echo bun test', 'mentions a runner, does not run one'],
    ['rg "go test" --glob "*.md"', 'mentions a runner, does not run one'],
    // Composition: RunTests cannot run the other half.
    ['bun run build && bun test', 'chained with a build'],
    ['pytest | tee /tmp/out', 'piped'],
    ['go test ./... > /tmp/out', 'redirected'],
    ['cargo test; echo done', 'sequenced'],
    // Trimming the output does not excuse the rest of the command.
    ['bun test 2>&1 | tee /tmp/out', 'tee persists the output, it does not trim it'],
    ['bun test | wc -l', 'pipes to something that is not an output filter'],
    ['pytest 2>&1 > /tmp/out', 'redirected, the 2>&1 is not the tail'],
    ['bun run build && bun test 2>&1 | tail -20', 'still chained with a build'],
    // An output-filter tail is raw-output intent (2026-09-14..20: 66 of 72
    // `bun test` refusals carried one, 39 were re-sent identically).
    ['bun test src/tools/RunTestsTool/redirect.test.ts 2>&1 | tail -25', 'tail: raw-output intent'],
    ['pytest tests/unit | head -20', 'head: raw-output intent'],
    ['cargo test --test doq_test 2>&1 | grep -E "^test |test result"', 'grep: raw-output intent'],
    ['go test ./... 2>&1 | tail -40 | head -5', 'stacked filters: raw-output intent'],
    // Deliberate raw-output / non-run intent.
    ['pytest -s', 'capture disabled'],
    ['cargo test -- --nocapture', 'capture disabled'],
    [
      'cargo test --test zz_repro -- --nocapture 2>&1 | tail -35',
      'capture disabled — the trimming tail does not override the flag',
    ],
    ['npx vitest --watch', 'watcher'],
    ['pytest --pdb', 'debugger'],
    ['npx jest --reporters=json', 'explicit reporter'],
    ['cargo test --no-run', 'compiles without running'],
    ['pytest --collect-only', 'lists without running'],
    ['bun test --help', 'help text'],
    // Ambiguous runner tokens without a test goal.
    ['mvn -v', 'maven, no test goal'],
    ['mvn package', 'maven, no test goal'],
    ['gradle build', 'gradle, no test goal'],
    // Not a test command at all.
    ['bun run build', 'build script'],
    ['bun run typecheck', 'typecheck script'],
    ['bun run test:provider', 'scoped script RunTests parses only degraded'],
    ['uv run ruff check .', 'env manager, but not a test run'],
    ['uv sync --all-packages', 'env manager, but not a test run'],
    ['uv run pytest -s', 'capture disabled'],
    ['git status', 'unrelated'],
    ['', 'empty'],
  ]
  for (const [cmd, why] of NOT_REDIRECTED) {
    test(`${cmd || '(empty)'} — ${why}`, () =>
      expect(isRedirectableTestCommand(cmd)).toBe(false))
  }
})

describe('shouldRedirectToRunTests — one-shot escape hatch', () => {
  beforeEach(() => resetRunTestsRedirectMemoForTesting())

  test('refuses the first attempt and runs the re-send', () => {
    expect(shouldRedirectToRunTests('bun test')).toBe(true)
    expect(shouldRedirectToRunTests('bun test')).toBe(false)
    // Still allowed on every later attempt — the escape does not expire.
    expect(shouldRedirectToRunTests('bun test')).toBe(false)
  })

  test('memoizes per command, not globally', () => {
    expect(shouldRedirectToRunTests('bun test')).toBe(true)
    expect(shouldRedirectToRunTests('pytest')).toBe(true)
  })

  test('surrounding whitespace does not buy a second refusal', () => {
    expect(shouldRedirectToRunTests('bun test')).toBe(true)
    expect(shouldRedirectToRunTests('  bun test  ')).toBe(false)
  })

  test('a non-test command is never recorded', () => {
    expect(shouldRedirectToRunTests('git status')).toBe(false)
    expect(shouldRedirectToRunTests('git status')).toBe(false)
  })

  test('the memo evicts the oldest entry instead of clearing itself', () => {
    // Refuse MEMO_LIMIT + 21 distinct commands, then check one from the
    // middle: with FIFO eviction the set still holds the last MEMO_LIMIT, so
    // it keeps its escape. A wholesale clear would have re-armed a command
    // that had already spent one.
    expect(shouldRedirectToRunTests('bun test')).toBe(true)
    for (let i = 1; i <= MEMO_LIMIT + 20; i++) {
      expect(shouldRedirectToRunTests(`bun test src/f${i}.test.ts`)).toBe(true)
    }
    expect(shouldRedirectToRunTests('bun test src/f25.test.ts')).toBe(false)
  })

  test('the memo is bounded — a full memo evicts the oldest instead of growing', () => {
    // The observable difference between FIFO eviction and NO eviction at
    // all: with the eviction block deleted the set grows unboundedly and the
    // oldest command stays memoized forever; with FIFO it re-arms.
    expect(shouldRedirectToRunTests('bun test')).toBe(true)
    for (let i = 1; i <= MEMO_LIMIT; i++) {
      expect(shouldRedirectToRunTests(`bun test src/f${i}.test.ts`)).toBe(true)
    }
    expect(shouldRedirectToRunTests('bun test')).toBe(true)
  })
})

describe('noteRunTestsExecution — the escalation after a RunTests run', () => {
  beforeEach(() => resetRunTestsRedirectMemoForTesting())

  test('the observed case: RunTests ran the suite, the bare follow-up on it is not refused', () => {
    noteRunTestsExecution('bun test src/tools/GitTool')
    expect(shouldRedirectToRunTests('bun test src/tools/GitTool 2>&1')).toBe(false)
  })

  test('the pass is one-shot — a second escalation on the same suite is refused again', () => {
    noteRunTestsExecution('bun test src/tools/GitTool')
    expect(shouldRedirectToRunTests('bun test src/tools/GitTool')).toBe(false)
    // A differently shaped Bash call on the same suite has no pass left, so the
    // redirect is back: one RunTests run buys one escalation, not a session-long
    // whitelist for the project's main suite.
    expect(shouldRedirectToRunTests('bun test src/tools/GitTool --bail')).toBe(true)
  })

  test('a granted command is not refused later as if it were a first attempt', () => {
    noteRunTestsExecution('bun test')
    expect(shouldRedirectToRunTests('bun test')).toBe(false)
    expect(shouldRedirectToRunTests('bun test')).toBe(false)
  })

  test('the next RunTests run re-arms the pass', () => {
    noteRunTestsExecution('pytest tests/unit')
    expect(shouldRedirectToRunTests('pytest tests/unit')).toBe(false)
    expect(shouldRedirectToRunTests('pytest tests/unit -x')).toBe(true)
    noteRunTestsExecution('pytest tests/unit')
    expect(shouldRedirectToRunTests('pytest tests/unit 2>&1')).toBe(false)
  })

  test('the pass covers that suite only', () => {
    noteRunTestsExecution('bun test src/tools/GitTool')
    expect(shouldRedirectToRunTests('bun test src/tools/RunTestsTool')).toBe(true)
    expect(shouldRedirectToRunTests('bun test')).toBe(true)
  })

  test('a command Bash would never redirect is not recorded, so it cannot evict a live pass', () => {
    // `bun run test:<scope>` is a scoped script the redirect stands down on: no
    // Bash call can ever match it, so recording one would only push a real
    // entry out of the bounded set. Observable exactly there — without the
    // guard these MEMO_LIMIT entries evict the pass armed first.
    noteRunTestsExecution('bun test src/first.test.ts')
    for (let i = 0; i < MEMO_LIMIT; i++) noteRunTestsExecution(`bun run test:scope${i}`)
    expect(shouldRedirectToRunTests('bun test src/first.test.ts')).toBe(false)
  })
})

describe('renderRunTestsRedirect', () => {
  test('names the tool, the exact command, and the escape hatch', () => {
    const msg = renderRunTestsRedirect('pytest tests/unit')
    expect(msg).toContain('RunTests')
    expect(msg).toContain('"pytest tests/unit"')
    expect(msg).toContain('re-send this exact Bash command')
  })

  test('suggests the command WITHOUT the trailing 2>&1, and names the tail escape', () => {
    // RunTests carries stderr itself; the suggestion is the bare run while
    // the escape hatch still points at the command as typed.
    const msg = renderRunTestsRedirect('cargo test --test doq 2>&1')
    expect(msg).toContain('command: "cargo test --test doq"')
    expect(msg).not.toContain('command: "cargo test --test doq 2>&1"')
    expect(msg).toContain('`cargo test --test doq 2>&1`')
    expect(msg).toContain('runs on the first send')
  })
})

describe('stripOutputTrimTail', () => {
  const STRIPPED: Array<[string, string]> = [
    ['cargo test 2>&1 | tail -35', 'cargo test'],
    ['cargo test 2>&1', 'cargo test'],
    ['pytest tests | head -20', 'pytest tests'],
    ['go test ./... | tail -40 | head -5', 'go test ./...'],
    // The filter's own args carry quotes AND a `|` — matching "up to the next
    // pipe" would leave `test result"` behind and read as composition.
    ['cargo test 2>&1 | grep -E "^test |test result"', 'cargo test'],
  ]
  for (const [cmd, core] of STRIPPED) {
    test(cmd, () => expect(stripOutputTrimTail(cmd)).toBe(core))
  }

  const UNTOUCHED = [
    'cargo test',
    'bun test | tee /tmp/out',
    'go test ./... > /tmp/out',
    // No filter and no trailing 2>&1: nothing may be shaved off the command.
    'grep -rn "bun test" src',
  ]
  for (const cmd of UNTOUCHED) {
    test(`${cmd} — unchanged`, () => expect(stripOutputTrimTail(cmd)).toBe(cmd))
  }
})

// ---------------------------------------------------------------------------
// Wiring. The lane's gates (toolset, backgrounded run, killswitch) and its
// call sites in both redirect modes are driven behaviourally in
// BashTool/redirectLanes.test.ts, through `pickBashRedirect` and BashTool's own
// `validateInput`/`advise`.
// ---------------------------------------------------------------------------

describe('RunTestsTool wiring', () => {
  const src = readFileSync(new URL('./RunTestsTool.ts', import.meta.url), 'utf8')

  test('call() arms the escalation with the command it resolved', () => {
    // Without this the pass is never armed and every test above still passes,
    // because they call noteRunTestsExecution themselves.
    expect(src).toContain('noteRunTestsExecution(command)')
  })
})
