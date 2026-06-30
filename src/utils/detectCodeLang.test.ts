import { describe, expect, test } from 'bun:test'
import { detectCodeLang, stripLineNumberPrefix } from './detectCodeLang.js'

// --- Source fixtures (each ≥ MIN_ANCHORS declaration lines) ---

const TS = `import { foo } from './foo'
export const A = 1
export function bar(x: number): number {
  return x + 1
}
export class Baz {
  method() { return 2 }
}
interface Qux { a: number }
type T = string`

const JS = `const foo = require('./foo')
function bar(x) {
  return x + 1
}
class Baz {
  method() { return 2 }
}
const y = 1`

const PY = `import os
from sys import path
def foo(x):
    return x + 1
class Bar:
    def method(self):
        return 2
def baz():
    pass`

const GO = `package main
import (
    "fmt"
)
func main() {
    fmt.Println("hi")
}
func helper(x int) int {
    return x
}
type T struct {
    A int
}`

const RUST = `use std::io;
pub fn main() {
    println!("hi");
}
struct Foo {
    a: i32,
}
impl Foo {
    fn bar(&self) -> i32 { self.a }
}
enum E { A, B }`

const JAVA = `package com.example;
import java.util.List;
public class Foo {
    private int x;
    public void bar() {}
}
public interface Baz {
    void qux();
}`

const KOTLIN = `package com.example
import kotlin.io.println
fun main() {
    println("hi")
}
class Foo(val a: Int) {
    fun bar(): Int = a
}
val x = 1`

const CSHARP = `using System;
namespace Demo {
    public class Foo {
        private int x;
        public void Bar() {}
    }
    public interface IBaz {
        void Qux();
    }
}`

describe('detectCodeLang — positives', () => {
  test.each([
    ['typescript', TS],
    ['typescript', JS], // JS collapses to the TS spec
    ['python', PY],
    ['go', GO],
    ['rust', RUST],
    ['java', JAVA],
    ['kotlin', KOTLIN],
    ['csharp', CSHARP],
  ])('detects %s', (lang, src) => {
    expect(detectCodeLang(src)).toBe(lang as ReturnType<typeof detectCodeLang>)
  })

  test('detects after a cat -n numeric+tab prefix is stripped', () => {
    const withGutter = TS.split('\n')
      .map((l, i) => `   ${i + 1}\t${l}`)
      .join('\n')
    // Raw (prefixed) does not detect; the strip path recovers it.
    const stripped = stripLineNumberPrefix(withGutter.split('\n')).join('\n')
    expect(detectCodeLang(stripped)).toBe('typescript')
  })

  test('detects after a grep -n single-file numeric+colon prefix is stripped', () => {
    const withGutter = PY.split('\n')
      .map((l, i) => `${i + 1}:${l}`)
      .join('\n')
    const stripped = stripLineNumberPrefix(withGutter.split('\n')).join('\n')
    expect(detectCodeLang(stripped)).toBe('python')
  })
})

