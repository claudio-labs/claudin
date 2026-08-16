// One-shot script to regenerate src/platform/main/__tests__/__snapshots__/help-subcommands.txt
// using the exact same formatting as bootSnapshot.test.ts (so they match).
// Run with: bun run scripts/codegen/regen-help-snapshots.ts
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../repoRoot'

const BIN = join(REPO_ROOT, 'bin', 'claudin')

function runHelp(args: readonly string[]): string {
  const res = spawnSync(BIN, [...args, '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
  })
  if (res.error) throw res.error
  return res.stdout + (res.stderr ? `\n--- stderr ---\n${res.stderr}` : '')
}

const visibleCommands = [
  'agents', 'auth', 'auto-mode', 'doctor', 'install',
  'mcp', 'plugin', 'setup-token', 'update',
]
const subcommands: string[][] = [
  ['auth', 'login'], ['auth', 'logout'], ['auth', 'status'],
  ['auto-mode', 'config'], ['auto-mode', 'critique'], ['auto-mode', 'defaults'],
  ['mcp', 'add'], ['mcp', 'add-from-claude-desktop'], ['mcp', 'add-json'],
  ['mcp', 'doctor'], ['mcp', 'get'], ['mcp', 'list'], ['mcp', 'remove'],
  ['mcp', 'reset-project-choices'], ['mcp', 'serve'],
  ['plugin', 'disable'], ['plugin', 'enable'], ['plugin', 'install'],
  ['plugin', 'list'], ['plugin', 'marketplace'], ['plugin', 'uninstall'],
  ['plugin', 'update'], ['plugin', 'validate'],
]

const parts: string[] = []
for (const cmd of visibleCommands) {
  parts.push(`=== ${cmd} ===`)
  parts.push(runHelp([cmd]))
  parts.push('')
}
for (const sub of subcommands) {
  parts.push(`=== ${sub.join(' ')} ===`)
  parts.push(runHelp(sub))
  parts.push('')
}

const outPath = join(REPO_ROOT, 'src/platform/main/__tests__/__snapshots__/help-subcommands.txt')
writeFileSync(outPath, parts.join('\n'))
console.log(`wrote ${parts.length} parts to ${outPath}`)
