/**
 * Claudin runs MCP on the split v2 packages (`@modelcontextprotocol/client`,
 * `/server`, `/core`). The 1.x `@modelcontextprotocol/sdk` is a devDependency
 * kept only so tests can stand up realistic legacy servers and clients; an
 * import of it from shipped code would bundle a second MCP stack, and would
 * fail for anyone installing without devDependencies.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from 'bun:test'

const SRC = join(import.meta.dir, '..')
const V1_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]@modelcontextprotocol\/sdk(?:\/[^'"]*)?['"]/m
const TEST_ONLY_RE = /\.test\.tsx?$|(?:^|\/)__testutils__\//

test('only tests and test harnesses import the 1.x MCP SDK', () => {
  const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: SRC })]
  // A listing that found nothing would pass while checking nothing.
  expect(files.length).toBeGreaterThan(1000)

  const offenders = files.filter(
    file => !TEST_ONLY_RE.test(file) && V1_IMPORT_RE.test(readFileSync(join(SRC, file), 'utf8')),
  )
  expect(offenders).toEqual([])
})

test('the check sees each import form', () => {
  for (const line of [
    "import { Client } from '@modelcontextprotocol/sdk/client/index.js'",
    "import type { Tool } from \"@modelcontextprotocol/sdk/types.js\"",
    "const m = await import('@modelcontextprotocol/sdk/types.js')",
    "const m = require('@modelcontextprotocol/sdk')",
    "import '@modelcontextprotocol/sdk/server/index.js'",
  ]) {
    expect(V1_IMPORT_RE.test(line)).toBe(true)
  }
  expect(V1_IMPORT_RE.test("import { Client } from '@modelcontextprotocol/client'")).toBe(false)
  expect(V1_IMPORT_RE.test('// JSONRPCMessage from @modelcontextprotocol/sdk - treat as unknown')).toBe(false)
})
