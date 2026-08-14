import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ExecResult } from 'src/utils/ShellCommand.js'
import { readFullShellOutput } from './fullOutput.js'

const dir = mkdtempSync(join(tmpdir(), 'claudin-full-output-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function result(overrides: Partial<ExecResult>): ExecResult {
  return { stdout: '', stderr: '', code: 0, interrupted: false, ...overrides }
}

describe('readFullShellOutput', () => {
  test('returns the inline stdout when the command produced no spill file', () => {
    expect(readFullShellOutput(result({ stdout: 'short output' }))).resolves.toBe('short output')
  })

  test('prefers the spill file over the truncated stdout', async () => {
    // This is the whole point: `result.stdout` is capped at
    // BASH_MAX_OUTPUT_LENGTH, so anything that PARSES output would otherwise
    // summarise a large run from its first few hundred lines and report counts
    // that look plausible.
    const path = join(dir, 'spill.txt')
    const full = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
    writeFileSync(path, full)

    const text = await readFullShellOutput(
      result({ stdout: full.slice(0, 30_000), outputFilePath: path }),
    )
    expect(text).toBe(full)
    expect(text.length).toBeGreaterThan(30_000)
  })

  test('falls back to stdout when the spill file cannot be read', async () => {
    // Degraded is acceptable here; throwing would turn a readable-but-truncated
    // result into no result at all.
    const text = await readFullShellOutput(
      result({ stdout: 'fallback', outputFilePath: join(dir, 'missing.txt') }),
    )
    expect(text).toBe('fallback')
  })
})
