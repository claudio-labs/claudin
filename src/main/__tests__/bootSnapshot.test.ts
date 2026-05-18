// Caracterização para o split de src/main.tsx (ROADMAP 11g, Fase 0).
//
// NÃO importa main.tsx — isso dispararia os side-effects de boot
// (profileCheckpoint, MDM prefetch, keychain prefetch, gate
// `isBeingDebugged()` que mata o teste sob `bun --inspect`).
//
// Help snapshots vêm via subprocess de ./bin/claudio. Dispatch table
// é uma estrutura inerte declarada manualmente a partir da inspeção
// de main.tsx (ver dispatchTable.ts). Os snapshots existem para
// detectar regressão (subcomando some, alias muda) durante o split.

import { Glob } from 'bun'
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DISPATCH_TABLE, type SubcommandSpec } from './dispatchTable.js'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const BIN = join(REPO_ROOT, 'bin', 'claudio')
const SNAPSHOT_DIR = join(__dirname, '__snapshots__')

function runHelp(args: readonly string[]): string {
  const res = spawnSync(BIN, [...args, '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
  })
  if (res.error) throw res.error
  return res.stdout + (res.stderr ? `\n--- stderr ---\n${res.stderr}` : '')
}

describe('main.tsx — boot characterization (Fase 0)', () => {
  test('top-level --help matches snapshot', () => {
    const actual = runHelp([])
    const expected = readFileSync(join(SNAPSHOT_DIR, 'help.txt'), 'utf8')
    expect(actual).toBe(expected)
  })

  test('per-subcommand --help matches snapshot', () => {
    // 32 subprocess spawns × ~500ms each — needs generous timeout.
    const visibleCommands = [
      'agents', 'auth', 'auto-mode', 'doctor', 'install',
      'mcp', 'plugin', 'setup-token', 'update',
    ] as const
    const subcommands = [
      ['auth', 'login'], ['auth', 'logout'], ['auth', 'status'],
      ['auto-mode', 'config'], ['auto-mode', 'critique'], ['auto-mode', 'defaults'],
      ['mcp', 'add'], ['mcp', 'add-from-claude-desktop'], ['mcp', 'add-json'],
      ['mcp', 'doctor'], ['mcp', 'get'], ['mcp', 'list'], ['mcp', 'remove'],
      ['mcp', 'reset-project-choices'], ['mcp', 'serve'],
      ['plugin', 'disable'], ['plugin', 'enable'], ['plugin', 'install'],
      ['plugin', 'list'], ['plugin', 'marketplace'], ['plugin', 'uninstall'],
      ['plugin', 'update'], ['plugin', 'validate'],
    ] as const

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

    const actual = parts.join('\n')
    const expected = readFileSync(join(SNAPSHOT_DIR, 'help-subcommands.txt'), 'utf8')
    expect(actual).toBe(expected)
  }, 60_000)

  test('profileCheckpoint call sites match snapshot (multiset, exhaustive scan)', () => {
    // Multiset (não ordenado): após o split 11g os checkpoints vivem em
    // múltiplos módulos sob src/main/. A ordem lexical no source deixa
    // de refletir a ordem de invocação real (não é estaticamente derivável
    // sem rodar o bundle). O que conseguimos garantir estaticamente:
    // (1) nenhum checkpoint somem; (2) nenhum checkpoint novo aparece
    // sem atualizar o snapshot.
    //
    // O scanner varre TODOS os .ts/.tsx em src/main/** + src/main.tsx
    // (exceto __tests__/), evitando o regresso do "scanner hardcoded
    // perde arquivo novo".
    const files: string[] = [join(REPO_ROOT, 'src', 'main.tsx')]
    const glob = new Glob('src/main/**/*.{ts,tsx}')
    for (const rel of glob.scanSync({ cwd: REPO_ROOT })) {
      if (rel.includes('__tests__') || rel.includes('__snapshots__')) continue
      files.push(join(REPO_ROOT, rel))
    }
    const re = /profileCheckpoint\('([^']+)'\)/g
    // Strip line comments so `// profileCheckpoint('foo')` in docs doesn't
    // count. Block-comment usage is rare enough to ignore.
    const stripLineComments = (s: string): string =>
      s.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n')
    const actual: string[] = []
    for (const f of files) {
      const src = stripLineComments(readFileSync(f, 'utf8'))
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) actual.push(m[1]!)
    }

    const snap = readFileSync(join(SNAPSHOT_DIR, 'bootCheckpoints.order.txt'), 'utf8')
    const expected: string[] = []
    for (const line of snap.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      // line format: "NN  checkpoint_name  ..."
      const parts = t.split(/\s+/)
      if (parts.length >= 2) expected.push(parts[1]!)
    }
    expect(actual.slice().sort()).toEqual(expected.slice().sort())
  })

  test('dispatch table matches registered Commander subcommands', () => {
    // Atualizado na Fase 7 review-followup: a tabela é derivada do source
    // real de src/main/commands/*.ts (via regex de `.command('name'`),
    // não apenas hand-edited. Se um subcomando for adicionado/removido
    // em registerSubcommands.ts/commands/*.ts sem atualizar
    // dispatchTable.ts, o teste falha.
    const COMMAND_RE = /\.command\(['"]([\w-]+)/g
    const actualNames = new Set<string>()
    const glob = new Glob('src/main/commands/*.ts')
    for (const rel of glob.scanSync({ cwd: REPO_ROOT })) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
      let m: RegExpExecArray | null
      while ((m = COMMAND_RE.exec(src)) !== null) actualNames.add(m[1]!)
    }

    function flat(specs: readonly SubcommandSpec[]): string[] {
      return specs.flatMap(s => [s.name, ...(s.children ? flat(s.children) : [])])
    }
    const expectedNames = new Set(flat(DISPATCH_TABLE))

    // Subcomandos no source mas faltando na tabela = regressão silenciosa
    // (era exatamente isso que o reviewer apontou).
    const missingFromTable = [...actualNames].filter(n => !expectedNames.has(n)).sort()
    // Subcomandos na tabela mas removidos do source = tabela stale.
    const missingFromSource = [...expectedNames].filter(n => !actualNames.has(n)).sort()

    expect({ missingFromTable, missingFromSource }).toEqual({
      missingFromTable: [],
      missingFromSource: [],
    })
  })
})