describe('detectCodeLang — negatives (must be null)', () => {
  test('English prose', () => {
    const prose = `The quick brown fox jumps over the lazy dog. This is a
paragraph of ordinary text that mentions a function in passing but is
clearly not source code. We import nothing here; we just write sentences
about classes of animals and types of weather.`
    expect(detectCodeLang(prose)).toBeNull()
  })

  test('unified diff (git show <sha>) — guarded even past MIN_ANCHORS', () => {
    // Load-bearing for DIFF_MARKER_RE specifically: the context lines (leading
    // single space) ARE declarations, so this scores ≥ MIN_ANCHORS. Without the
    // diff guard it would mis-detect as TS — so deleting the guard turns this
    // test red (MIN_ANCHORS alone no longer rejects it).
    const diff = `diff --git a/foo.ts b/foo.ts
index 1234abc..5678def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,6 +1,7 @@
 import { foo } from './foo'
 export const A = 1
 export function bar() {}
 export class Baz {}
 interface Qux { a: number }
+type T = string`
    expect(detectCodeLang(diff)).toBeNull()
  })

  test('log dump', () => {
    const log = Array.from(
      { length: 20 },
      (_, i) => `2026-01-01 12:00:${String(i).padStart(2, '0')} INFO request handled ok`,
    ).join('\n')
    expect(detectCodeLang(log)).toBeNull()
  })

  test('multi-file grep output (path:line:)', () => {
    const grep = `src/a.ts:12:export const A = 1
src/b.ts:3:import { x } from './x'
src/c.ts:99:function helper() {}`
    expect(detectCodeLang(grep)).toBeNull()
  })

  test('sparse grep -n single-file (non-consecutive line numbers)', () => {
    // grep -n on one file, matches non-adjacent: the `NN:` prefixes are NOT
    // consecutive, so stripLineNumberPrefix leaves them in place and the
    // `NN:`-prefixed lines no longer match the anchors → null (→ head/tail).
    const grep = `12:import { foo } from './foo'
48:export const A = 1
73:export function bar() {}
99:export class Baz {}
140:interface Qux { a: number }`
    const stripped = stripLineNumberPrefix(grep.split('\n')).join('\n')
    expect(detectCodeLang(stripped)).toBeNull()
  })

  test('consecutive grep -n block starting past line 1 (offset)', () => {
    // grep -n matched an unbroken block at lines 50-64: contiguous but NOT
    // numbered from 1, so stripping would label ranges off by 49. Left
    // unstripped → the `NN:` prefixes defeat the anchors → null. (Without the
    // start==1 gate this would strip and mis-detect 5 functions as TS.)
    const lines: string[] = []
    let ln = 50
    for (let i = 0; i < 5; i++) {
      lines.push(`${ln++}:export function fn${i}() {`)
      lines.push(`${ln++}:  return ${i}`)
      lines.push(`${ln++}:}`)
    }
    const stripped = stripLineNumberPrefix(lines).join('\n')
    expect(detectCodeLang(stripped)).toBeNull()
  })

  test('single-marker unified diff (truncated, no git header)', () => {
    // One `@@` hunk header, no diff/index/---/+++ lines → only 1 weak marker
    // (< DIFF_MARKER_MIN), but the hunk header alone is decisive. The context
    // lines (leading space) are ≥ MIN_ANCHORS declarations, so without the
    // hunk-header guard this mis-detects as TS.
    const diff = `@@ -1,6 +1,7 @@
 import { foo } from './foo'
 export const A = 1
 export function bar() {}
 export class Baz {}
 interface Qux { a: number }
+type T = string`
    expect(detectCodeLang(diff)).toBeNull()
  })

  test('header-only diff (--- / +++) with no hunk header', () => {
    // No `@@`, but two weak markers (≥ DIFF_MARKER_MIN) still reject — keeps
    // DIFF_MARKER_RE load-bearing alongside the hunk-header guard.
    const diff = `--- a/foo.ts
+++ b/foo.ts
 import { foo } from './foo'
 export const A = 1
 export function bar() {}
 export class Baz {}
 interface Qux { a: number }`
    expect(detectCodeLang(diff)).toBeNull()
  })

  test('JSON array', () => {
    const json = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({ id: i, name: `n${i}` })),
      null,
      2,
    )
    expect(detectCodeLang(json)).toBeNull()
  })

  test('short snippet (below MIN_ANCHORS)', () => {
    expect(detectCodeLang('const a = 1\nconst b = 2')).toBeNull()
  })

  test('whole-text markdown (prose page)', () => {
    const md = `# Title

Some intro prose about the project and how it works.

## Section

More prose here. Nothing structural to outline.`
    expect(detectCodeLang(md)).toBeNull()
  })

  test('empty / blank', () => {
    expect(detectCodeLang('')).toBeNull()
    expect(detectCodeLang('\n\n  \n')).toBeNull()
  })
})

describe('stripLineNumberPrefix', () => {
  test('preserves line count and positions (range-alignment invariant)', () => {
    const lines = TS.split('\n')
    const gutter = lines.map((l, i) => `${i + 1}:${l}`)
    const out = stripLineNumberPrefix(gutter)
    expect(out.length).toBe(lines.length)
    expect(out).toEqual(lines)
  })

  test('leaves text unchanged when prefixes are not uniform', () => {
    const lines = ['const a = 1', '42 is the answer', 'function f() {}']
    expect(stripLineNumberPrefix(lines)).toEqual(lines)
  })

  test('leaves a sparse grep -n dump unchanged (non-consecutive numbers)', () => {
    // All three lines are prefixed (fraction 1.0 ≥ threshold), but 12/48/99 is
    // not a contiguous run, so stripping would misalign scanSymbols' ranges.
    const sparse = [
      '12:export const A = 1',
      '48:export function bar() {}',
      '99:export class Baz {}',
    ]
    expect(stripLineNumberPrefix(sparse)).toEqual(sparse)
  })

  test('leaves a consecutive grep -n block at an offset unchanged (start ≠ 1)', () => {
    // Contiguous (50,51,52) but not numbered from 1 → stripping would shift
    // every derived range by 49, so it must be left intact.
    const offset = [
      '50:export function foo() {',
      '51:  return 1',
      '52:}',
    ]
    expect(stripLineNumberPrefix(offset)).toEqual(offset)
  })

  test('does not strip normal code that starts with a digit-less line', () => {
    const lines = TS.split('\n')
    expect(stripLineNumberPrefix(lines)).toEqual(lines)
  })
})
