import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import * as ripgrep from 'src/shared/fs/ripgrep.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { glob, type GlobOptions } from 'src/shared/fs/glob.js'

// How far ripgrep walks for an anchored pattern. The cases are the three
// Globs that timed out after 20 s in ferrous-dns sub-agents (2026-11-08/09):
// from the repo root ripgrep walked the 101G `target/` before it could answer.
// The results never changed — the walk did — so these tests watch the walk
// itself (the directory ripgrep runs in, and its --max-depth) as well as the
// paths that come back.

const permissionContext = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  isBypassPermissionsModeAvailable: true,
} as unknown as ToolPermissionContext

type Walk = { cwd: string | undefined; maxDepth: number | undefined }

let root: string
let walks: Walk[]
const realRipGrep = ripgrep.ripGrepWithStatus

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'glob-walk-'))
  const files = [
    'migrations/20261106_doh_ids.sql',
    'migrations/20261108_doh_client_id.sql',
    'migrations/old/20250101_init.sql',
    'crates/application/src/use_cases/client_subnets/mod.rs',
    'crates/application/src/use_cases/client_subnets/list.rs',
    'crates/application/src/use_cases/client_subnets/deep/inner.rs',
    'crates/infrastructure/src/repositories/query_log_repository/reader.rs',
    'crates/infrastructure/src/repositories/query_log_repository/rollup/writer.rs',
    'crates/infrastructure/src/lib.rs',
    // The decoy: what a build tree holds, the same names one level down.
    'target/debug/migrations/20261106_doh_ids.sql',
    'target/debug/crates/application/src/use_cases/client_subnets/mod.rs',
    'target/debug/crates/infrastructure/src/repositories/query_log_repository/reader.rs',
    'web/app.ts',
    'web/deep/view.ts',
  ]
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'x')
  }
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

afterEach(() => {
  ;(ripgrep.ripGrepWithStatus as unknown as { mockRestore?: () => void }).mockRestore?.()
})

async function run(pattern: string, options: Partial<GlobOptions> = {}): Promise<string[]> {
  walks = []
  spyOn(ripgrep, 'ripGrepWithStatus').mockImplementation(async (args, target, signal, opts) => {
    const at = args.indexOf('--max-depth')
    walks.push({ cwd: opts?.cwd, maxDepth: at >= 0 ? Number(args[at + 1]) : undefined })
    return realRipGrep(args, target, signal, opts)
  })
  const { files } = await glob(
    pattern,
    root,
    { limit: 100, offset: 0, sort: 'path', ...options },
    new AbortController().signal,
    permissionContext,
  )
  return files.map(f => f.slice(root.length + 1))
}

describe('the census patterns walk from their literal base', () => {
  test('b9606a6b 11-08: crates/…/client_subnets/*.rs reads one directory', async () => {
    expect(await run('crates/application/src/use_cases/client_subnets/*.rs')).toEqual([
      'crates/application/src/use_cases/client_subnets/list.rs',
      'crates/application/src/use_cases/client_subnets/mod.rs',
    ])
    expect(walks).toEqual([
      { cwd: join(root, 'crates/application/src/use_cases/client_subnets'), maxDepth: 1 },
    ])
  })

  test('30177640 11-09: crates/…/query_log_repository/**/*.rs walks only that subtree', async () => {
    expect(await run('crates/infrastructure/src/repositories/query_log_repository/**/*.rs')).toEqual([
      'crates/infrastructure/src/repositories/query_log_repository/reader.rs',
      'crates/infrastructure/src/repositories/query_log_repository/rollup/writer.rs',
    ])
    expect(walks).toEqual([
      { cwd: join(root, 'crates/infrastructure/src/repositories/query_log_repository'), maxDepth: undefined },
    ])
  })

  test('30177640 11-09: migrations/*.sql reads migrations/ and nothing below it', async () => {
    expect(await run('migrations/*.sql')).toEqual([
      'migrations/20261106_doh_ids.sql',
      'migrations/20261108_doh_client_id.sql',
    ])
    expect(walks).toEqual([{ cwd: join(root, 'migrations'), maxDepth: 1 }])
  })

  test('the same bound holds when the caller respects .gitignore', async () => {
    expect(await run('migrations/*.sql', { respectGitignore: true })).toEqual([
      'migrations/20261106_doh_ids.sql',
      'migrations/20261108_doh_client_id.sql',
    ])
    expect(walks).toEqual([{ cwd: join(root, 'migrations'), maxDepth: 1 }])
  })
})

describe('what must not change', () => {
  test('a pattern with no slash still matches at any depth, from the root', async () => {
    expect(await run('*.ts')).toEqual(['web/app.ts', 'web/deep/view.ts'])
    expect(walks).toEqual([{ cwd: root, maxDepth: undefined }])
  })

  test('maxDepth still counts from the root the caller named', async () => {
    expect(await run('crates/**/*.rs', { maxDepth: 4 })).toEqual(['crates/infrastructure/src/lib.rs'])
    expect(await run('crates/application/src/*.rs', { maxDepth: 2 })).toEqual([])
  })

  test('an exclude written from the root still applies under the base', async () => {
    expect(await run('crates/**/*.rs', { exclude: ['crates/application/**'] })).toEqual([
      'crates/infrastructure/src/lib.rs',
      'crates/infrastructure/src/repositories/query_log_repository/reader.rs',
      'crates/infrastructure/src/repositories/query_log_repository/rollup/writer.rs',
    ])
  })

  test('a directory listing under a base', async () => {
    expect(await run('crates/*/src', { type: 'dir' })).toEqual([
      'crates/application/src',
      'crates/infrastructure/src',
    ])
  })

  test('a base that does not exist matches nothing', async () => {
    expect(await run('crates/nope/*.rs')).toEqual([])
  })
})
