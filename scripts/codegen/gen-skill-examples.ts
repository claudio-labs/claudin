/**
 * Regenerates src/skills/bundled/verifyRunExamples.ts from the captured
 * example markdown under src/skills/bundled/__fixtures__/skill-examples/.
 *
 * Those files used to live under docs/plans/ (now docs/archive/plans/), where
 * they looked like plan residue; they are build inputs — the module generated
 * from them ships in the bundle.
 *
 * The /verify and /run bundled skills carry their examples/*.md as `files:`
 * entries (extracted to disk on first invocation). We store the content
 * base64-encoded so the markdown — which contains backticks and ${...}
 * template-literal syntax — survives bundling without escaping hazards.
 *
 * Run:  bun run scripts/codegen/gen-skill-examples.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const CAPTURED = 'src/skills/bundled/__fixtures__/skill-examples'
const OUT = 'src/skills/bundled/verifyRunExamples.ts'

function encodeDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(dir).sort()) {
    out[`examples/${f}`] = readFileSync(join(dir, f), 'utf8')
  }
  return out
}

function toBase64(rec: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(rec).map(([k, v]) => [
      k,
      Buffer.from(v, 'utf8').toString('base64'),
    ]),
  )
}

function emit(name: string, rec: Record<string, string>): string {
  const entries = Object.entries(toBase64(rec))
    .map(([k, v]) => `  ${JSON.stringify(k)}: d(\n    ${JSON.stringify(v)},\n  ),`)
    .join('\n')
  return `export const ${name}: Record<string, string> = {\n${entries}\n}\n`
}

const verify = encodeDir(`${CAPTURED}/verify-examples`)
const run = encodeDir(`${CAPTURED}/run-examples`)

const header = `// AUTO-GENERATED from src/skills/bundled/__fixtures__/skill-examples/{verify,run}-examples/.
// Regenerate with scripts/codegen/gen-skill-examples.ts. Do not edit by hand.
// Example files are carried as base64 so backticks/template-literals in the
// captured markdown survive bundling without escaping hazards.

function d(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8")
}

`

writeFileSync(OUT, header + emit('VERIFY_EXAMPLE_FILES', verify) + '\n' + emit('RUN_EXAMPLE_FILES', run))
// eslint-disable-next-line no-console
console.log(`wrote ${OUT}`)
