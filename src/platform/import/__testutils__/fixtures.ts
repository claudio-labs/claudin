/**
 * Builds a throwaway `$HOME` and project directory for adapter tests.
 *
 * Everything an adapter reads comes from its injected `CollectContext`, so a
 * fixture is enough to exercise a whole agent end to end without touching the
 * developer's real config and without a single `mock.module`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import type {
  CollectContext,
  ImportArtifact,
  ImportArtifactKind,
  ImportPlan,
} from 'src/platform/import/types.js'

export type FixtureSpec = {
  /** Files under the fake `$HOME`, keyed by path relative to it. */
  home?: Record<string, string>
  /** Files under the fake project directory. */
  project?: Record<string, string>
  env?: Record<string, string | undefined>
}

export type Fixture = CollectContext & {
  /** Absolute path of a file written under the fake home. */
  homePath: (relative: string) => string
  projectPath: (relative: string) => string
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, contents, 'utf8')
  }
}

export function makeFixture(spec: FixtureSpec = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'claudin-import-fixture-'))
  const homeDir = join(root, 'home')
  const cwd = join(root, 'project')
  const claudinHomeDir = join(homeDir, '.claudin')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })

  writeTree(homeDir, spec.home ?? {})
  writeTree(cwd, spec.project ?? {})

  return {
    homeDir,
    cwd,
    claudinHomeDir,
    env: spec.env ?? {},
    homePath: relative => join(homeDir, relative),
    projectPath: relative => join(cwd, relative),
  }
}

export function artifactsOfKind<K extends ImportArtifactKind>(
  plan: ImportPlan,
  kind: K,
): Extract<ImportArtifact, { kind: K }>[] {
  return plan.artifacts.filter(
    (artifact): artifact is Extract<ImportArtifact, { kind: K }> =>
      artifact.kind === kind,
  )
}

export function artifactNames(plan: ImportPlan, kind: ImportArtifactKind): string[] {
  return plan.artifacts
    .filter(artifact => artifact.kind === kind)
    .map(artifact =>
      'name' in artifact ? artifact.name : 'key' in artifact ? artifact.key : '',
    )
    .sort()
}
