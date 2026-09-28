import { describe, expect, test } from 'bun:test'
import {
  isAutoManagedMemoryFileIn,
  isAutoManagedMemoryPatternIn,
  isMemoryDirectoryIn,
  isShellCommandTargetingMemoryIn,
  type MemoryDetectionContext,
} from 'src/memory/memdir/detection/memoryDetection.js'

function posixContext(
  overrides: Partial<MemoryDetectionContext> = {},
): MemoryDetectionContext {
  const autoMemDir = '/work/app/.claudin/memory/'
  return {
    platform: 'posix',
    configHome: '/home/ann/.claudin',
    memoryBase: '/home/ann/.claudin',
    autoMemoryEnabled: true,
    autoMemDir: () => autoMemDir,
    teamBuild: false,
    teamMemoryEnabled: () => true,
    isAutoMemPath: path => path.startsWith(autoMemDir),
    isTeamMemPath: path => path.startsWith(`${autoMemDir}team/`),
    isAgentMemoryPath: path => path.includes('/agent-memory/'),
    ...overrides,
  }
}

function windowsContext(): MemoryDetectionContext {
  const autoMemDir = 'C:\\Work\\App\\.claudin\\memory\\'
  return {
    ...posixContext(),
    platform: 'windows',
    configHome: 'C:\\Users\\Ann\\.claudin',
    memoryBase: 'C:\\Users\\Ann\\.claudin',
    autoMemDir: () => autoMemDir,
    isAutoMemPath: path => path.startsWith(autoMemDir),
    isAgentMemoryPath: () => false,
  }
}

describe('transcript patterns need a projects directory', () => {
  const ctx = posixContext()

  test.each(['**/*.jsonl', 'data/**/*.jsonl', 'logs/*.jsonl', 'myprojects/*.jsonl'])(
    '%p is an ordinary search',
    pattern => {
      expect(isAutoManagedMemoryPatternIn(ctx, pattern)).toBe(false)
    },
  )

  test.each(['projects/**/*.jsonl', '/home/ann/.claudin/projects/app/*.jsonl', '**\\projects\\*.jsonl'])(
    '%p is a transcript search',
    pattern => {
      expect(isAutoManagedMemoryPatternIn(ctx, pattern)).toBe(true)
    },
  )
})

describe('session files lie strictly below the config home', () => {
  test('a sibling directory sharing the prefix is not the config home', () => {
    const ctx = posixContext()
    expect(isAutoManagedMemoryFileIn(ctx, '/home/ann/.claudin/projects/app/s.jsonl')).toBe(true)
    expect(isAutoManagedMemoryFileIn(ctx, '/home/ann/.claudin-old/projects/app/s.jsonl')).toBe(false)
  })
})

describe('a command must spell out a memory location to count', () => {
  test('agent memory in the working directory alone does not make a memory command', () => {
    const ctx = posixContext()
    const agentFile = '/work/app/.claudin/agent-memory/reviewer/notes.md'
    expect(isAutoManagedMemoryFileIn(ctx, agentFile)).toBe(true)
    expect(isShellCommandTargetingMemoryIn(ctx, `cat ${agentFile}`)).toBe(false)
  })

  test('punctuation inside a token is kept, so the token is not memory', () => {
    const ctx = posixContext()
    expect(isShellCommandTargetingMemoryIn(ctx, 'ls /work/app/.claudin/memory|wc')).toBe(false)
    expect(isShellCommandTargetingMemoryIn(ctx, 'ls /work/app/.claudin/memory | wc')).toBe(true)
  })
})

describe('on Windows', () => {
  const ctx = windowsContext()

  test('directories compare without case and with either separator', () => {
    expect(isMemoryDirectoryIn(ctx, 'c:\\users\\ann\\.CLAUDIN\\Projects\\app\\')).toBe(true)
    expect(isMemoryDirectoryIn(ctx, 'C:/Users/Ann/.claudin/x/session-memory/')).toBe(true)
    expect(isMemoryDirectoryIn(ctx, 'c:\\work\\app\\.claudin\\memory')).toBe(true)
    expect(isMemoryDirectoryIn(ctx, 'C:\\Users\\Ann\\.claudin')).toBe(false)
  })

  test('a transcript under the config home counts whatever its case', () => {
    expect(
      isAutoManagedMemoryFileIn(ctx, 'C:\\USERS\\ann\\.claudin\\projects\\app\\s.JSONL'),
    ).toBe(true)
  })

  test('a MinGW /c/ path in a command is read as its drive path', () => {
    expect(
      isShellCommandTargetingMemoryIn(ctx, 'grep -c error /c/Users/Ann/.claudin/projects/app/s.jsonl'),
    ).toBe(true)
    expect(isShellCommandTargetingMemoryIn(ctx, 'cat /c/Users/Ann/notes.txt')).toBe(false)
  })

  test('patterns fold case too', () => {
    expect(isAutoManagedMemoryPatternIn(ctx, '**\\Projects\\*.JSONL')).toBe(true)
    expect(isAutoManagedMemoryPatternIn(ctx, 'Session-Memory\\*.MD')).toBe(true)
  })
})
