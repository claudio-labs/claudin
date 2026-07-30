import { describe, expect, test, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import {
  isRedirectableTestCommand,
  MEMO_LIMIT,
  renderRunTestsRedirect,
  resetRunTestsRedirectMemoForTesting,
  shouldRedirectToRunTests,
  stripOutputTrimTail,
} from './redirect.js'

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
    // The output-trimming tail the model habitually appends to a verbose
    // runner. It asks for LESS output, which is what RunTests returns — and in
    // Rust it is on virtually every real invocation, so treating it as
    // composition meant the redirect never fired there at all.
    'cargo test -p ferrous-dns-infrastructure --test cache_bloom_rotation_test 2>&1 | tail -25',
    'bun test 2>&1',
    'pytest tests/unit | head -20',
    'cargo test --test doq_test 2>&1 | grep -E "^test |test result"',
    'go test ./... 2>&1 | tail -40 | head -5',
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

describe('renderRunTestsRedirect', () => {
  test('names the tool, the exact command, and the escape hatch', () => {
    const msg = renderRunTestsRedirect('pytest tests/unit')
    expect(msg).toContain('RunTests')
    expect(msg).toContain('"pytest tests/unit"')
    expect(msg).toContain('re-send this exact Bash command')
  })

  test('suggests the command WITHOUT the output filter', () => {
    // A piped command handed to RunTests' `command` would have its summary
    // truncated away before the parser saw it, so the suggestion must be the
    // bare run — while the escape hatch still points at the command as typed.
    const msg = renderRunTestsRedirect('cargo test --test doq 2>&1 | tail -40')
    expect(msg).toContain('command: "cargo test --test doq"')
    expect(msg).not.toContain('command: "cargo test --test doq 2>&1 | tail -40"')
    expect(msg).toContain('`cargo test --test doq 2>&1 | tail -40`')
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
// Wiring. BashTool.tsx reaches src/ink.js through its import chain, so it
// cannot be imported under `bun test` (see .claudin/rules/testing.md). Without
// this block, deleting the call from validateInput leaves every test above
// green while the redirect never fires in production.
// ---------------------------------------------------------------------------

describe('BashTool wiring', () => {
  const src = readFileSync(
    new URL('../BashTool/BashTool.tsx', import.meta.url),
    'utf8',
  )

  test('validateInput consults the redirect', () => {
    expect(src).toContain('shouldRedirectToRunTests(input.command)')
    expect(src).toContain('renderRunTestsRedirect(input.command)')
  })

  test('only when RunTests is in this agent toolset', () => {
    expect(src).toContain(
      'findToolByName(context?.options?.tools ?? [], RUN_TESTS_TOOL_NAME)',
    )
  })

  test('never for a backgrounded run, and honors the killswitch', () => {
    expect(src).toContain('CLAUDIN_DISABLE_RUNTESTS_REDIRECT')
    expect(src).toContain('!input.run_in_background && !isEnvTruthy(process.env.CLAUDIN_DISABLE_RUNTESTS_REDIRECT)')
  })
})
