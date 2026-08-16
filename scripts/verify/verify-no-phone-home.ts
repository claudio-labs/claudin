import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
const ENTRY = 'dist/cli.mjs'
const BANNED_PATTERNS = [
  'datadoghq.com',
  'api/event_logging/batch',
  'api/claude_code/metrics',
  'getKubernetesNamespace',
  '/var/run/secrets/kubernetes',
  '/proc/self/mountinfo',
  'tengu_internal_record_permission_context',
  'anthropic-serve',
  'infra.ant.dev',
  'claude-code-feedback',
  'C07VBSHV7EV',
] as const

if (!existsSync(ENTRY)) {
  console.error(`ERROR: ${ENTRY} not found. Run 'bun run build' first.`)
  process.exit(1)
}

function collectMjs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...collectMjs(full))
    } else if (name.endsWith('.mjs')) {
      out.push(full)
    }
  }
  return out
}

const files = collectMjs(DIST)
const totals = new Map<string, number>(BANNED_PATTERNS.map(p => [p, 0]))
const offenders = new Map<string, string[]>()
let exitCode = 0

console.log(`Checking ${files.length} bundle file(s) under ${DIST}/ for banned patterns...`)
console.log('')

for (const file of files) {
  const contents = readFileSync(file, 'utf8')
  for (const pattern of BANNED_PATTERNS) {
    const count = contents.split(pattern).length - 1
    if (count > 0) {
      totals.set(pattern, (totals.get(pattern) ?? 0) + count)
      const list = offenders.get(pattern) ?? []
      list.push(`${file} (${count})`)
      offenders.set(pattern, list)
      exitCode = 1
    }
  }
}

for (const pattern of BANNED_PATTERNS) {
  const count = totals.get(pattern) ?? 0
  if (count > 0) {
    console.log(`  FAIL: '${pattern}' found (${count} total)`)
    for (const where of offenders.get(pattern) ?? []) {
      console.log(`        - ${where}`)
    }
  } else {
    console.log(`  PASS: '${pattern}' not found`)
  }
}

console.log('')

if (exitCode === 0) {
  console.log(`✓ All checks passed — no banned patterns in ${files.length} bundle file(s)`)
} else {
  console.log('✗ FAILED — banned patterns found in build output')
}

process.exit(exitCode)
