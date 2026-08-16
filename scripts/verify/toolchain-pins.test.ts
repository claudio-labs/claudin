import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../repoRoot'

/**
 * `.node-version` and `.bun-version` are the toolchain pins. Six setup-bun
 * steps read `.bun-version` through `bun-version-file`, so they cannot drift —
 * but three things still can, and each one fails quietly:
 *
 *   - the two `oven/bun:<v>-alpine` image tags, which a workflow cannot read
 *     from a file (`container:` resolves before checkout);
 *   - `.node-version` against the `engines.node` floor it is meant to mirror;
 *   - the pin files themselves, if someone writes a range like `1.3.x`, which
 *     is a valid setup-bun *input* but pins nothing.
 */
describe('toolchain pins', () => {
  const root = REPO_ROOT
  const read = (name: string) => readFileSync(join(root, name), 'utf8')
  const bunVersion = read('.bun-version').trim()
  const nodeVersion = read('.node-version').trim()

  const workflowDir = join(root, '.github', 'workflows')
  const workflows = readdirSync(workflowDir)
    .filter(f => f.endsWith('.yml'))
    .map(f => ({ name: f, body: readFileSync(join(workflowDir, f), 'utf8') }))

  test('both pins are exact versions, not ranges', () => {
    // A range resolves to "whatever is newest today", which is the thing a pin
    // exists to prevent — and mise/proto reject it outright.
    expect(bunVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('.node-version is the engines.node floor', () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } }
    // PR CI installs this exact version so a PR cannot use an API the floor
    // lacks. If the floor moves, this file has to move with it.
    expect(pkg.engines?.node).toBe(`>=${nodeVersion}`)
  })

  test('every oven/bun image tag matches .bun-version', () => {
    const tags = workflows.flatMap(({ name, body }) =>
      [...body.matchAll(/oven\/bun:(\d+\.\d+\.\d+)-/g)].map(m => `${name}: ${m[1]}`),
    )
    // Not a smoke test of the regex: these two tags are the reason this file
    // exists, so assert they were found at all.
    expect(tags.length).toBeGreaterThan(0)
    expect(tags.filter(t => !t.endsWith(`: ${bunVersion}`))).toEqual([])
  })

  test('no workflow pins Bun inline instead of reading the file', () => {
    const inline = workflows.flatMap(({ name, body }) =>
      [...body.matchAll(/^\s*bun-version:\s*(\S+)/gm)].map(m => `${name}: ${m[1]}`),
    )
    expect(inline).toEqual([])
  })
})
