import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from '../repoRoot'
import { smokeBinary } from './smoke-binary'

const fakes = mkdtempSync(join(tmpdir(), 'smoke-binary-test-'))
afterAll(() => rmSync(fakes, { recursive: true, force: true }))

// A "binary" is a bun script behind a shebang, so it runs the way the copy does.
function fakeBinary(name: string, body: string): string {
  const path = join(fakes, name)
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const answerFromMock = `
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST' })
console.log(await res.text())
`

describe.skipIf(process.platform === 'win32')('smokeBinary', () => {
  test('passes a binary that prints the text the mock streamed', async () => {
    const result = await smokeBinary(fakeBinary('answers', answerFromMock), 20_000)
    expect(result).toEqual({ ok: true, detail: 'answered (1 request(s) to the mock)' })
  })

  test('fails a binary that only knows its version, which is all --version checks', async () => {
    const result = await smokeBinary(fakeBinary('version-only', `console.log('1.1.46 (Claudin)')`), 20_000)
    expect(result.ok).toBe(false)
    expect(result.detail).toStartWith('exit 0 without the mock’s answer, 0 request(s)')
  })

  test('fails a binary that crashes at startup, and shows the error', async () => {
    const crash = `throw new TypeError("undefined is not an object (evaluating 'getFsImplementation().existsSync')")`
    const result = await smokeBinary(fakeBinary('crashes', crash), 20_000)
    expect(result.ok).toBe(false)
    expect(result.detail).toStartWith('exit 1, 0 request(s)')
    expect(result.detail).toContain('getFsImplementation().existsSync')
  })

  test('runs a copy outside the checkout, from a cwd outside it', async () => {
    const guard = `
if (process.cwd().startsWith(${JSON.stringify(REPO_ROOT)})) process.exit(3)
if (import.meta.path.startsWith(${JSON.stringify(fakes)})) process.exit(4)
${answerFromMock}`
    const result = await smokeBinary(fakeBinary('guarded', guard), 20_000)
    expect(result.detail).toBe('answered (1 request(s) to the mock)')
  })

  test('kills a binary that never answers', async () => {
    const result = await smokeBinary(fakeBinary('hangs', 'setInterval(() => {}, 1000)'), 500)
    expect(result.ok).toBe(false)
    expect(result.detail).toStartWith('timed out after 500 ms')
  })
})
