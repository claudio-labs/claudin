import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { formatCheckResult } from './budget.js'
import { resolveCheckCommand, TypecheckTool } from './TypecheckTool.js'
import type { CheckResult } from './types.js'

const roots: string[] = []

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'claudin-typecheck-tool-'))
  roots.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('resolveCheckCommand', () => {
  test('an explicit command is honoured verbatim, plus the machine-format flag', () => {
    const resolved = runWithCwdOverride(project(), () =>
      resolveCheckCommand({ command: 'tsc --noEmit' }),
    )
    expect(resolved).toEqual({ command: 'tsc --noEmit --pretty false', checker: 'tsc' })
  })

  test('a project with nothing to check resolves to nothing', () => {
    expect(runWithCwdOverride(project(), () => resolveCheckCommand({}))).toBeNull()
  })

  test('an override for a checker this project does not have resolves to nothing', () => {
    // Rather than silently running the detected checker's command and parsing
    // its output with the wrong parser.
    const root = project({ 'tsconfig.json': '{}', 'node_modules/.bin/tsc': '#!/bin/sh\n' })
    expect(runWithCwdOverride(root, () => resolveCheckCommand({ checker: 'cargo' }))).toBeNull()
  })
})

describe('TypecheckTool.call — nothing to run', () => {
  const context = { abortController: new AbortController() } as Parameters<
    typeof TypecheckTool.call
  >[1]

  async function callIn(root: string, input: Parameters<typeof TypecheckTool.call>[0]) {
    return runWithCwdOverride(root, async () => {
      const { data } = await TypecheckTool.call(input, context)
      return data as CheckResult
    })
  }

  test('reports an actionable error instead of an empty green result', async () => {
    // The failure mode to avoid: "0 errors" for a project that was never
    // checked at all reads exactly like a passing check.
    const result = await callIn(project(), {})
    expect(result.runError).toContain('Could not detect a type checker')
    expect(formatCheckResult(result)).toStartWith('Typecheck could not run')
  })

  test('an unavailable override names that checker, not detection in general', async () => {
    const root = project({ 'tsconfig.json': '{}', 'node_modules/.bin/tsc': '#!/bin/sh\n' })
    const result = await callIn(root, { checker: 'cargo' })
    expect(result.runError).toContain('no cargo setup')
  })
})
