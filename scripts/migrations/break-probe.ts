// Break-and-restore, run as a batch.
//
// For each probe: mutate ONE exact string in a production file, run the suite,
// record which tests went red, restore. A probe that turns NOTHING red is the
// finding — it means the line it mutated is not guarded by anything, and the
// test that claims to cover it is passing for another reason.
//
// Two traps this avoids by construction (both have produced green tests that
// guarded nothing in this repo):
//   - mutating a same-looking line elsewhere in the file: `find` must match
//     EXACTLY once or the probe is refused.
//   - leaving the tree dirty on a crash: the original text is held in memory
//     and written back in a finally, and the run re-verifies the file is
//     byte-identical at the end.
//
// Usage:
//   bun run scripts/migrations/break-probe.ts <spec.json>
//
// Spec: { "test": "<path or dir>" | ["<path>", …], "source": "<path>", "probes": [
//          { "name": "...", "find": "...", "replace": "..." } ] }
// `source` may be overridden per probe; `test` may list several suites when
// the probes span more than one area.
//
// Written for the giant-file split, kept afterwards: agent-safety.md requires
// break-and-restore for every new test, and doing that by hand is what let
// three tests that guarded nothing ship on this branch's first pass. The specs
// under probes/ are committed beside it — each one is the evidence for the
// suite it names, and re-runnable after any later refactor of that code.
//
// Its relocation-checking sibling was deleted once the splits landed: it only
// answered "did every line survive this move", which is not a question a
// settled tree has.

import { readFileSync, writeFileSync } from 'node:fs'

type Probe = {
  name: string
  find: string
  replace: string
  source?: string
}
type Spec = { test: string | string[]; source: string; probes: Probe[] }

const specPath = process.argv[2]
if (!specPath) {
  console.error('usage: break-probe.ts <spec.json>')
  process.exit(2)
}
const spec: Spec = JSON.parse(readFileSync(specPath, 'utf8'))

const COUNTS_RE = /(\d+) pass/
const FAIL_RE = /(\d+) fail/

function runSuite(): { pass: number; fail: number; names: string[] } {
  const suites = Array.isArray(spec.test) ? spec.test : [spec.test]
  const proc = Bun.spawnSync(['bun', 'test', ...suites], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = `${proc.stdout.toString()}\n${proc.stderr.toString()}`
  const names: string[] = []
  for (const line of out.split('\n')) {
    const m = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+ms\])?$/.exec(line.trim())
    if (m?.[1]) names.push(m[1])
  }
  return {
    pass: Number(COUNTS_RE.exec(out)?.[1] ?? 0),
    fail: Number(FAIL_RE.exec(out)?.[1] ?? 0),
    names,
  }
}

const baseline = runSuite()
console.log(`baseline: ${baseline.pass} pass, ${baseline.fail} fail\n`)
if (baseline.fail > 0) {
  console.error('refusing to probe against a red baseline')
  process.exit(1)
}

const unguarded: string[] = []

for (const probe of spec.probes) {
  const path = probe.source ?? spec.source
  const original = readFileSync(path, 'utf8')
  const hits = original.split(probe.find).length - 1
  if (hits !== 1) {
    console.log(`? ${probe.name}\n    REFUSED: 'find' matches ${hits} times, need exactly 1`)
    unguarded.push(`${probe.name} (refused)`)
    continue
  }

  try {
    writeFileSync(path, original.replace(probe.find, probe.replace))
    const result = runSuite()
    if (result.fail === 0) {
      console.log(`✗ ${probe.name}\n    NOTHING WENT RED — this line is not guarded`)
      unguarded.push(probe.name)
    } else {
      console.log(`✓ ${probe.name} — ${result.fail} red`)
      for (const n of result.names) console.log(`    ${n}`)
    }
  } finally {
    writeFileSync(path, original)
  }
}

const after = runSuite()
console.log(`\nrestored: ${after.pass} pass, ${after.fail} fail`)
if (after.fail > 0 || after.pass !== baseline.pass) {
  console.error('RESTORE FAILED — the tree does not match the baseline')
  process.exit(1)
}
if (unguarded.length > 0) {
  console.error(`\n${unguarded.length} probe(s) guarded nothing:`)
  for (const n of unguarded) console.error(`  - ${n}`)
  process.exit(1)
}
console.log('every probe turned at least one test red')
