// Regression test for the open-build sandbox-stub bug.
//
// The open build replaces @anthropic-ai/sandbox-runtime with a Proxy whose
// `get` trap returns `() => null` for every property — see
// scripts/build/build.ts:339-356. Calling
// SandboxManager.annotateStderrWithSandboxFailures(command, rawOutput) on that
// stub therefore returns `null`, not a string.
//
// Before the fix, BashTool fed that `null` into `new ShellError('', null, ...)`.
// `getErrorParts()` ran `parts.filter(Boolean).join('\n')`, dropping the null
// stderr and yielding only "Exit code N" — every `bun test src/x.test.ts`,
// `bun run build` failure, or other exit≠0 command lost its stdout and stderr
// before reaching the model.
//
// `safeAnnotateStderrWithSandboxFailures` falls back to the raw output when
// SandboxManager returns anything other than a string. This test pins that
// contract by monkey-patching the SandboxManager export.

import { afterEach, describe, expect, test } from 'bun:test'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import { safeAnnotateStderrWithSandboxFailures } from 'src/tools/BashTool/BashTool.js'

const original = SandboxManager.annotateStderrWithSandboxFailures

afterEach(() => {
  SandboxManager.annotateStderrWithSandboxFailures = original
})

describe('safeAnnotateStderrWithSandboxFailures', () => {
  test('returns the rawOutput when SandboxManager stub returns null', () => {
    // Reproduces the open-build noop stub: () => null for every method.
    SandboxManager.annotateStderrWithSandboxFailures = (() => null) as unknown as typeof original

    const rawOutput =
      'bun test v1.3.11\nThe following filters did not match any test files\nnote: ...\n'
    const result = safeAnnotateStderrWithSandboxFailures(
      'bun test src/nao_existe.test.ts',
      rawOutput,
    )

    expect(result).toBe(rawOutput)
  })

  test('returns the rawOutput when SandboxManager stub returns undefined', () => {
    SandboxManager.annotateStderrWithSandboxFailures = (() => undefined) as unknown as typeof original

    const result = safeAnnotateStderrWithSandboxFailures('cmd', 'real stderr output')

    expect(result).toBe('real stderr output')
  })

  test('returns the rawOutput when SandboxManager stub returns a non-string object', () => {
    // The Proxy-based stub in scripts/build/build.ts:356 routes every `get` to the
    // same `() => null` noop, but a future stub could just as easily return
    // {} or a number — the fallback must hold for any non-string.
    SandboxManager.annotateStderrWithSandboxFailures = (() => ({} as unknown as string)) as unknown as typeof original

    const result = safeAnnotateStderrWithSandboxFailures('cmd', 'stderr lines here')

    expect(result).toBe('stderr lines here')
  })

  test('preserves the annotated string when the real implementation returns one', () => {
    // The real sandbox-runtime returns the (possibly annotated) stderr string.
    // We must not clobber that with rawOutput — the fallback only kicks in for
    // non-strings.
    SandboxManager.annotateStderrWithSandboxFailures = ((_cmd: string, stderr: string) =>
      `${stderr}\n[annotated by sandbox]`) as unknown as typeof original

    const result = safeAnnotateStderrWithSandboxFailures('cmd', 'underlying output')

    expect(result).toBe('underlying output\n[annotated by sandbox]')
  })

  test('returns an empty string when the rawOutput itself is empty (no synthetic content)', () => {
    SandboxManager.annotateStderrWithSandboxFailures = (() => null) as unknown as typeof original

    const result = safeAnnotateStderrWithSandboxFailures('cmd', '')

    expect(result).toBe('')
  })
})
