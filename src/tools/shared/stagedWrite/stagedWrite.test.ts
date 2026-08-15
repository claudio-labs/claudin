import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { setOriginalFsImplementation } from 'src/utils/fs/fsOperations.js'
import {
  isUnexpectedlyModified,
  readFileForStaging,
  rollbackChange,
  type StagedChange,
  stageContentReplacement,
  writeChange,
} from 'src/tools/shared/stagedWrite/stagedWrite.js'

beforeAll(() => {
  // Defend against an fs mock leaked from another test file in the shard.
  setOriginalFsImplementation()
})

let dir: string

function write(rel: string, body: string): string {
  const abs = join(dir, rel)
  writeFileSync(abs, body)
  return abs
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staged-'))
})

afterEach(() => {
  setOriginalFsImplementation()
  rmSync(dir, { recursive: true, force: true })
})

describe('stageContentReplacement', () => {
  test('stages without touching disk', () => {
    const a = write('a.txt', 'one\n')
    const change = stageContentReplacement(a, 'two\n')

    expect(change.type).toBe('update')
    expect(change.newContent).toBe('two\n')
    expect(readFileSync(a, 'utf8')).toBe('one\n')
  })

  // The base is what the commit-time check compares disk against. A caller
  // that already read the file must be able to pin THAT read, or a concurrent
  // edit lands inside the window and is silently overwritten.
  test('an explicit base is kept as oldContent, not re-read', () => {
    const a = write('a.txt', 'one\n')
    const base = readFileForStaging(a)
    writeFileSync(a, 'edited by someone else\n')

    const change = stageContentReplacement(a, 'two\n', base)

    expect(change.oldContent).toBe('one\n')
    expect(isUnexpectedlyModified(change)).toBe(true)
  })

  test('without a base it reads the file itself', () => {
    const a = write('a.txt', 'one\n')

    const change = stageContentReplacement(a, 'two\n')

    expect(change.oldContent).toBe('one\n')
    expect(isUnexpectedlyModified(change)).toBe(false)
  })

  test('a missing file cannot be staged', () => {
    expect(() => stageContentReplacement(join(dir, 'nope.txt'), 'x')).toThrow(
      /no longer exists/,
    )
  })
})

describe('isUnexpectedlyModified', () => {
  test('an add requires the file to still be absent', () => {
    const absPath = join(dir, 'new.txt')
    const change: StagedChange = {
      type: 'add',
      absPath,
      oldContent: null,
      newContent: 'x\n',
      encoding: 'utf8',
      endings: 'LF',
      additions: 1,
      deletions: 0,
      structuredPatch: [],
    }

    expect(isUnexpectedlyModified(change)).toBe(false)
    writeFileSync(absPath, 'someone got there first\n')
    expect(isUnexpectedlyModified(change)).toBe(true)
  })

  // A move validated its destination as free. If the destination appeared
  // since, writing would clobber a file nobody agreed to lose.
  test('a move whose destination appeared is refused', () => {
    const from = write('from.txt', 'body\n')
    const to = join(dir, 'to.txt')
    const change: StagedChange = {
      type: 'move',
      absPath: from,
      movePath: to,
      oldContent: 'body\n',
      newContent: 'body\n',
      encoding: 'utf8',
      endings: 'LF',
      additions: 0,
      deletions: 0,
      structuredPatch: [],
    }

    expect(isUnexpectedlyModified(change)).toBe(false)
    writeFileSync(to, 'i was here\n')
    expect(isUnexpectedlyModified(change)).toBe(true)
  })
})

describe('rollbackChange', () => {
  test('an update is restored to its staged base', () => {
    const a = write('a.txt', 'one\n')
    const change = stageContentReplacement(a, 'two\n')
    writeChange(change)
    expect(readFileSync(a, 'utf8')).toBe('two\n')

    rollbackChange(change)

    expect(readFileSync(a, 'utf8')).toBe('one\n')
  })

  test('an add is removed', () => {
    const absPath = join(dir, 'new.txt')
    const change: StagedChange = {
      type: 'add',
      absPath,
      oldContent: null,
      newContent: 'x\n',
      encoding: 'utf8',
      endings: 'LF',
      additions: 1,
      deletions: 0,
      structuredPatch: [],
    }
    writeChange(change)
    expect(existsSync(absPath)).toBe(true)

    rollbackChange(change)

    expect(existsSync(absPath)).toBe(false)
  })

  test('a move puts the source back and drops the destination', () => {
    const from = write('from.txt', 'body\n')
    const to = join(dir, 'to.txt')
    const change: StagedChange = {
      type: 'move',
      absPath: from,
      movePath: to,
      oldContent: 'body\n',
      newContent: 'body\n',
      encoding: 'utf8',
      endings: 'LF',
      additions: 0,
      deletions: 0,
      structuredPatch: [],
    }
    writeChange(change)
    expect(existsSync(from)).toBe(false)
    expect(existsSync(to)).toBe(true)

    rollbackChange(change)

    expect(readFileSync(from, 'utf8')).toBe('body\n')
    expect(existsSync(to)).toBe(false)
  })

  test('never throws on an impossible rollback', () => {
    const change: StagedChange = {
      type: 'update',
      absPath: join(dir, 'gone', 'deep', 'a.txt'),
      oldContent: 'one\n',
      newContent: 'two\n',
      encoding: 'utf8',
      endings: 'LF',
      additions: 1,
      deletions: 1,
      structuredPatch: [],
    }

    expect(() => rollbackChange(change)).not.toThrow()
  })
})
