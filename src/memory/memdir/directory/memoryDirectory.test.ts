import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasExistingMemories } from 'src/memory/memdir/directory/memoryDirectory.js'
import { buildMemoryPrompt } from 'src/memory/memdir/prompt/agentMemoryPrompt.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** `<root>/mem` holding an empty index, beside a `memMEMORY.md` sibling with content. */
function dirBesideDecoy(): string {
  const root = mkdtempSync(join(tmpdir(), 'memdir-join-'))
  roots.push(root)
  const dir = join(root, 'mem')
  mkdirSync(dir)
  writeFileSync(join(dir, 'MEMORY.md'), '')
  writeFileSync(`${dir}MEMORY.md`, '- [Decoy](decoy.md) — not this directory\n')
  return dir
}

describe('the index path is joined, not concatenated', () => {
  test('hasExistingMemories reads the directory own index when given no separator', () => {
    expect(hasExistingMemories(dirBesideDecoy())).toBe(false)
  })

  test('buildMemoryPrompt shows the directory own index when given no separator', () => {
    const prompt = buildMemoryPrompt({ displayName: 'agent memory', memoryDir: dirBesideDecoy() })
    expect(prompt).not.toContain('Decoy')
    expect(prompt.slice(prompt.lastIndexOf('## MEMORY.md'))).toMatch(/empty/)
  })

  test('a topic file still counts without the separator', () => {
    const dir = dirBesideDecoy()
    writeFileSync(join(dir, 'prefers-tabs.md'), '---\nname: prefers-tabs\n---\n')
    expect(hasExistingMemories(dir)).toBe(true)
  })
})
