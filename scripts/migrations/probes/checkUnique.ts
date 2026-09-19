// Throwaway: assert every probe `find` in a spec matches its source exactly
// once, so `break-probe.ts` never spends a suite run on a refused probe.
// Deleted with the rest of the split scaffolding.

import { readFileSync } from 'node:fs'

type Spec = {
  source: string
  probes: { name: string; find: string; source?: string }[]
}

const specPath = process.argv[2]
if (!specPath) {
  console.error('usage: checkUnique.ts <spec.json>')
  process.exit(2)
}
const spec: Spec = JSON.parse(readFileSync(specPath, 'utf8'))
const cache = new Map<string, string>()
let bad = 0

for (const probe of spec.probes) {
  const path = probe.source ?? spec.source
  if (!cache.has(path)) cache.set(path, readFileSync(path, 'utf8'))
  const hits = (cache.get(path) ?? '').split(probe.find).length - 1
  if (hits !== 1) {
    console.log(`BAD ${hits}  ${probe.name}`)
    bad++
  }
}

console.log(
  bad === 0
    ? `all ${spec.probes.length} finds match exactly once`
    : `${bad} of ${spec.probes.length} finds are not unique`,
)
process.exit(bad === 0 ? 0 : 1)
