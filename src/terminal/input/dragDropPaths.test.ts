import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  extractDraggedFilePaths,
  isDroppedPathList,
  splitPastedPaths,
} from 'src/terminal/input/dragDropPaths.js'

function escapeFinderDraggedPath(filePath: string): string {
  return filePath.replace(/([\\ ])/g, '\\$1')
}

describe('splitPastedPaths', () => {
  test('splits on a space before an absolute path, quoted or not', () => {
    expect(splitPastedPaths('/a/x.png /b/y.png')).toEqual(['/a/x.png', '/b/y.png'])
    expect(splitPastedPaths('"/a/x y.png" "/b/y.png"')).toEqual([
      '"/a/x y.png"',
      '"/b/y.png"',
    ])
    expect(splitPastedPaths("'/a/x.png' C:\\b\\y.png")).toEqual([
      "'/a/x.png'",
      'C:\\b\\y.png',
    ])
    expect(splitPastedPaths("'C:\\a\\x.png' '/b/y.png'")).toEqual([
      "'C:\\a\\x.png'",
      "'/b/y.png'",
    ])
  })

  test('splits on newlines and keeps escaped spaces inside a path', () => {
    expect(splitPastedPaths('/a/my\\ shot.png\n/b/y.png\n')).toEqual([
      '/a/my\\ shot.png',
      '/b/y.png',
      '',
    ])
  })

  test('leaves prose and relative paths whole', () => {
    expect(splitPastedPaths('see "quoted" text and ./rel/path')).toEqual([
      'see "quoted" text and ./rel/path',
    ])
  })
})

describe('isDroppedPathList', () => {
  test('several absolute paths, quoted, escaped or Windows, are a drop', () => {
    expect(isDroppedPathList(splitPastedPaths('/a/x.png /b/y.png'))).toBe(true)
    expect(
      isDroppedPathList(splitPastedPaths('"/a/x y.png" \'/b/y.png\' C:\\c\\z.png')),
    ).toBe(true)
    expect(isDroppedPathList(splitPastedPaths('/a/my\\ shot.png\n/b/y.png\n'))).toBe(true)
  })

  test('prose that quotes or names image paths is not', () => {
    expect(
      isDroppedPathList(
        splitPastedPaths('convert "/tmp/in.png" -resize 50% "/tmp/out.png"'),
      ),
    ).toBe(false)
    expect(isDroppedPathList(splitPastedPaths('look at /x/shot.png'))).toBe(false)
  })

  test('one segment is always taken, a bare filename included', () => {
    expect(isDroppedPathList(['shot.png'])).toBe(true)
    expect(isDroppedPathList(['"/a/x.png"', ''])).toBe(true)
    expect(isDroppedPathList([])).toBe(true)
  })
})

describe('extractDraggedFilePaths', () => {
  // Paths that exist on any system.
  const thisFile = import.meta.path
  const packageJson = `${process.cwd()}/package.json`

  // Fixtures created synchronously at describe-load time (not in
  // `beforeAll`) so their paths are available to `test.each` tables,
  // which are built before any hook runs.
  const tmpDir = mkdtempSync(join(tmpdir(), 'dragdrop-test-'))
  const spacedFile = join(tmpDir, 'my file.txt')
  writeFileSync(spacedFile, 'test')
  const scopedDir = join(tmpDir, '@types')
  mkdirSync(scopedDir)
  const atSignFile = join(scopedDir, 'index.d.ts')
  writeFileSync(atSignFile, 'test')

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('returns an empty array', () => {
    const emptyCases: Array<[string, string]> = [
      ['a non-absolute path', 'relative/path/file.ts'],
      ['a plain image path', '/Users/foo/image.png'],
      ['an uppercase image extension', '/Users/foo/SHOT.PNG'],
      ['a double-quoted image path', '"/Users/foo/shot.png"'],
      ['a single-quoted image path', "'/Users/foo/shot.jpg'"],
      ['regular prose text', 'hello world this is text'],
      ['a nonexistent absolute path', '/definitely/nonexistent/file.ts'],
      ['a single-quoted nonexistent path', "'/definitely/nonexistent.ts'"],
      ['an empty string', ''],
      ['whitespace only', '   \n  '],
      // Mixed-segment cases: all-or-nothing policy means a single bad
      // entry disqualifies the whole paste.
      ['a mix where one path does not exist', `${thisFile}\n/nonexistent/file.ts`],
      ['a mix where one segment is an image', `${thisFile}\n/Users/foo/shot.png`],
    ]
    test.each(emptyCases)('for %s', (_label, input) => {
      expect(extractDraggedFilePaths(input)).toEqual([])
    })
  })

  describe('resolves a single path', () => {
    const singleCases: Array<[string, string, string]> = [
      ['a plain absolute path', thisFile, thisFile],
      ['a double-quoted path', `"${thisFile}"`, thisFile],
      ['a single-quoted path', `'${thisFile}'`, thisFile],
      ['a path with leading/trailing whitespace', `  ${thisFile}  `, thisFile],
      // Realistic: dragging something under `node_modules/@types/...`.
      // `@` inside the path must not collide with the mention prefix
      // that the caller prepends downstream.
      ['a path containing an `@` segment', atSignFile, atSignFile],
    ]
    test.each(singleCases)('from %s', (_label, input, expected) => {
      expect(extractDraggedFilePaths(input)).toEqual([expected])
    })
  })

  describe('resolves multiple paths', () => {
    const multiCases: Array<[string, string, string[]]> = [
      [
        'newline-separated',
        `${thisFile}\n${packageJson}`,
        [thisFile, packageJson],
      ],
      [
        'space-separated (Finder drag)',
        `${thisFile} ${packageJson}`,
        [thisFile, packageJson],
      ],
      // Ported from openclaude #2517: the split only broke before an
      // unquoted path, so every quoted multi-file drop came back empty.
      [
        'double-quoted and space-separated',
        `"${spacedFile}" "${packageJson}"`,
        [spacedFile, packageJson],
      ],
      [
        'single-quoted and space-separated',
        `'${spacedFile}' '${packageJson}'`,
        [spacedFile, packageJson],
      ],
      [
        'mixed unquoted and quoted',
        `${thisFile} "${spacedFile}"`,
        [thisFile, spacedFile],
      ],
    ]
    test.each(multiCases)('when input is %s', (_label, input, expected) => {
      expect(extractDraggedFilePaths(input)).toEqual(expected)
    })
  })

  test('escapeFinderDraggedPath escapes spaces and backslashes', () => {
    expect(escapeFinderDraggedPath('/tmp/my\\notes file.txt')).toBe(
      '/tmp/my\\\\notes\\ file.txt',
    )
  })

  // Backslash-escaped paths are a Finder/macOS + Linux convention — on
  // Windows the shell-escape step is skipped, so these cases do not apply.
  if (process.platform !== 'win32') {
    describe('handles backslash-escaped paths', () => {
      test('returns empty for an escaped image path', () => {
        // The image check must apply after escape stripping so Finder
        // image drags still route to the image paste handler.
        expect(extractDraggedFilePaths('/Users/foo/my\\ shot.png')).toEqual([])
      })

      test('resolves an escaped real file with a space in its name', () => {
        // Raw form matches what a terminal delivers on Finder drag.
        const escaped = escapeFinderDraggedPath(spacedFile)
        expect(extractDraggedFilePaths(escaped)).toEqual([spacedFile])
      })
    })
  }
})
