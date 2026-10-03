/**
 * The include forms the characterization fixtures cannot tell apart: there a
 * refused reference points at a file that does not exist, so refusing it and
 * failing to read it look the same. Here the extraction is asked directly
 * which targets it found. Plus one comment case that only CRLF makes visible.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { Lexer } from 'marked'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { processMemoryFile } from 'src/memory/instructions/claudemd.js'
import { extractIncludePathsFromTokens } from 'src/memory/instructions/claudemd/includes.js'

const BASE = join('/', 'proj', 'docs', 'AGENTS.md')
const extracted = (markdown: string): string[] => extractIncludePathsFromTokens(new Lexer({ gfm: true }).lex(markdown), BASE)

describe('extractIncludePathsFromTokens', () => {
  const cases: Array<[string, string, string[]]> = [
    ['a bare name is relative to the including file', 'see @notes.md', [join('/', 'proj', 'docs', 'notes.md')]],
    ['./ and ../', '@./a.md and @../b.md', [join('/', 'proj', 'docs', 'a.md'), join('/', 'proj', 'b.md')]],
    ['~/ is the home directory', '@~/x.md', [join(homedir(), 'x.md')]],
    ['an absolute path', '@/etc/x.md', [join('/', 'etc', 'x.md')]],
    ['@/ alone is refused', 'see @/ here', []],
    ['@/ with only a fragment is refused', 'see @/#top here', []],
    ['a doubled @ is refused', 'see @@a.md', []],
    ['a reference starting with a symbol is refused', '@*a.md @%a.md @(a.md) @&a.md', []],
    ['a reference that is only a fragment is refused', 'see @#heading', []],
    ['a fragment is dropped', '@./a.md#setup', [join('/', 'proj', 'docs', 'a.md')]],
    ['an escaped space joins the path', '@./my\\ notes.md', [join('/', 'proj', 'docs', 'my notes.md')]],
    ['an @ glued to a word is not an include', 'mail team@a.md', []],
    ['inline code hides a reference even after a space', 'run `cat @./code.md` now', []],
    ['each target once, in document order', '@./b.md @./a.md @./b.md', [join('/', 'proj', 'docs', 'b.md'), join('/', 'proj', 'docs', 'a.md')]],
  ]
  test.each(cases)('%s', (_name, markdown, targets) => {
    expect(extracted(markdown)).toEqual(targets)
  })
})

describe('an unclosed comment', () => {
  let root: string
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'claudemd-extract-')))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('keeps the file\'s bytes, CRLF included, because nothing was removed', async () => {
    const raw = 'one\r\n\r\n<!-- never closed\r\ntwo\r\n'
    writeFileSync(join(root, 'open.md'), raw)

    const [entry] = await processMemoryFile(join(root, 'open.md'), 'Project', new Set(), true)

    expect(entry).toMatchObject({ content: raw, contentDiffersFromDisk: false })
  })
})
