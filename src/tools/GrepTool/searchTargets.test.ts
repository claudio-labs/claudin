import { describe, expect, test } from 'bun:test'

import { resolveSearchTargets } from 'src/tools/GrepTool/searchTargets.js'

const onDisk = (...paths: string[]) => {
  const set = new Set(paths)
  return (path: string) => set.has(path)
}

describe('resolveSearchTargets', () => {
  test('2b5c3f37 11-08: three directories in one string are three targets', () => {
    const exists = onDisk('src/tools/BuildTool', 'src/tools/RunTestsTool', 'src/tools/BashTool')
    expect(
      resolveSearchTargets('src/tools/BuildTool src/tools/RunTestsTool  src/tools/BashTool', exists),
    ).toEqual({ kind: 'many', paths: ['src/tools/BuildTool', 'src/tools/RunTestsTool', 'src/tools/BashTool'] })
  })

  test('30177640 11-09: the first piece that does not exist is the one named', () => {
    const exists = onDisk('crates/infrastructure/src/dns', 'crates/application/src/use_cases/dns')
    expect(
      resolveSearchTargets(
        'crates/infrastructure/src/dns crates/infrastructure/src/repositories/group_repository crates/application/src/use_cases/dns',
        exists,
      ),
    ).toEqual({ kind: 'missing', path: 'crates/infrastructure/src/repositories/group_repository' })
  })

  test('a path that exists whole is one target, spaces and all', () => {
    expect(resolveSearchTargets('my dir', onDisk('my dir', 'my', 'dir'))).toEqual({ kind: 'one', path: 'my dir' })
  })

  test('a missing path is named whole, with or without spaces, when no piece exists', () => {
    expect(resolveSearchTargets('gone', onDisk())).toEqual({ kind: 'missing', path: 'gone' })
    expect(resolveSearchTargets('no such dir', onDisk())).toEqual({ kind: 'missing', path: 'no such dir' })
    expect(resolveSearchTargets('  trailing  ', onDisk())).toEqual({ kind: 'missing', path: '  trailing  ' })
  })
})
