/**
 * The units of the clean-base rewrite, as the tools in this directory read
 * them. docs/tech/rewrite/README.md is the process; units/phase-<n>.json lists
 * each phase's units: the inherited files a unit replaces, and the inherited
 * tests its own suite replaces.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Unit = {
  /** `<slice>/<name>`, as in `vcs/git`. */
  name: string
  files: string[]
  tests: string[]
}

type PhaseFile = Record<string, { files: string[]; tests?: string[] }>

const UNITS_DIR = join(import.meta.dir, 'units')

/**
 * Where sandboxes are made. Each is a full copy of the tree, so keep it on a
 * disk with room; a tmpfs is wiped on reboot, which only costs a rebuild.
 */
export const SANDBOX_ROOT = process.env.REWRITE_SANDBOX_ROOT ?? join(tmpdir(), 'claudin-rewrite-sandboxes')

export function loadUnits(): Unit[] {
  const units: Unit[] = []
  for (const file of readdirSync(UNITS_DIR).filter(f => f.endsWith('.json')).sort()) {
    const phase = JSON.parse(readFileSync(join(UNITS_DIR, file), 'utf8')) as PhaseFile
    for (const [name, unit] of Object.entries(phase)) {
      units.push({ name, files: unit.files, tests: unit.tests ?? [] })
    }
  }
  return units
}

export function findUnit(name: string): Unit {
  const unit = loadUnits().find(u => u.name === name)
  if (unit === undefined) throw new Error(`No unit named ${name} in ${UNITS_DIR}.`)
  return unit
}

/** `vcs/git` → `vcs-git`, for places where a slash would be a directory. */
export const unitSlug = (name: string): string => name.replace(/\//g, '-')

/** Written at characterization against the old code, rewritten with the implementation. */
export const probeSpecPath = (name: string): string =>
  `scripts/migrations/probes/rewrite-${unitSlug(name)}.json`

export const specPath = (name: string): string => `docs/tech/rewrite/${name}.md`

/** What `.base/.sandbox.json` records about how a sandbox was made. */
export type SandboxRecord = {
  mode: 'char' | 'impl' | 'bodies'
  unit: string
  sha: string
  /** Paths removed from the working copy, beyond the unit's own files. */
  removed: string[]
  /** `bodies` only: per unit file, what was stubbed and what was left for review. */
  stubs?: Record<
    string,
    {
      stubbed: { name: string; startLine: number; endLine: number }[]
      residue: number[]
      unlocated: { line: number; symbol: string | null }[]
      comments: number[]
    }
  >
}
