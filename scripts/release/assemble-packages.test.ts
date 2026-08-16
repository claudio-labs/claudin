import { expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { REPO_ROOT } from '../repoRoot'

const root = REPO_ROOT

// The bin stub the wrapper publishes (bin/claudin.exe) is a Node shebang script
// that runs whenever postinstall didn't hardlink the native binary over it
// (e.g. `bun install -g`, which skips lifecycle scripts). It MUST load as
// CommonJS: under "type":"module" Node's ESM loader rejects the unknown .exe
// extension with ERR_UNKNOWN_FILE_EXTENSION *before the stub runs*, so `claudin`
// can't even launch to self-heal.

function runStubUnderType(pkgType: string | undefined): {
  code: number
  stderr: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'claudin-stub-'))
  try {
    writeFileSync(
      join(dir, 'claudin.exe'),
      '#!/usr/bin/env node\nprocess.stdout.write("ok:" + typeof require)\n',
    )
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(pkgType === undefined ? {} : { type: pkgType }),
    )
    try {
      const out = execFileSync('node', [join(dir, 'claudin.exe')], {
        encoding: 'utf8',
      })
      expect(out).toBe('ok:function')
      return { code: 0, stderr: '' }
    } catch (e) {
      const err = e as { status?: number; stderr?: string }
      return { code: err.status ?? 1, stderr: err.stderr ?? '' }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a .exe Node stub loads as CommonJS but crashes under type:module', () => {
  // Contract: this is the Node behavior the wrapper depends on. If a future
  // Node makes .exe loadable under ESM, this test flags that the workaround can
  // be revisited — it does not silently pass a broken published layout.
  expect(runStubUnderType('commonjs').code).toBe(0)
  expect(runStubUnderType(undefined).code).toBe(0)

  const asModule = runStubUnderType('module')
  expect(asModule.code).not.toBe(0)
  expect(asModule.stderr).toContain('ERR_UNKNOWN_FILE_EXTENSION')
})

test('assemble-packages publishes the wrapper as CommonJS, not module', () => {
  const source = readFileSync(join(import.meta.dir, 'assemble-packages.ts'), 'utf8')
  // The wrapper object still points its bin at the .exe stub…
  expect(source).toContain("bin: { claudin: './bin/claudin.exe' }")
  // …so it must pin type to commonjs and never inherit rootPkg.type ("module").
  expect(source).toContain("type: 'commonjs'")
  expect(source).not.toContain('type: rootPkg.type')
})

test('the shipped bin stub is CommonJS (uses require, no import/export)', () => {
  const stub = readFileSync(join(root, 'bin', 'claudin.exe'), 'utf8')
  expect(stub).toContain('require(')
  expect(stub).not.toMatch(/^\s*import\s/m)
  expect(stub).not.toMatch(/^\s*export\s/m)
})
