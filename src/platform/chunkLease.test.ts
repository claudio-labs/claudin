import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { writeChunkLease } from 'src/platform/chunkLease.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chunk-lease-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'chunks'))
  return dir
}

test('a dev chunk leases its generation under its pid', () => {
  const root = dist()
  const url = pathToFileURL(join(root, 'chunks', 'cli-mufjnal2-s6ax91tn.mjs')).href
  const lease = writeChunkLease(url, 4242)
  expect(lease).toBe(join(root, 'chunks', '.leases', '4242'))
  expect(readFileSync(lease!, 'utf8')).toBe('mufjnal2')
})

test('a release chunk, the entry file and a non-file URL lease nothing', () => {
  const root = dist()
  expect(writeChunkLease(pathToFileURL(join(root, 'chunks', 'cli-1.1.34-s6ax91tn.mjs')).href, 1)).toBeNull()
  expect(writeChunkLease(pathToFileURL(join(root, 'cli.mjs')).href, 1)).toBeNull()
  expect(writeChunkLease('file:///$bunfs/root/cli-mufjnal2-s6ax91tn.mjs', 1)).toBeNull()
})

test('a dev-named module outside a chunks directory leases nothing', () => {
  const root = dist()
  expect(writeChunkLease(pathToFileURL(join(root, 'cli-mufjnal2-s6ax91tn.mjs')).href, 1)).toBeNull()
  expect(existsSync(join(root, '.leases'))).toBe(false)
})
