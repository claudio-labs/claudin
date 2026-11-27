import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A command the user is told to run must name this binary: `claude mcp
// remove …` typed as suggested runs another CLI, or nothing. A text pin over
// every source file, since the hints sit inside handlers that exit the
// process and inside model prompts (/insights).
const SRC = join(import.meta.dir, '..', '..')
const UPSTREAM_HINT = /['"`][^'"`\n]*\bclaude mcp /

describe('MCP command hints', () => {
  test('no source file suggests `claude mcp`', () => {
    const offenders: string[] = []
    for (const file of new Glob('**/*.{ts,tsx}').scanSync(SRC)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      const hint = readFileSync(join(SRC, file), 'utf8').match(UPSTREAM_HINT)
      if (hint) offenders.push(`${file}: ${hint[0]}`)
    }
    expect(offenders).toEqual([])
  })

  test('the hints that exist name claudin mcp', () => {
    for (const file of ['commands/mcp/addCommand.ts', 'platform/headless/handlers/mcp.tsx', 'commands/insights/constants.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8')).toContain('claudin mcp ')
    }
  })
})
