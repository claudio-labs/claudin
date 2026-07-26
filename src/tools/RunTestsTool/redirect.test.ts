import { describe, expect, test, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import {
  isRedirectableTestCommand,
  MEMO_LIMIT,
  renderRunTestsRedirect,
  resetRunTestsRedirectMemoForTesting,
  shouldRedirectToRunTests,
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
    // Deliberate raw-output / non-run intent.
    ['pytest -s', 'capture disabled'],
    ['cargo test -- --nocapture', 'capture disabled'],
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
