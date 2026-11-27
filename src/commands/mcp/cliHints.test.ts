import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The commands these files tell the user to run must name this binary:
// `claude mcp remove …` typed as suggested runs another CLI, or nothing.
// A text pin, since the strings sit inside handlers that exit the process.
const FILES = [
  'src/commands/mcp/addCommand.ts',
  'src/platform/headless/handlers/mcp.tsx',
  'src/mcp/ui/MCPSettings.tsx',
]
const UPSTREAM_HINT = /['"`][^'"`\n]*\bclaude mcp /

describe('MCP command hints', () => {
  for (const file of FILES) {
    test(`${file} suggests claudin mcp, never claude mcp`, () => {
      const src = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')
      expect(src.match(UPSTREAM_HINT)?.[0]).toBeUndefined()
      expect(src).toContain('claudin mcp ')
    })
  }
})
