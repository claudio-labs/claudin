import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LEASE_DIR, pruneChunkGenerations } from './chunkGc'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Five generations, oldest first, as base36 timestamps like the build's.
const GENERATIONS = ['mufjna00', 'mufjna01', 'mufjna02', 'mufjna03', 'mufjna04']

function chunksDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'chunk-gc-')), 'chunks')
  dirs.push(dir)
  mkdirSync(join(dir, LEASE_DIR), { recursive: true })
  for (const g of GENERATIONS) {
    writeFileSync(join(dir, `cli-${g}-abc123.mjs`), '')
    writeFileSync(join(dir, `processSlashCommand-${g}-def456.mjs`), '')
  }
  return dir
}

function generationsLeft(dir: string): string[] {
  return GENERATIONS.filter(g => existsSync(join(dir, `cli-${g}-abc123.mjs`)))
}

/** A pid that is certainly not running: a process that has already exited. */
function deadPid(): number {
  return spawnSync('true').pid!
}

test('keeps the three newest generations when nothing leases the others', () => {
  const dir = chunksDir()
  pruneChunkGenerations(dir)
  expect(generationsLeft(dir)).toEqual(['mufjna02', 'mufjna03', 'mufjna04'])
})

test('keeps an old generation a running process leases', () => {
  const dir = chunksDir()
  writeFileSync(join(dir, LEASE_DIR, String(process.pid)), 'mufjna00')
  pruneChunkGenerations(dir)
  expect(generationsLeft(dir)).toEqual(['mufjna00', 'mufjna02', 'mufjna03', 'mufjna04'])
})

test("a dead process's lease keeps nothing and is removed", () => {
  const dir = chunksDir()
  const pid = deadPid()
  writeFileSync(join(dir, LEASE_DIR, String(pid)), 'mufjna00')
  pruneChunkGenerations(dir)
  expect(generationsLeft(dir)).toEqual(['mufjna02', 'mufjna03', 'mufjna04'])
  expect(readdirSync(join(dir, LEASE_DIR))).toEqual([])
})
