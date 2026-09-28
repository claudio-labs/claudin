/**
 * Shared helpers for the `sessions/lifecycle` characterization suites.
 *
 * - `envSnapshot` records environment variables and puts them back, deleting
 *   the ones that were unset rather than storing the string "undefined".
 * - `eventually` polls for effects the code under test starts without
 *   awaiting (a record patched after a session switch, a stale file swept).
 * - `runInFreshProcess` runs a snippet as the only test of a new `bun test`
 *   process. Some behaviour exists once per process (a promise that settles
 *   on the first registration, cleanups that run at shutdown, a file watcher
 *   that is never torn down), and only a process of its own can show it
 *   without leaving that state behind in the suite's process.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

export type EnvSnapshot = { restore(): void }

export function envSnapshot(keys: readonly string[]): EnvSnapshot {
  const saved = new Map(keys.map(key => [key, process.env[key]] as const))
  return {
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

export async function eventually<T>(
  read: () => T,
  accept: (value: T) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = read()
  while (!accept(value) && Date.now() < deadline) {
    await Bun.sleep(20)
    value = read()
  }
  return value
}

/**
 * Run `body` inside an async function of a fresh `bun test` process started
 * from the repo root, so the test preload applies. The body reaches the
 * repo's modules through `load('<repo-relative path>')`, and whatever it
 * returns comes back as parsed JSON. `workDir` receives the generated test
 * file and the result.
 */
export async function runInFreshProcess(
  body: string,
  env: Record<string, string>,
  workDir: string,
): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(workDir, 'fresh-'))
  const resultFile = join(dir, 'result.json')
  const testFile = join(dir, 'fresh.test.ts')
  const source = [
    `import { test } from 'bun:test'`,
    `import { writeFileSync } from 'fs'`,
    `const load = (path: string) => import(${JSON.stringify(`${REPO_ROOT}/`)} + path)`,
    `test('fresh process', async () => {`,
    `  const result = await (async () => {`,
    body,
    `  })()`,
    `  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(result))`,
    `}, 30_000)`,
  ]
  writeFileSync(testFile, source.join('\n'))
  const child = Bun.spawn(['bun', 'test', testFile], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (!existsSync(resultFile)) {
    throw new Error(`the fresh process left no result:\n${stdout}\n${stderr}`)
  }
  return JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, unknown>
}
