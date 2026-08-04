import { beforeEach, describe, expect, test } from 'bun:test'
import {
  isRedirectableCheckCommand,
  MEMO_LIMIT,
  renderTypecheckRedirect,
  resetTypecheckRedirectMemoForTesting,
  shouldRedirectToTypecheck,
  stripOutputTrimTail,
} from './redirect.js'

describe('isRedirectableCheckCommand — what it catches', () => {
  test.each([
    'bun run typecheck',
    'npm run type-check',
    'yarn typecheck',
    'pnpm run check-types',
    'tsc --noEmit',
    'npx tsc --noEmit',
    './node_modules/.bin/tsc --noEmit',
    'cargo check',
    'mypy .',
    '.venv/bin/mypy src',
    'pyright',
    'deno check',
    'dart analyze',
    'vendor/bin/phpstan analyse',
  ])('redirects %s', command => {
    expect(isRedirectableCheckCommand(command)).toBe(true)
  })

  test('accepts an output-trimming tail, since that asks for less output too', () => {
    expect(isRedirectableCheckCommand('bun run typecheck 2>&1 | grep "error TS"')).toBe(true)
    expect(stripOutputTrimTail('bun run typecheck 2>&1 | grep "error TS"')).toBe(
      'bun run typecheck',
    )
  })
})

describe('isRedirectableCheckCommand — what it must NOT catch', () => {
  test('a search that merely mentions a checker', () => {
    // The worst possible false positive: a grep blocked by the typecheck tool.
    expect(isRedirectableCheckCommand('grep -rn "cargo check" src')).toBe(false)
    expect(isRedirectableCheckCommand('rg "tsc --noEmit" .')).toBe(false)
  })

  test('a build that produces artifacts people want', () => {
    expect(isRedirectableCheckCommand('go build -o bin/app')).toBe(false)
    expect(isRedirectableCheckCommand('go build ./...')).toBe(false)
    expect(isRedirectableCheckCommand('dotnet build')).toBe(false)
    expect(isRedirectableCheckCommand('mvn compile')).toBe(false)
    expect(isRedirectableCheckCommand('./gradlew compileJava')).toBe(false)
  })

  test('a compound command the tool cannot run', () => {
    expect(isRedirectableCheckCommand('bun run build && bun run typecheck')).toBe(false)
    expect(isRedirectableCheckCommand('tsc --noEmit > out.txt')).toBe(false)
  })

  test('flags that ask for raw output or no check at all', () => {
    expect(isRedirectableCheckCommand('tsc --watch')).toBe(false)
    expect(isRedirectableCheckCommand('tsc --noEmit --pretty')).toBe(false)
    expect(isRedirectableCheckCommand('tsc --version')).toBe(false)
    expect(isRedirectableCheckCommand('tsc --listFiles')).toBe(false)
    expect(isRedirectableCheckCommand('cargo check --explain E0308')).toBe(false)
  })

  test('an unrelated command', () => {
    expect(isRedirectableCheckCommand('git status')).toBe(false)
    expect(isRedirectableCheckCommand('')).toBe(false)
  })
})

describe('shouldRedirectToTypecheck — one-shot escape hatch', () => {
  beforeEach(() => resetTypecheckRedirectMemoForTesting())

  test('refuses once, then runs the identical command', () => {
    expect(shouldRedirectToTypecheck('bun run typecheck')).toBe(true)
    expect(shouldRedirectToTypecheck('bun run typecheck')).toBe(false)
  })

  test('tracks commands independently', () => {
    expect(shouldRedirectToTypecheck('bun run typecheck')).toBe(true)
    expect(shouldRedirectToTypecheck('cargo check')).toBe(true)
  })

  test('never memoizes a command it would not refuse', () => {
    expect(shouldRedirectToTypecheck('git status')).toBe(false)
    expect(shouldRedirectToTypecheck('git status')).toBe(false)
  })

  test('evicts the oldest entry rather than growing without bound', () => {
    expect(shouldRedirectToTypecheck('tsc --noEmit')).toBe(true)
    for (let i = 0; i < MEMO_LIMIT; i++) {
      expect(shouldRedirectToTypecheck(`tsc --noEmit src/f${i}.ts`)).toBe(true)
    }
    // The first entry aged out, so it is armed again — which is the intended
    // trade: a bounded set that never silently stops refusing.
    expect(shouldRedirectToTypecheck('tsc --noEmit')).toBe(true)
  })
})

describe('renderTypecheckRedirect', () => {
  test('names the tool, the exact command to pass, and the escape hatch', () => {
    const message = renderTypecheckRedirect('bun run typecheck')
    expect(message).toContain('Typecheck')
    expect(message).toContain('"bun run typecheck"')
    expect(message).toContain('re-send this exact Bash command')
  })

  test('explains the dropped filter only when there was one', () => {
    expect(renderTypecheckRedirect('tsc --noEmit')).not.toContain('output filter is dropped')
    expect(renderTypecheckRedirect('tsc --noEmit | tail -5')).toContain(
      'output filter is dropped',
    )
  })
})
