import { describe, expect, test } from 'bun:test'
import { globsForSearchPath, isDirAnchoredGlob, splitGlobInput } from 'src/tools/GrepTool/globAnchor.js'

const globs = (pattern: string, searchDir = '/repo/src/tools') => globsForSearchPath(pattern, searchDir, '/repo')

describe('globsForSearchPath', () => {
  test('a glob with a slash is kept, and read again from the search path', () => {
    expect(globs('GrepTool/*.ts')).toEqual(['GrepTool/*.ts', '/src/tools/GrepTool/*.ts'])
    expect(globs('{GrepTool/a.ts,GlobTool/b.ts}')).toEqual(['{GrepTool/a.ts,GlobTool/b.ts}', '/src/tools/{GrepTool/a.ts,GlobTool/b.ts}'])
  })

  test('a negated one keeps its bang on both', () => {
    expect(globs('!fuzz/corpus/**')).toEqual(['!fuzz/corpus/**', '!/src/tools/fuzz/corpus/**'])
  })

  test('a leading ./ is read from the search path alone, slash or not', () => {
    expect(globs('./GrepTool/*.ts')).toEqual(['/src/tools/GrepTool/*.ts'])
    expect(globs('!./x.ts')).toEqual(['!/src/tools/x.ts'])
    expect(globs('./x.ts', '/repo')).toEqual(['/x.ts'])
  })

  test('a search path outside the cwd leads with its absolute path', () => {
    expect(globs('docs/*.md', '/other/proj')).toEqual(['docs/*.md', '//other/proj/docs/*.md'])
  })

  test('the parent of the cwd is outside it', () => {
    expect(globsForSearchPath('src/*.ts', '/repo', '/repo/pkg')).toEqual(['src/*.ts', '//repo/src/*.ts'])
  })

  test('glob syntax in the search path is escaped', () => {
    expect(globs('sub/*.py', '/repo/a[1]/{b}')).toEqual(['sub/*.py', '/a\\[1\\]/\\{b\\}/sub/*.py'])
  })

  test('what ripgrep already reads from the search path is left alone', () => {
    expect(globs('*.ts')).toEqual(['*.ts'])
    expect(globs('!node_modules/')).toEqual(['!node_modules/'])
    expect(globs('**/GrepTool/*.ts')).toEqual(['**/GrepTool/*.ts'])
    expect(globs('/src/x.ts')).toEqual(['/src/x.ts'])
    expect(globs('GrepTool/*.ts', '/repo')).toEqual(['GrepTool/*.ts'])
  })
})

describe('isDirAnchoredGlob', () => {
  test('only a relative pattern with an inner slash is anchored where ripgrep runs', () => {
    expect(isDirAnchoredGlob('src/*.ts')).toBe(true)
    expect(isDirAnchoredGlob('!fuzz/corpus/**')).toBe(true)
    expect(isDirAnchoredGlob('a/b/')).toBe(true)
    expect(isDirAnchoredGlob('*.ts')).toBe(false)
    expect(isDirAnchoredGlob('node_modules/')).toBe(false)
    expect(isDirAnchoredGlob('**/a/b.ts')).toBe(false)
    expect(isDirAnchoredGlob('!**/x')).toBe(false)
    expect(isDirAnchoredGlob('/a/b.ts')).toBe(false)
  })
})

describe('splitGlobInput', () => {
  test('splits on whitespace, and on commas outside braces', () => {
    expect(splitGlobInput('*.ts,*.tsx {a/b.ts,c/d.ts} !x/**')).toEqual(['*.ts', '*.tsx', '{a/b.ts,c/d.ts}', '!x/**'])
    expect(splitGlobInput(' a,,b ')).toEqual(['a', 'b'])
  })
})
