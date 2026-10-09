import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { describeContextMemoryFile } from 'src/agent/context/memoryFileLabel.js'

const file = (type: string, path: string, tokens: number, entryCount?: number) => ({
  path,
  type,
  tokens,
  ...(entryCount === undefined ? {} : { entryCount }),
})

describe('describeContextMemoryFile', () => {
  test('an index is named for what it is, with its entries, tokens and /memory subcommand', () => {
    expect(describeContextMemoryFile(file('GlobalMem', '/home/u/.claudin/memory/MEMORY.md', 1200, 12))).toEqual({
      name: 'global memories index',
      detail: '12 entries · 1.2k tokens · /memory global',
      typeColumn: 'global memories index (12 entries)',
    })
    expect(describeContextMemoryFile(file('AutoMem', '/repo/.claudin/memory/MEMORY.md', 300, 1)).detail).toBe(
      '1 entry · 300 tokens · /memory private',
    )
    expect(describeContextMemoryFile(file('TeamMem', '/repo/.claudin/memory/team/MEMORY.md', 5000, 129)).name).toBe(
      'team memories index',
    )
  })

  test('an instruction file keeps its path and its raw type', () => {
    expect(describeContextMemoryFile(file('Project', '/repo/AGENTS.md', 900))).toEqual({
      name: '/repo/AGENTS.md',
      detail: '900 tokens',
      typeColumn: 'Project',
    })
  })

  test('both /context renderers go through it', () => {
    // Asserted on the SOURCE: the panel is React-Compiler output and the
    // table needs a whole ContextData.
    const panel = readFileSync(new URL('../ui/ContextVisualization.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('const { name, detail } = describeContextMemoryFile(file);')
    const table = readFileSync(new URL('../../commands/context/context-noninteractive.ts', import.meta.url), 'utf8')
    expect(table).toContain('describeContextMemoryFile(file).typeColumn')
    // …and the entry count they print is the one analyzeContext counted.
    const analyze = readFileSync(new URL('./analyzeContext.ts', import.meta.url), 'utf8')
    expect(analyze).toContain('{ entryCount: countIndexEntries(file.content) }')
  })
})
