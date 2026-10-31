import { describe, expect, test } from 'bun:test'
import { anchorGlobAtSearchPath } from 'src/tools/GrepTool/globAnchor.js'

const anchor = (pattern: string, searchDir = '/repo/src/tools') => anchorGlobAtSearchPath(pattern, searchDir, '/repo')

describe('anchorGlobAtSearchPath', () => {
  test('a glob with a slash is led by the search path relative to the cwd', () => {
    expect(anchor('GrepTool/*.ts')).toBe('/src/tools/GrepTool/*.ts')
    expect(anchor('{GrepTool/a.ts,GlobTool/b.ts}')).toBe('/src/tools/{GrepTool/a.ts,GlobTool/b.ts}')
  })

  test('a negated one keeps its bang in front', () => {
    expect(anchor('!fuzz/corpus/**')).toBe('!/src/tools/fuzz/corpus/**')
  })

  test('a leading ./ is dropped before anchoring', () => {
    expect(anchor('./GrepTool/*.ts')).toBe('/src/tools/GrepTool/*.ts')
  })

  test('a search path outside the cwd leads with its absolute path', () => {
    expect(anchor('docs/*.md', '/other/proj')).toBe('//other/proj/docs/*.md')
  })

  test('glob syntax in the search path is escaped', () => {
    expect(anchor('sub/*.py', '/repo/a[1]/{b}')).toBe('/a\\[1\\]/\\{b\\}/sub/*.py')
  })

  test('what ripgrep already reads from the search path is left alone', () => {
    expect(anchor('*.ts')).toBe('*.ts')
    expect(anchor('**/GrepTool/*.ts')).toBe('**/GrepTool/*.ts')
    expect(anchor('/src/x.ts')).toBe('/src/x.ts')
    expect(anchor('./x.ts')).toBe('./x.ts')
    expect(anchor('GrepTool/*.ts', '/repo')).toBe('GrepTool/*.ts')
  })
})
