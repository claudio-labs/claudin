import { describe, expect, test } from 'bun:test'
import {
  deriveNewContentsFromChunks,
  parsePatch,
  type UpdateFileChunk,
} from 'src/tools/ApplyPatchTool/patchFormat.js'

function envelope(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch`
}

describe('parsePatch', () => {
  test('parses an Add File hunk', () => {
    const { hunks } = parsePatch(
      envelope('*** Add File: hello.txt\n+Hello\n+world'),
    )
    expect(hunks).toEqual([
      { type: 'add', path: 'hello.txt', contents: 'Hello\nworld' },
    ])
  })

  test('parses a Delete File hunk', () => {
    const { hunks } = parsePatch(envelope('*** Delete File: gone.txt'))
    expect(hunks).toEqual([{ type: 'delete', path: 'gone.txt' }])
  })

  test('parses an Update File hunk with a @@ context line', () => {
    const { hunks } = parsePatch(
      envelope('*** Update File: a.py\n@@ def f():\n-  return 1\n+  return 2'),
    )
    expect(hunks).toEqual([
      {
        type: 'update',
        path: 'a.py',
        movePath: undefined,
        chunks: [
          {
            oldLines: ['  return 1'],
            newLines: ['  return 2'],
            ops: [
              { kind: 'remove', text: '  return 1' },
              { kind: 'add', text: '  return 2' },
            ],
            changeContext: 'def f():',
            isEndOfFile: undefined,
          },
        ],
      },
    ])
  })

  test('parses an Update File hunk with a Move to directive', () => {
    const { hunks } = parsePatch(
      envelope(
        '*** Update File: src/app.py\n*** Move to: src/platform/main.py\n@@ x\n-a\n+b',
      ),
    )
    expect(hunks[0]).toMatchObject({
      type: 'update',
      path: 'src/app.py',
      movePath: 'src/platform/main.py',
    })
  })

  test('parses multiple file sections in one envelope', () => {
    const { hunks } = parsePatch(
      envelope(
        '*** Add File: new.ts\n+x\n*** Update File: app.ts\n@@ c\n-old\n+new\n*** Delete File: old.ts',
      ),
    )
    expect(hunks.map(h => h.type)).toEqual(['add', 'update', 'delete'])
  })

  test('captures the End of File anchor', () => {
    const { hunks } = parsePatch(
      envelope('*** Update File: a.txt\n@@\n-last\n+LAST\n*** End of File'),
    )
    expect(hunks[0]).toMatchObject({
      type: 'update',
      chunks: [expect.objectContaining({ isEndOfFile: true })],
    })
  })

  test('throws when the text carries no section header at all', () => {
    // Nothing here is a patch, so the original refusal stands.
    expect(() => parsePatch('just some prose\nand more of it')).toThrow(
      'missing Begin/End markers',
    )
  })

  test('repairs a body that lost its Begin marker', () => {
    // Measured over 682 sessions on 2026-08-15: 9 of 25 parse failures were
    // exactly this — a valid body starting straight at the header. The envelope
    // is synthesized rather than rejected, since a tool call always arrives as
    // complete JSON (a truncated emit is not callable at all).
    const { hunks } = parsePatch('*** Add File: x.txt\n+y\n*** End Patch')
    expect(hunks).toEqual([{ type: 'add', path: 'x.txt', contents: 'y' }])
  })

  test('repairs a body that lost its End marker', () => {
    // The other 5 of those 25.
    const { hunks } = parsePatch(
      '*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b',
    )
    expect(hunks[0]).toMatchObject({
      type: 'update',
      path: 'a.ts',
      chunks: [{ oldLines: ['a'], newLines: ['b'] }],
    })
  })

  test('repairs a body carrying neither marker', () => {
    const { hunks } = parsePatch('*** Delete File: gone.txt')
    expect(hunks).toEqual([{ type: 'delete', path: 'gone.txt' }])
  })

  test('still throws when both markers are present but out of order', () => {
    // A forgotten marker is repairable; a scrambled envelope is not.
    expect(() =>
      parsePatch('*** End Patch\n*** Add File: x.txt\n+y\n*** Begin Patch'),
    ).toThrow('missing Begin/End markers')
  })

  test('returns an empty hunk list for an empty envelope', () => {
    expect(parsePatch('*** Begin Patch\n*** End Patch').hunks).toEqual([])
  })

  test('throws when an Update section has no @@ chunks', () => {
    // A genuinely empty (or blank-only) Update body is a no-op write dressed up
    // as an edit. A body that HAS diff lines but no `@@` is an implicit bare
    // chunk now (see below), so it never reaches this guard.
    expect(() => parsePatch(envelope('*** Update File: a.txt'))).toThrow(
      'no @@ chunks',
    )
  })

  test('collapses an Update header repeated for the same file', () => {
    // The model names the path twice — absolute, then repo-relative — and the
    // body belongs to the second. Rejecting the whole patch over a duplicated
    // line cost a round-trip (2 of the 25 measured parse failures).
    const { hunks } = parsePatch(
      envelope(
        '*** Update File: /repo/src/a.ts\n*** Update File: src/a.ts\n@@\n-a\n+b',
      ),
    )
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ type: 'update', path: 'src/a.ts' })
  })

  test('collapses an Update header repeated verbatim', () => {
    const { hunks } = parsePatch(
      envelope('*** Update File: a.ts\n*** Update File: a.ts\n@@\n-a\n+b'),
    )
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ type: 'update', path: 'a.ts' })
  })

  test('still throws when a chunk-less header names a different file', () => {
    // Only a repeat of the SAME file is a typo. Anything else is an empty
    // section, which stays loud.
    expect(() =>
      parsePatch(
        envelope('*** Update File: a.ts\n*** Update File: b.ts\n@@\n-a\n+b'),
      ),
    ).toThrow('no @@ chunks')
  })

  test('takes a hunk line with no prefix as context (whole line), not a drop', () => {
    // The most common model slip: a context line loses its leading space — most
    // often the `}` that closes the hunk (6 of the 25 measured parse failures).
    // It used to reject the patch. The line is now kept WHOLE as context, so
    // nothing is dropped and the applier still has to find it in the file.
    const { hunks } = parsePatch(
      envelope('*** Update File: g.ts\n@@\n\treturn 1\n+\treturn 2'),
    )
    expect(hunks[0]).toMatchObject({
      type: 'update',
      chunks: [
        {
          oldLines: ['\treturn 1'],
          newLines: ['\treturn 1', '\treturn 2'],
        },
      ],
    })
  })

  test('treats a stripped (empty) blank context line as context, not a drop', () => {
    const { hunks } = parsePatch(
      envelope('*** Update File: a.txt\n@@\n alpha\n\n-beta\n+BETA'),
    )
    expect(hunks[0]).toMatchObject({
      type: 'update',
      chunks: [
        {
          oldLines: ['alpha', '', 'beta'],
          newLines: ['alpha', '', 'BETA'],
        },
      ],
    })
  })

  test('throws on a header with an empty path (no silent no-op)', () => {
    // A path-less header (a truncated emit) used to return null, which the
    // parsePatch loop swallowed via `i++; continue` — the section vanished while
    // the apply still reported success. Every header variant must throw instead.
    expect(() => parsePatch(envelope('*** Add File:\n+x'))).toThrow(
      'Add File header has an empty path',
    )
    expect(() => parsePatch(envelope('*** Delete File:'))).toThrow(
      'Delete File header has an empty path',
    )
    // The Update variant also bypassed the no-@@-chunks guard: its body was
    // discarded before that check could fire.
    expect(() => parsePatch(envelope('*** Update File:\n@@\n-a\n+b'))).toThrow(
      'Update File header has an empty path',
    )
    expect(() =>
      parsePatch(envelope('*** Update File: a.ts\n*** Move to:\n@@\n-a\n+b')),
    ).toThrow('Move to directive has an empty path')
  })

  test('throws on a stray *** body line instead of dropping the rest of the section', () => {
    // A `***`-prefixed line that is not a section marker (a between-hunk
    // separator the model emitted) used to terminate the chunk silently and
    // drop every following @@ chunk while reporting a successful apply.
    expect(() =>
      parsePatch(
        envelope(
          '*** Update File: app.ts\n@@ a\n const x = 1\n-  return x\n+  return x + 1\n*** and now the second change\n@@ b\n const y = 2\n-  return y\n+  return y * 2',
        ),
      ),
    ).toThrow("has a body line starting with '***' that is not a section marker")
  })

  test('throws on a *** context line that lost its leading space', () => {
    // Editing a markdown `*** rule` (or an ASCII banner): the context line is
    // emitted without its leading space, so `-old`/`+new` used to vanish and the
    // chunk degraded to a context-only no-op that slipped past every guard.
    expect(() =>
      parsePatch(
        envelope('*** Update File: doc.md\n@@\n intro\n*** Section Heading\n-old\n+new'),
      ),
    ).toThrow("has a body line starting with '***' that is not a section marker")
  })

  test('keeps a properly space-prefixed *** context line (no over-throw)', () => {
    // Guards the Issue-2 fix against firing on a *valid* context line whose
    // content happens to start with `***`: the leading space protects it.
    const { hunks } = parsePatch(
      envelope('*** Update File: doc.md\n@@\n intro\n *** Section Heading\n-old\n+new'),
    )
    expect(hunks[0]).toMatchObject({
      type: 'update',
      chunks: [
        {
          oldLines: ['intro', '*** Section Heading', 'old'],
          newLines: ['intro', '*** Section Heading', 'new'],
        },
      ],
    })
  })

  test('throws on a mid-body *** Move to: instead of dropping the move + rest', () => {
    // A Move directive is only valid right after the `*** Update File:` header.
    // One appearing mid-body used to break out of chunk parsing; parsePatch then
    // failed to recognize the bare `*** Move to:` as a header and skipped it via
    // `i++; continue`, silently dropping the rename AND every following @@ chunk
    // while still reporting a successful apply.
    expect(() =>
      parsePatch(
        envelope(
          '*** Update File: a.ts\n@@\n-a\n+b\n*** Move to: dest.ts\n@@\n-c\n+d',
        ),
      ),
    ).toThrow("has a body line starting with '***' that is not a section marker")
  })

  test('throws on a stray *** line in an Add File body (no silent truncation)', () => {
    // The Add collector stopped at the first `***` of any kind, so a content
    // line that lost its leading `+` (or a banner the model emitted) silently
    // truncated the created file at that point while reporting success.
    expect(() =>
      parsePatch(
        envelope(
          '*** Add File: README.md\n+line one\n+line two\n*** lost-its-plus\n+line three',
        ),
      ),
    ).toThrow("has a body line starting with '***' that is not a section marker")
  })

  test('throws on an Add File content line missing its + prefix', () => {
    expect(() =>
      parsePatch(envelope('*** Add File: f.txt\n+ok\nlost its plus')),
    ).toThrow("has a content line without a '+' prefix")
  })

  test('preserves a stripped blank line in an Add File body', () => {
    // A blank line whose leading `+` was stripped used to be dropped, collapsing
    // the new file's intended blank line. It must survive as an empty line.
    const { hunks } = parsePatch(envelope('*** Add File: f.txt\n+a\n\n+b'))
    expect(hunks).toEqual([
      { type: 'add', path: 'f.txt', contents: 'a\n\nb' },
    ])
  })

  test('throws on prose before the first @@ instead of silently eating it', () => {
    // A non-blank line between the `*** Update File:` header and the first `@@`
    // (e.g. the model narrating its change) used to be skipped via `i++` while
    // the chunk applied and reported success — the text just vanished. It must
    // throw instead.
    expect(() =>
      parsePatch(
        envelope('*** Update File: a.ts\nHere is my change:\n@@\n-a\n+b'),
      ),
    ).toThrow('not part of any @@ chunk')
  })

  test('tolerates a blank line before the first @@ chunk (no over-throw)', () => {
    // Guards the fix against firing on incidental formatting: a blank line right
    // after the Update header is harmless and must be skipped, not rejected.
    const { hunks } = parsePatch(
      envelope('*** Update File: a.ts\n\n@@\n-a\n+b'),
    )
    expect(hunks[0]).toMatchObject({
      type: 'update',
      chunks: [{ oldLines: ['a'], newLines: ['b'] }],
    })
  })

  test('opens an implicit chunk for change lines before the first @@', () => {
    // The model emits `-`/`+` lines straight after the header, then anchors the
    // next hunk properly. The `@@` is only a search cursor, so a missing one is
    // a bare `@@` — not a reason to reject the section.
    const { hunks } = parsePatch(
      envelope(
        '*** Update File: g.ts\n-import { a } from "./a.js"\n+import { b } from "./b.js"\n@@ export function f(\n-  return a\n+  return b',
      ),
    )
    expect(hunks[0]).toMatchObject({
      type: 'update',
      chunks: [
        { oldLines: ['import { a } from "./a.js"'], changeContext: undefined },
        { oldLines: ['  return a'], changeContext: 'export function f(' },
      ],
    })
  })

  test('takes an Update body with no @@ at all as one bare chunk', () => {
    const { hunks } = parsePatch(
      envelope('*** Update File: g.ts\n context\n-old\n+new'),
    )
    expect(hunks[0]).toMatchObject({
      type: 'update',
      chunks: [{ oldLines: ['context', 'old'], newLines: ['context', 'new'] }],
    })
  })

  test('throws on a header that lost its *** prefix instead of dropping the section', () => {
    // A `*** Update File:` header emitted without its leading `*** ` was not
    // recognized as a header; parsePatch then skipped it — and every body line
    // of the section — via `i++; continue`, so the whole edit silently vanished
    // while the apply reported success. It must throw instead.
    expect(() =>
      parsePatch(envelope('Update File: b.ts\n@@\n-a\n+b')),
    ).toThrow('expected a section header')
  })

  test('throws on stray junk where a section header is expected', () => {
    // Arbitrary text sitting between the Begin marker and the first header was
    // silently skipped. Fail loudly so a malformed envelope can't apply nothing
    // and report success.
    expect(() =>
      parsePatch(envelope('garbage line\n*** Add File: f.txt\n+x')),
    ).toThrow('expected a section header')
  })

  test('tolerates a blank line between sections (no over-throw)', () => {
    // A blank line separating two sections is incidental formatting and must be
    // skipped rather than rejected as a missing header.
    const { hunks } = parsePatch(
      envelope('*** Add File: a.txt\n+x\n\n*** Delete File: b.txt'),
    )
    expect(hunks.map(h => h.type)).toEqual(['add', 'delete'])
  })
})

describe('deriveNewContentsFromChunks', () => {
  const chunk = (over: Partial<UpdateFileChunk>): UpdateFileChunk => ({
    oldLines: [],
    newLines: [],
    changeContext: undefined,
    isEndOfFile: undefined,
    ...over,
  })

  test('applies an exact-match replacement', () => {
    const out = deriveNewContentsFromChunks(
      'f',
      [chunk({ oldLines: ['b'], newLines: ['B'] })],
      'a\nb\nc\n',
    )
    expect(out).toBe('a\nB\nc\n')
  })

  test('matches ignoring trailing whitespace (rstrip pass)', () => {
    const out = deriveNewContentsFromChunks(
      'f',
      [chunk({ oldLines: ['b'], newLines: ['B'] })],
      'a\nb   \nc\n',
    )
    expect(out).toBe('a\nB\nc\n')
  })

  test('matches ignoring leading whitespace (trim pass)', () => {
    const out = deriveNewContentsFromChunks(
      'f',
      [chunk({ oldLines: ['return x'], newLines: ['return y'] })],
      '  return x\n',
    )
    expect(out).toBe('return y\n')
  })

  test('matches across Unicode punctuation drift', () => {
    const out = deriveNewContentsFromChunks(
      'f',
      [chunk({ oldLines: ['say "hi"'], newLines: ['say "bye"'] })],
      'say \u201Chi\u201D\n',
    )
    expect(out).toBe('say "bye"\n')
  })

  test('inserts pure additions before the trailing blank line', () => {
    const out = deriveNewContentsFromChunks(
      'f',
      [chunk({ oldLines: [], newLines: ['inserted'] })],
      'a\nb\n',
    )
    expect(out).toBe('a\nb\ninserted\n')
  })

  test('seeks to a @@ context to disambiguate duplicate lines', () => {
    // Two `target` lines; the context anchors to the second occurrence.
    const original = 'target\nkeep\nctx\ntarget\n'
    const out = deriveNewContentsFromChunks(
      'f',
      [
        chunk({
          changeContext: 'ctx',
          oldLines: ['target'],
          newLines: ['TARGET'],
        }),
      ],
      original,
    )
    expect(out).toBe('target\nkeep\nctx\nTARGET\n')
  })

  test('throws when the old lines cannot be located', () => {
    expect(() =>
      deriveNewContentsFromChunks(
        'f',
        [chunk({ oldLines: ['nope'], newLines: ['x'] })],
        'a\nb\n',
      ),
    ).toThrow('Failed to find expected lines in f')
  })

  test('the EOF anchor matches the trailing occurrence, not the first', () => {
    // 'x' appears twice; isEndOfFile must steer the match to the last one.
    const original = 'x\nmid\nx\n'
    const anchored = deriveNewContentsFromChunks(
      'f',
      [chunk({ oldLines: ['x'], newLines: ['X'], isEndOfFile: true })],
      original,
    )
    expect(anchored).toBe('x\nmid\nX\n')
    // Without the anchor the first occurrence is replaced.
    const unanchored = deriveNewContentsFromChunks(
      'f',
      [chunk({ oldLines: ['x'], newLines: ['X'] })],
      original,
    )
    expect(unanchored).toBe('X\nmid\nx\n')
  })

  test('applies a chunk that carries a blank context line', () => {
    // The blank line between `alpha` and `beta` is real context; an Update that
    // keeps it (parsed as '') must still match and preserve it in the output.
    const out = deriveNewContentsFromChunks(
      'f',
      [chunk({ oldLines: ['alpha', '', 'beta'], newLines: ['alpha', '', 'BETA'] })],
      'alpha\n\nbeta\n',
    )
    expect(out).toBe('alpha\n\nBETA\n')
  })

  test('an unresolvable @@ falls back to an unambiguous block match', () => {
    // The anchor is only a search cursor. When it matches nothing, the hunk's own
    // lines still locate the edit — which is exactly what the model gets by
    // deleting the anchor and re-sending, so do it without the round trip.
    const out = deriveNewContentsFromChunks(
      'f',
      [chunk({ changeContext: 'ghost', oldLines: ['a'], newLines: ['b'] })],
      'a\n',
    )
    expect(out).toBe('b\n')
  })

  test('an unresolvable @@ still throws when the block is ambiguous', () => {
    // The fallback above must not silently pick one of several candidate regions:
    // that is a wrong edit reported as success.
    expect(() =>
      deriveNewContentsFromChunks(
        'f',
        [chunk({ changeContext: 'ghost', oldLines: ['a'], newLines: ['b'] })],
        'a\nx\na\n',
      ),
    ).toThrow("Failed to find context 'ghost'")
  })

  test('an unresolvable @@ on a pure insertion throws instead of appending at EOF', () => {
    // No old lines means nothing to fall back on, so a bad anchor must be fatal
    // rather than dropping the insertion at the end of the file.
    expect(() =>
      deriveNewContentsFromChunks(
        'f',
        [chunk({ changeContext: 'ghost', oldLines: [], newLines: ['x'] })],
        'a\nb\n',
      ),
    ).toThrow("Failed to find context 'ghost'")
  })

  // Regressions — these go through parsePatch so the chunk carries `ops`, which
  // is what drives the byte-preserving rebuild (manual chunks omit it).
  const deriveFromPatch = (body: string, original: string): string => {
    const { hunks } = parsePatch(`*** Begin Patch\n${body}\n*** End Patch`)
    if (hunks[0]?.type !== 'update') throw new Error('expected an update hunk')
    return deriveNewContentsFromChunks('f', hunks[0].chunks, original)
  }

  test('preserves original whitespace on a context line matched only by a fuzzy pass', () => {
    // File is tab-indented; the model emits the neighbouring context line with
    // spaces. The trim pass matches it, but the unchanged `\treturn 1` must keep
    // its tab — not be rewritten to the patch's spaces (silent Python/YAML/Make
    // corruption that still reports success).
    const original = 'def f():\n\treturn 1\n\tprint(2)\n'
    const out = deriveFromPatch(
      '*** Update File: f.py\n@@\n     return 1\n-\tprint(2)\n+\tprint(99)',
      original,
    )
    expect(out).toBe('def f():\n\treturn 1\n\tprint(99)\n')
  })

  test('preserves original Unicode punctuation on a fuzzy-matched context line', () => {
    // The file uses a smart quote; the patch's context line uses a straight
    // quote. Pass 4 matches them, but the untouched line must keep its original
    // bytes rather than adopt the patch's ASCII quote.
    const original = 'msg = \u201Chi\u201D\nx = 1\n'
    const out = deriveFromPatch(
      '*** Update File: f.py\n@@\n msg = "hi"\n-x = 1\n+x = 2',
      original,
    )
    expect(out).toBe('msg = \u201Chi\u201D\nx = 2\n')
  })

  test('a pure insertion anchored by @@ lands after the anchor, not at EOF', () => {
    const original = 'header\nmiddle\nfooter\n'
    const out = deriveFromPatch('*** Update File: f.txt\n@@ header\n+INSERTED', original)
    expect(out).toBe('header\nINSERTED\nmiddle\nfooter\n')
  })

  test('an un-anchored pure insertion still appends at EOF', () => {
    const original = 'a\nb\n'
    const out = deriveFromPatch('*** Update File: f.txt\n@@\n+inserted', original)
    expect(out).toBe('a\nb\ninserted\n')
  })

  test('the EOF anchor wins over an earlier exact match when the tail is fuzzy', () => {
    // Both lines are `log("x")` but the trailing one carries a stray space, so it
    // only matches on the rstrip pass. The EOF anchor must still steer the edit
    // to that last line — previously Pass 1's exact match on line 1 stole the
    // anchor and the wrong line was edited while the apply reported success.
    const original = 'log("x")\nlog("x") \n'
    const out = deriveFromPatch(
      '*** Update File: f\n@@\n-log("x")\n+log("y")\n*** End of File',
      original,
    )
    expect(out).toBe('log("x")\nlog("y")\n')
  })

  test('throws on overlapping hunks instead of silently dropping an insertion', () => {
    // A pure insertion lands at the trailing-blank index; a later chunk's removal
    // span covers that same index. The reverse splice used to let the removal
    // swallow the inserted line ('APPENDED' vanished) while reporting success.
    const original = 'intro\ncontent\n\n'
    expect(() =>
      deriveFromPatch(
        '*** Update File: f\n@@\n+APPENDED\n@@\n-content\n-\n+CONTENT',
        original,
      ),
    ).toThrow('Overlapping edits in f')
  })

  test('tolerates the @@ anchor restated as the first context line', () => {
    // `@@ foo` followed by ` foo` is the habit unified diff teaches. The search
    // resumes one line PAST the anchor, so this used to demand the line twice.
    const original = 'def f():\n  return 1\n'
    const out = deriveFromPatch(
      '*** Update File: f.py\n@@ def f():\n def f():\n-  return 1\n+  return 2',
      original,
    )
    expect(out).toBe('def f():\n  return 2\n')
  })

  test('tolerates the @@ anchor restated as the first removed line', () => {
    const original = 'def f():\n  return 1\n'
    const out = deriveFromPatch(
      '*** Update File: f.py\n@@ def f():\n-def f():\n+def g():',
      original,
    )
    expect(out).toBe('def g():\n  return 1\n')
  })

  test('tolerates two hunks that repeat one function signature as their anchor', () => {
    // The cursor only moves forward, so the second hunk's anchor sits behind it.
    // Its own lines are unambiguous, so the edit still lands.
    const original = 'def f(a):\n  x = 1\n  return x\n'
    const out = deriveFromPatch(
      '*** Update File: f.py\n@@ def f(a):\n-  x = 1\n+  x = 2\n@@ def f(a):\n-  return x\n+  return x * 2',
      original,
    )
    expect(out).toBe('def f(a):\n  x = 2\n  return x * 2\n')
  })

  test('rescues a @@ anchor truncated to a unique fragment of the real line', () => {
    const original = 'export function g(x: number): number {\n  return x\n}\n'
    const out = deriveFromPatch(
      '*** Update File: f.ts\n@@ function g(\n-  return x\n+  return x + 1',
      original,
    )
    expect(out).toBe('export function g(x: number): number {\n  return x + 1\n}\n')
  })

  test('does not rescue a fragment anchor that matches several lines', () => {
    // Two candidate lines contain the fragment, so it cannot be resolved; the
    // block itself is ambiguous too, so the whole hunk is refused.
    const original = 'function g(a) {}\nfunction g(b) {}\nreturn 1\nreturn 1\n'
    expect(() =>
      deriveFromPatch(
        '*** Update File: f.ts\n@@ function g(\n-return 1\n+return 2',
        original,
      ),
    ).toThrow("Failed to find context 'function g('")
  })

  test('names the divergence point when a block stops matching', () => {
    // The hunk drops the middle line. The message must say where it stopped
    // agreeing and what the file actually has there, not echo the block back.
    const original = 'import a\nimport b\nimport c\n'
    expect(() =>
      deriveFromPatch(
        '*** Update File: f.py\n@@\n import a\n-import c\n+import C',
        original,
      ),
    ).toThrow(
      /line\(s\) 1-1 of your hunk match starting at line 1[\s\S]*file line 2: import b/,
    )
  })

  test('says so when a block matches nowhere at all', () => {
    expect(() =>
      deriveFromPatch('*** Update File: f.py\n@@\n-nope\n+x', 'a\nb\n'),
    ).toThrow('none of the 1 line(s) below appear at or after line 1')
  })

  test('applies a hunk whose closing brace lost its leading space', () => {
    // The shape behind 6 of the 25 measured parse failures, end to end.
    const original = 'function f() {\n  return 1\n}\n'
    const out = deriveFromPatch(
      '*** Update File: f.ts\n@@ function f() {\n-  return 1\n+  return 2\n}',
      original,
    )
    expect(out).toBe('function f() {\n  return 2\n}\n')
  })

  test('an unprefixed line the model meant as an addition fails at apply time', () => {
    // The price of the parse-time leniency: a `+` the model forgot becomes a
    // context line. That is not silent — the line has to exist in the file, so
    // the applier refuses and names the divergence point. A strictly better
    // error than rejecting an otherwise-correct N-file patch at parse time.
    expect(() =>
      deriveFromPatch(
        '*** Update File: f.ts\n@@\n const a = 1\nconst b = 2\n-const c = 3\n+const c = 4',
        'const a = 1\nconst c = 3\n',
      ),
    ).toThrow('Failed to find expected lines in f')
  })
})
