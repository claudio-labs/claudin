/**
 * Makes the sandbox for one step of a unit's rewrite (docs/tech/rewrite/README.md,
 * "The implementer's sandbox"):
 *
 *   bun run scripts/migrations/rewrite/sandbox.ts char <unit>
 *   bun run scripts/migrations/rewrite/sandbox.ts impl <unit>
 *
 * Both are a copy of HEAD with no .git, so no history can be read, and a
 * pristine copy of the same tree at `<sandbox>.base` for land.ts to diff
 * against. Sandboxes live under REWRITE_SANDBOX_ROOT.
 *
 * `char` keeps everything: the characterization needs the old code, and the
 * fingerprints to check that its own tests are clean.
 *
 * `impl` takes out whatever would put the old code in the implementer's
 * reach: the unit's files and inherited tests, the unit's probe spec (it
 * quotes the old lines), every other probe spec with a probe on those files,
 * the fingerprints, the team memory, and any doc or bench that names one of
 * the old code's private declarations. A private name found anywhere else is
 * only reported. Inside src/ it is usually an unrelated function with the
 * same name, and removing product code would break the build; in a rule file
 * or a rewrite spec it is a leak to fix by hand before the brief.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../../repoRoot.js'
import { findUnit, probeSpecPath, SANDBOX_ROOT, type SandboxRecord, specPath, unitSlug } from './units.js'

const PROBES_DIR = 'scripts/migrations/probes'

/** Declarations at the top of a file: `function x`, `const x`, `class x`, … */
const DECLARATION_RE =
  /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_LIST_RE = /^export\s*(?:type\s*)?\{([^}]*)\}/gm
/**
 * A name worth searching for: shaped like an identifier (`buildChain`,
 * `MAX_LINES`) rather than a word. `Transcript` alone names half the tree.
 */
const DISTINCTIVE_NAME_RE = /[a-z][A-Z]|_/

const SKIP_DIR_RE = /^(node_modules|dist|coverage|\.git)$/
const TEXT_FILE_RE = /\.(ts|tsx|js|mjs|cjs|md|json|txt|ya?ml|toml|snap)$/
/** Where a file naming a private declaration is taken out rather than only reported. */
const REMOVABLE_RE = /^(docs\/(?!tech\/rewrite\/)|scripts\/(bench|migrations)\/)/

function run(command: string, args: string[], input?: Buffer): Buffer {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, input, maxBuffer: 1024 ** 3 })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr?.toString() ?? ''}`)
  }
  return result.stdout
}

function privateNames(files: string[], root: string): string[] {
  const declared = new Set<string>()
  const exported = new Set<string>()
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(DECLARATION_RE)) (match[1] ? exported : declared).add(match[2]!)
    for (const match of source.matchAll(EXPORT_LIST_RE)) {
      for (const entry of match[1]!.split(',')) {
        const alias = entry.trim().split(/\s+as\s+/)
        exported.add(alias[0]!.replace(/^type\s+/, '').trim())
      }
    }
  }
  return [...declared].filter(name => !exported.has(name) && DISTINCTIVE_NAME_RE.test(name)).sort()
}

function textFiles(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_RE.test(entry)) continue
    const path = join(dir, entry)
    const stat = statSync(path, { throwIfNoEntry: false })
    if (stat?.isDirectory()) textFiles(root, path, out)
    else if (stat?.isFile() && TEXT_FILE_RE.test(entry) && stat.size < 4_000_000) out.push(relative(root, path))
  }
  return out
}

/** The probe specs, other than the unit's own, with a probe whose source is one of `files`. */
function probeSpecsTouching(files: string[], root: string, ownSpec: string): string[] {
  const targets = new Set(files)
  const specs: string[] = []
  for (const entry of readdirSync(join(root, PROBES_DIR))) {
    const spec = `${PROBES_DIR}/${entry}`
    if (!entry.endsWith('.json') || spec === ownSpec) continue
    const parsed = JSON.parse(readFileSync(join(root, spec), 'utf8')) as {
      source?: string
      probes?: { source?: string }[]
    }
    const sources = [parsed.source, ...(parsed.probes ?? []).map(p => p.source ?? parsed.source)]
    if (sources.some(source => source !== undefined && targets.has(source))) specs.push(spec)
  }
  return specs
}

const [mode, name] = process.argv.slice(2)
if ((mode !== 'char' && mode !== 'impl') || name === undefined) {
  console.error('usage: bun run scripts/migrations/rewrite/sandbox.ts <char|impl> <unit>')
  process.exit(2)
}
const unit = findUnit(name)

// The copy is taken from HEAD, so an uncommitted edit to the unit would be
// silently left out of it.
const dirty = run('git', ['status', '--porcelain', '--', ...unit.files, ...unit.tests]).toString().trim()
if (dirty !== '') {
  console.error(`Commit these first; the sandbox copies HEAD:\n${dirty}`)
  process.exit(1)
}

const sha = run('git', ['rev-parse', 'HEAD']).toString().trim()
const sandbox = join(SANDBOX_ROOT, `${mode}-${unitSlug(name)}`)
const base = `${sandbox}.base`
rmSync(sandbox, { recursive: true, force: true })
rmSync(base, { recursive: true, force: true })
const tree = run('git', ['archive', '--format=tar', sha])
for (const dir of [sandbox, base]) {
  mkdirSync(dir, { recursive: true })
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: tree })
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr.toString()}`)
}
symlinkSync(join(REPO_ROOT, 'node_modules'), join(sandbox, 'node_modules'))

const removed: string[] = []
const reported: string[] = []
if (mode === 'impl') {
  const remove = (path: string) => {
    if (!existsSync(join(sandbox, path))) return
    rmSync(join(sandbox, path), { recursive: true, force: true })
    removed.push(path)
  }
  const ownSpec = probeSpecPath(name)
  for (const path of [...unit.files, ...unit.tests, ownSpec, 'scripts/verify/provenance/fingerprints.bin', '.claudin/memory']) {
    remove(path)
  }
  for (const spec of probeSpecsTouching(unit.files, base, ownSpec)) remove(spec)

  const names = privateNames(unit.files, base)
  if (names.length > 0) {
    const nameRe = new RegExp(`\\b(${names.map(n => n.replace(/\$/g, '\\$')).join('|')})\\b`, 'g')
    for (const file of textFiles(sandbox)) {
      const found = new Set(readFileSync(join(sandbox, file), 'utf8').match(nameRe) ?? [])
      if (found.size === 0) continue
      const line = `${file}: ${[...found].join(', ')}`
      if (REMOVABLE_RE.test(file)) remove(file)
      else reported.push(file === specPath(name) ? `SPEC LEAK ${line}` : line)
    }
  }
}

const record: SandboxRecord = { mode, unit: name, sha, removed }
writeFileSync(join(base, '.sandbox.json'), `${JSON.stringify(record, null, 2)}\n`)

console.log(sandbox)
if (removed.length > 0) console.log(`removed (${removed.length}):\n  ${removed.join('\n  ')}`)
if (reported.length > 0) console.log(`private names still in the sandbox, review before the brief:\n  ${reported.join('\n  ')}`)
