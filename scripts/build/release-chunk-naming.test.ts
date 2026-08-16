import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../repoRoot'

// ---------------------------------------------------------------------------
// Guard: release builds (CLAUDIN_RELEASE_BUILD=1) embed the package version
// into chunk filenames so a stack trace like `cli-0.1.5-abc123.mjs:42`
// identifies the published release without requiring sourcemaps. Local dev
// builds keep the shorter `cli-abc123.mjs` form.
//
// Codifies the env-gated `naming.chunk` template in scripts/build/build.ts so a
// future refactor of the build config doesn't silently revert the release
// behavior. Pure source assertion — no rebuild needed.
//
// See ROADMAP.md item 5.5.
// ---------------------------------------------------------------------------

const buildSrc = readFileSync(join(__dirname, 'build.ts'), 'utf-8')
const pkg = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
)

describe('release chunk naming', () => {
  test('build.ts gates chunk naming on CLAUDIN_RELEASE_BUILD', () => {
    expect(buildSrc).toContain("process.env.CLAUDIN_RELEASE_BUILD === '1'")
  })

  test('release branch interpolates the package version into the template', () => {
    expect(buildSrc).toMatch(
      /chunks\/\[name\]-\$\{version\}-\[hash\]\.mjs/,
    )
  })

  test('local branch keeps the short [name]-buildId-[hash] template', () => {
    expect(buildSrc).toMatch(/chunks\/\[name\]-\$\{buildId\}-\[hash\]\.mjs/)
  })

  test('package.json build:release sets CLAUDIN_RELEASE_BUILD=1', () => {
    expect(pkg.scripts['build:release']).toContain(
      'CLAUDIN_RELEASE_BUILD=1',
    )
  })
})
