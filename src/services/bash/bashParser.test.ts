/**
 * Characterization tests for src/services/bash/bashParser.ts.
 *
 * This file is the safety net for the 11f split (PR2: tokens/lexer/context;
 * PR3: commands/words/expressions). It exercises parseSource directly via
 * getParserModule().parse(src) so regressions in any future submodule surface
 * locally — not as distant failures in downstream classifiers.
 *
 * Conventions:
 *   - Use Infinity as the timeout for happy-path tests so CI jitter doesn't
 *     flap (see bashParser.ts l.24-28).
 *   - Snapshots use shape() (type + children only), not text/offsets. Offsets
 *     are validated by a small set of dedicated numeric asserts.
 *   - Abort paths (deep nesting / tight timeout) use smoke asserts, not exact
 *     values of MAX_NODES / PARSE_TIMEOUT_MS.
 */

import { describe, expect, test } from 'bun:test'
import {
  ensureParserInitialized,
  getParserModule,
  type TsNode,
} from './bashParser.js'

type Shape = { type: string; children: Shape[] }

function parse(src: string, timeoutMs: number = Infinity): TsNode | null {
  const mod = getParserModule()
  if (!mod) throw new Error('parser module unavailable')
  return mod.parse(src, timeoutMs)
}

function shape(node: TsNode | null): Shape | null {
  if (!node) return null
  return {
    type: node.type,
    children: node.children.map(c => shape(c)!),
  }
}

// ────────────────────────────── 1. API ──────────────────────────────

describe('bashParser API', () => {
  test('ensureParserInitialized resolves', async () => {
    await expect(ensureParserInitialized()).resolves.toBeUndefined()
  })

  test('getParserModule returns a module with parse()', () => {
    const mod = getParserModule()
    expect(mod).not.toBeNull()
    expect(typeof mod!.parse).toBe('function')
  })

  test('empty source returns an empty program AST', () => {
    expect(shape(parse(''))).toMatchSnapshot()
  })

  test('whitespace-only source parses', () => {
    expect(shape(parse('   \n\t  \n'))).toMatchSnapshot()
  })

  test('smoke: echo hello has expected program shape', () => {
    expect(shape(parse('echo hello'))).toMatchSnapshot()
  })
})

// ─────────────────────────── 2. Tokenizer ───────────────────────────

describe('bashParser tokenizer — operators', () => {
  test('pipe', () => {
    expect(shape(parse('a | b'))).toMatchSnapshot()
  })
  test('logical or', () => {
    expect(shape(parse('a || b'))).toMatchSnapshot()
  })
  test('logical and', () => {
    expect(shape(parse('a && b'))).toMatchSnapshot()
  })
  test('semicolon list', () => {
    expect(shape(parse('a; b'))).toMatchSnapshot()
  })
  test('background &', () => {
    expect(shape(parse('a &'))).toMatchSnapshot()
  })
  test('redirect out >', () => {
    expect(shape(parse('a > out'))).toMatchSnapshot()
  })
  test('redirect append >>', () => {
    expect(shape(parse('a >> out'))).toMatchSnapshot()
  })
  test('redirect in <', () => {
    expect(shape(parse('a < in'))).toMatchSnapshot()
  })
  test('here-string <<<', () => {
    expect(shape(parse('a <<< hello'))).toMatchSnapshot()
  })
  test('open read-write <>', () => {
    expect(shape(parse('a <> file'))).toMatchSnapshot()
  })
  test('duplicate stdout >&', () => {
    expect(shape(parse('a >&2'))).toMatchSnapshot()
  })
  test('duplicate stdin <&', () => {
    expect(shape(parse('a <&0'))).toMatchSnapshot()
  })
})

describe('bashParser tokenizer — quotes', () => {
  test('single quotes', () => {
    expect(shape(parse(`echo 'hello world'`))).toMatchSnapshot()
  })
  test('double quotes', () => {
    expect(shape(parse(`echo "hello world"`))).toMatchSnapshot()
  })
  test('double quotes with escape', () => {
    expect(shape(parse(`echo "a \\"b\\" c"`))).toMatchSnapshot()
  })
  test('ANSI-C string', () => {
    expect(shape(parse(`echo $'a\\nb'`))).toMatchSnapshot()
  })
  test('adjacent strings concatenate', () => {
    expect(shape(parse(`echo 'a'"b"c`))).toMatchSnapshot()
  })
  test('empty double quotes', () => {
    expect(shape(parse(`echo ""`))).toMatchSnapshot()
  })
  test('empty single quotes', () => {
    expect(shape(parse(`echo ''`))).toMatchSnapshot()
  })
})

describe('bashParser tokenizer — dollar forms', () => {
  test('simple $var', () => {
    expect(shape(parse('echo $foo'))).toMatchSnapshot()
  })
  test('${var}', () => {
    expect(shape(parse('echo ${foo}'))).toMatchSnapshot()
  })
  test('$(cmd)', () => {
    expect(shape(parse('echo $(date)'))).toMatchSnapshot()
  })
  test('$((arith))', () => {
    expect(shape(parse('echo $((1+2))'))).toMatchSnapshot()
  })
  test('backticks `cmd`', () => {
    expect(shape(parse('echo `date`'))).toMatchSnapshot()
  })
  test('$1 positional', () => {
    expect(shape(parse('echo $1'))).toMatchSnapshot()
  })
  test('$@ special', () => {
    expect(shape(parse('echo $@'))).toMatchSnapshot()
  })
  test('$? special', () => {
    expect(shape(parse('echo $?'))).toMatchSnapshot()
  })
})

describe('bashParser tokenizer — heredocs', () => {
  test('plain heredoc', () => {
    expect(shape(parse('cat <<EOF\nhi\nEOF\n'))).toMatchSnapshot()
  })
  test('heredoc with tab-stripping <<-', () => {
    expect(shape(parse('cat <<-EOF\n\thi\n\tEOF\n'))).toMatchSnapshot()
  })
  test('quoted heredoc (no expansion)', () => {
    expect(shape(parse(`cat <<'EOF'\n$nope\nEOF\n`))).toMatchSnapshot()
  })
  test('heredoc body retains content', () => {
    expect(
      shape(parse('cat <<END\nline1\nline2\nEND\n')),
    ).toMatchSnapshot()
  })
})

describe('bashParser tokenizer — misc', () => {
  test('comment-only', () => {
    expect(shape(parse('# just a comment\n'))).toMatchSnapshot()
  })
  test('trailing comment after command', () => {
    expect(shape(parse('ls # list\n'))).toMatchSnapshot()
  })
  test('line continuation', () => {
    expect(shape(parse('echo \\\n hello'))).toMatchSnapshot()
  })
})

// ──────────────────── 3. Simple commands / redirects / assigns ────────────────────

describe('bashParser simple commands', () => {
  test('command with args', () => {
    expect(shape(parse('cmd a b c'))).toMatchSnapshot()
  })
  test('command with flag', () => {
    expect(shape(parse('ls -la /tmp'))).toMatchSnapshot()
  })
  test('command with env prefix', () => {
    expect(shape(parse('VAR=val cmd'))).toMatchSnapshot()
  })
  test('multiple env prefixes', () => {
    expect(shape(parse('A=1 B=2 cmd'))).toMatchSnapshot()
  })
  test('empty assignment', () => {
    expect(shape(parse('VAR= cmd'))).toMatchSnapshot()
  })
  test('top-level assignment (no command)', () => {
    expect(shape(parse('FOO=bar'))).toMatchSnapshot()
  })
  test('quoted argument', () => {
    expect(shape(parse(`echo "hello $USER"`))).toMatchSnapshot()
  })
})

describe('bashParser redirects', () => {
  test('stdout to file', () => {
    expect(shape(parse('cmd > out.log'))).toMatchSnapshot()
  })
  test('stderr to file 2>', () => {
    expect(shape(parse('cmd 2> err.log'))).toMatchSnapshot()
  })
  test('combined redirect 2>&1', () => {
    expect(shape(parse('cmd > out 2>&1'))).toMatchSnapshot()
  })
  test('append stderr 2>>', () => {
    expect(shape(parse('cmd 2>> err'))).toMatchSnapshot()
  })
  test('null output >/dev/null', () => {
    expect(shape(parse('cmd > /dev/null'))).toMatchSnapshot()
  })
  test('input redirect', () => {
    expect(shape(parse('sort < unsorted.txt'))).toMatchSnapshot()
  })
  test('multiple redirects in one command', () => {
    expect(shape(parse('cmd < in > out 2> err'))).toMatchSnapshot()
  })
})

describe('bashParser arrays and subscripts', () => {
  test('array literal', () => {
    expect(shape(parse('arr=(a b c)'))).toMatchSnapshot()
  })
  test('empty array', () => {
    expect(shape(parse('arr=()'))).toMatchSnapshot()
  })
  test('indexed assignment arr[0]=x', () => {
    expect(shape(parse('arr[0]=x'))).toMatchSnapshot()
  })
  test('${arr[0]} subscript expansion', () => {
    expect(shape(parse('echo ${arr[0]}'))).toMatchSnapshot()
  })
  test('${arr[@]} all elements', () => {
    expect(shape(parse('echo ${arr[@]}'))).toMatchSnapshot()
  })
  test('${#arr[@]} length', () => {
    expect(shape(parse('echo ${#arr[@]}'))).toMatchSnapshot()
  })
})

// ──────────────────── 4. Pipelines + and/or + negation ────────────────────

describe('bashParser pipelines and lists', () => {
  test('two-stage pipe', () => {
    expect(shape(parse('ls | wc'))).toMatchSnapshot()
  })
  test('three-stage pipe', () => {
    expect(shape(parse('a | b | c'))).toMatchSnapshot()
  })
  test('and-or chain', () => {
    expect(shape(parse('a && b || c'))).toMatchSnapshot()
  })
  test('negated command', () => {
    expect(shape(parse('! grep foo bar'))).toMatchSnapshot()
  })
  test('time prefix', () => {
    expect(shape(parse('time ls'))).toMatchSnapshot()
  })
  test('multiple semicolon list', () => {
    expect(shape(parse('a; b; c'))).toMatchSnapshot()
  })
  test('newline-separated list', () => {
    expect(shape(parse('a\nb\nc'))).toMatchSnapshot()
  })
  test('pipe with redirect on last', () => {
    expect(shape(parse('a | b > out'))).toMatchSnapshot()
  })
})

// ──────────────────── 5. Control structures ────────────────────

describe('bashParser if statement', () => {
  test('plain if then fi', () => {
    expect(shape(parse('if x; then y; fi'))).toMatchSnapshot()
  })
  test('if then else fi', () => {
    expect(shape(parse('if x; then y; else z; fi'))).toMatchSnapshot()
  })
  test('if elif else fi', () => {
    expect(
      shape(parse('if a; then 1; elif b; then 2; else 3; fi')),
    ).toMatchSnapshot()
  })
  test('multiline if', () => {
    expect(
      shape(parse('if true\nthen\n  echo yes\nfi')),
    ).toMatchSnapshot()
  })
})

describe('bashParser while/until', () => {
  test('while loop', () => {
    expect(shape(parse('while x; do y; done'))).toMatchSnapshot()
  })
  test('while true infinite', () => {
    expect(shape(parse('while true; do :; done'))).toMatchSnapshot()
  })
})

describe('bashParser for loop', () => {
  test('for in list', () => {
    expect(shape(parse('for x in a b c; do echo $x; done'))).toMatchSnapshot()
  })
  test('for in empty', () => {
    expect(shape(parse('for x in; do echo $x; done'))).toMatchSnapshot()
  })
  test('c-style for', () => {
    expect(
      shape(parse('for ((i=0;i<10;i++)); do echo $i; done')),
    ).toMatchSnapshot()
  })
  test('for without in (positional)', () => {
    expect(shape(parse('for x; do echo $x; done'))).toMatchSnapshot()
  })
})

describe('bashParser case statement', () => {
  test('two-pattern case', () => {
    expect(
      shape(parse('case $x in\n  a) echo 1 ;;\n  b) echo 2 ;;\nesac')),
    ).toMatchSnapshot()
  })
  test('case with default', () => {
    expect(
      shape(parse('case $x in\n  a) echo 1 ;;\n  *) echo other ;;\nesac')),
    ).toMatchSnapshot()
  })
  test('case with multiple patterns per branch', () => {
    expect(
      shape(parse('case $x in\n  a|b|c) echo abc ;;\nesac')),
    ).toMatchSnapshot()
  })
  test('case fallthrough ;&', () => {
    expect(
      shape(parse('case $x in\n  a) echo 1 ;&\n  b) echo 2 ;;\nesac')),
    ).toMatchSnapshot()
  })
})

describe('bashParser function definitions', () => {
  test('POSIX function', () => {
    expect(shape(parse('foo() { echo hi; }'))).toMatchSnapshot()
  })
  test('function keyword form', () => {
    expect(shape(parse('function foo { echo hi; }'))).toMatchSnapshot()
  })
  test('function keyword with parens', () => {
    expect(shape(parse('function foo() { echo hi; }'))).toMatchSnapshot()
  })
  test('multiline function body', () => {
    expect(
      shape(parse('foo() {\n  echo a\n  echo b\n}')),
    ).toMatchSnapshot()
  })
})

describe('bashParser subshells and groups', () => {
  test('subshell parens', () => {
    expect(shape(parse('(cd /tmp && ls)'))).toMatchSnapshot()
  })
  test('compound group braces', () => {
    expect(shape(parse('{ a; b; }'))).toMatchSnapshot()
  })
  test('subshell with redirect', () => {
    expect(shape(parse('(a; b) > out'))).toMatchSnapshot()
  })
})

// ──────────────────── 6. Parameter expansion ${...} ────────────────────

describe('bashParser parameter expansion — defaults', () => {
  test('${var:-default}', () => {
    expect(shape(parse('echo ${x:-default}'))).toMatchSnapshot()
  })
  test('${var:=assign}', () => {
    expect(shape(parse('echo ${x:=val}'))).toMatchSnapshot()
  })
  test('${var:?error}', () => {
    expect(shape(parse('echo ${x:?missing}'))).toMatchSnapshot()
  })
  test('${var:+alt}', () => {
    expect(shape(parse('echo ${x:+alt}'))).toMatchSnapshot()
  })
  test('${var-default} no colon', () => {
    expect(shape(parse('echo ${x-default}'))).toMatchSnapshot()
  })
})

describe('bashParser parameter expansion — length and slice', () => {
  test('${#var}', () => {
    expect(shape(parse('echo ${#x}'))).toMatchSnapshot()
  })
  test('${var:offset}', () => {
    expect(shape(parse('echo ${x:2}'))).toMatchSnapshot()
  })
  test('${var:offset:length}', () => {
    expect(shape(parse('echo ${x:2:5}'))).toMatchSnapshot()
  })
})

describe('bashParser parameter expansion — pattern substitution', () => {
  test('${var/pat/repl}', () => {
    expect(shape(parse('echo ${x/foo/bar}'))).toMatchSnapshot()
  })
  test('${var//pat/repl}', () => {
    expect(shape(parse('echo ${x//foo/bar}'))).toMatchSnapshot()
  })
  test('${var/#pat/repl} prefix', () => {
    expect(shape(parse('echo ${x/#foo/bar}'))).toMatchSnapshot()
  })
  test('${var/%pat/repl} suffix', () => {
    expect(shape(parse('echo ${x/%foo/bar}'))).toMatchSnapshot()
  })
})

describe('bashParser parameter expansion — case and quoting', () => {
  test('${var^^} uppercase', () => {
    expect(shape(parse('echo ${x^^}'))).toMatchSnapshot()
  })
  test('${var,,} lowercase', () => {
    expect(shape(parse('echo ${x,,}'))).toMatchSnapshot()
  })
  test('${var@Q} quoted', () => {
    expect(shape(parse('echo ${x@Q}'))).toMatchSnapshot()
  })
})

describe('bashParser parameter expansion — indirect', () => {
  test('${!var}', () => {
    expect(shape(parse('echo ${!x}'))).toMatchSnapshot()
  })
  test('${!prefix*}', () => {
    expect(shape(parse('echo ${!prefix*}'))).toMatchSnapshot()
  })
  test('${!prefix@}', () => {
    expect(shape(parse('echo ${!prefix@}'))).toMatchSnapshot()
  })
})

// ──────────────────── 7. [[...]] test expressions ────────────────────

describe('bashParser [[...]] string comparisons', () => {
  test('equality ==', () => {
    expect(shape(parse('[[ $a == $b ]]'))).toMatchSnapshot()
  })
  test('inequality !=', () => {
    expect(shape(parse('[[ $a != $b ]]'))).toMatchSnapshot()
  })
  test('less than <', () => {
    expect(shape(parse('[[ $a < $b ]]'))).toMatchSnapshot()
  })
  test('greater than >', () => {
    expect(shape(parse('[[ $a > $b ]]'))).toMatchSnapshot()
  })
  test('regex =~', () => {
    expect(shape(parse('[[ $a =~ ^foo$ ]]'))).toMatchSnapshot()
  })
})

describe('bashParser [[...]] file tests', () => {
  test('-f file', () => {
    expect(shape(parse('[[ -f /etc/hosts ]]'))).toMatchSnapshot()
  })
  test('-d dir', () => {
    expect(shape(parse('[[ -d /tmp ]]'))).toMatchSnapshot()
  })
  test('-e exists', () => {
    expect(shape(parse('[[ -e /var ]]'))).toMatchSnapshot()
  })
  test('-z empty string', () => {
    expect(shape(parse('[[ -z $x ]]'))).toMatchSnapshot()
  })
  test('-n non-empty', () => {
    expect(shape(parse('[[ -n $x ]]'))).toMatchSnapshot()
  })
})

describe('bashParser [[...]] boolean ops', () => {
  test('&& and', () => {
    expect(shape(parse('[[ -f a && -f b ]]'))).toMatchSnapshot()
  })
  test('|| or', () => {
    expect(shape(parse('[[ -f a || -f b ]]'))).toMatchSnapshot()
  })
  test('! negation', () => {
    expect(shape(parse('[[ ! -f a ]]'))).toMatchSnapshot()
  })
  test('parens grouping', () => {
    expect(shape(parse('[[ ( -f a || -f b ) && -d /tmp ]]'))).toMatchSnapshot()
  })
})

describe('bashParser [[...]] extglob', () => {
  test('@(...) one of', () => {
    expect(shape(parse('[[ $x == @(a|b|c) ]]'))).toMatchSnapshot()
  })
  test('?(...) zero or one', () => {
    expect(shape(parse('[[ $x == ?(foo) ]]'))).toMatchSnapshot()
  })
  test('*(...) zero or more', () => {
    expect(shape(parse('[[ $x == *(foo) ]]'))).toMatchSnapshot()
  })
  test('+(...) one or more', () => {
    expect(shape(parse('[[ $x == +(foo) ]]'))).toMatchSnapshot()
  })
  test('!(...) negation', () => {
    expect(shape(parse('[[ $x == !(foo) ]]'))).toMatchSnapshot()
  })
})

// ──────────────────── 8. (( arithmetic )) ────────────────────

describe('bashParser arithmetic — operators', () => {
  test('addition', () => {
    expect(shape(parse('(( a + b ))'))).toMatchSnapshot()
  })
  test('subtraction', () => {
    expect(shape(parse('(( a - b ))'))).toMatchSnapshot()
  })
  test('multiplication', () => {
    expect(shape(parse('(( a * b ))'))).toMatchSnapshot()
  })
  test('division', () => {
    expect(shape(parse('(( a / b ))'))).toMatchSnapshot()
  })
  test('modulo', () => {
    expect(shape(parse('(( a % b ))'))).toMatchSnapshot()
  })
  test('power **', () => {
    expect(shape(parse('(( a ** b ))'))).toMatchSnapshot()
  })
  test('bitshift << >>', () => {
    expect(shape(parse('(( a << 2 | b >> 1 ))'))).toMatchSnapshot()
  })
  test('bitwise & | ^ ~', () => {
    expect(shape(parse('(( (a & b) | (c ^ ~d) ))'))).toMatchSnapshot()
  })
})

describe('bashParser arithmetic — comparisons and logic', () => {
  test('equality ==', () => {
    expect(shape(parse('(( a == b ))'))).toMatchSnapshot()
  })
  test('less-equal <=', () => {
    expect(shape(parse('(( a <= b ))'))).toMatchSnapshot()
  })
  test('logical && ||', () => {
    expect(shape(parse('(( a > 0 && b < 10 ))'))).toMatchSnapshot()
  })
  test('not !', () => {
    expect(shape(parse('(( ! a ))'))).toMatchSnapshot()
  })
})

describe('bashParser arithmetic — assignments and ternary', () => {
  test('assign =', () => {
    expect(shape(parse('(( a = 1 ))'))).toMatchSnapshot()
  })
  test('compound +=', () => {
    expect(shape(parse('(( a += 5 ))'))).toMatchSnapshot()
  })
  test('compound mix', () => {
    expect(shape(parse('(( a -= 1, b *= 2, c /= 3 ))'))).toMatchSnapshot()
  })
  test('ternary', () => {
    expect(shape(parse('(( a > 0 ? 1 : -1 ))'))).toMatchSnapshot()
  })
})

describe('bashParser arithmetic — inc/dec', () => {
  test('post-increment', () => {
    expect(shape(parse('(( a++ ))'))).toMatchSnapshot()
  })
  test('pre-increment', () => {
    expect(shape(parse('(( ++a ))'))).toMatchSnapshot()
  })
  test('post-decrement', () => {
    expect(shape(parse('(( a-- ))'))).toMatchSnapshot()
  })
  test('pre-decrement', () => {
    expect(shape(parse('(( --a ))'))).toMatchSnapshot()
  })
})

describe('bashParser arithmetic — number bases', () => {
  test('hex 0x10', () => {
    expect(shape(parse('(( a = 0x10 ))'))).toMatchSnapshot()
  })
  test('octal 0o7', () => {
    expect(shape(parse('(( a = 0o7 ))'))).toMatchSnapshot()
  })
  test('explicit base 2#101', () => {
    expect(shape(parse('(( a = 2#101 ))'))).toMatchSnapshot()
  })
  test('explicit base 16#ff', () => {
    expect(shape(parse('(( a = 16#ff ))'))).toMatchSnapshot()
  })
})

// ──────────────────── 9. Edge cases + offsets + limits ────────────────────

describe('bashParser edge cases', () => {
  test('only newlines', () => {
    expect(shape(parse('\n\n\n'))).toMatchSnapshot()
  })
  test('multiple comments only', () => {
    expect(shape(parse('# one\n# two\n# three\n'))).toMatchSnapshot()
  })
  test('semicolon-only', () => {
    expect(shape(parse(';'))).toMatchSnapshot()
  })
  test('command after comment', () => {
    expect(shape(parse('# c\nls\n'))).toMatchSnapshot()
  })
  test('declaration: export', () => {
    expect(shape(parse('export FOO=bar'))).toMatchSnapshot()
  })
  test('declaration: local', () => {
    expect(shape(parse('local x=1'))).toMatchSnapshot()
  })
  test('declaration: readonly', () => {
    expect(shape(parse('readonly X=1'))).toMatchSnapshot()
  })
  test('declaration: unset', () => {
    expect(shape(parse('unset FOO BAR'))).toMatchSnapshot()
  })
})

describe('bashParser UTF-8 byte offsets', () => {
  test('ASCII offsets are byte-aligned with string indices', () => {
    const src = 'echo hello'
    const ast = parse(src)!
    expect(ast.startIndex).toBe(0)
    expect(ast.endIndex).toBe(10)
  })

  test('UTF-8 multibyte: ç is 2 bytes', () => {
    // "ação" is 6 bytes (a=1, ç=2, ã=2, o=1)
    const src = 'echo ação'
    const ast = parse(src)!
    // 'echo ' = 5 bytes, then 6 bytes for "ação" = 11 total
    expect(ast.endIndex).toBe(11)
  })

  test('UTF-8 4-byte sequence (emoji)', () => {
    // "echo " (5) + 😀 (4 bytes) = 9
    const src = 'echo 😀'
    const ast = parse(src)!
    expect(ast.endIndex).toBe(9)
  })

  test('CJK multibyte (3 bytes each)', () => {
    // "echo " (5) + 验证 (3 + 3 = 6) = 11
    const src = 'echo 验证'
    const ast = parse(src)!
    expect(ast.endIndex).toBe(11)
  })

  test('startIndex/endIndex inside multibyte string match byte offsets', () => {
    const src = 'a 验 b' // 1 + 1 + 3 + 1 + 1 = 7 bytes
    const ast = parse(src)!
    expect(ast.startIndex).toBe(0)
    expect(ast.endIndex).toBe(7)
  })
})

describe('bashParser limits and abort paths', () => {
  test('unterminated heredoc does not crash', () => {
    // Should either return a partial AST or null; either is fine — must not throw
    expect(() => parse('cat <<EOF\nbody without terminator')).not.toThrow()
  })

  test('deeply nested input returns null instead of crashing (smoke)', () => {
    // Build a pathologically nested arithmetic expression — many thousands of
    // nested parens. Should bail via MAX_NODES (or the timeout) and return null
    // rather than crashing the process.
    const depth = 60_000
    const src = '(( ' + '('.repeat(depth) + '1' + ')'.repeat(depth) + ' ))'
    const result = parse(src, Infinity)
    expect(result).toBeNull()
  })

  test('extremely tight timeout aborts non-trivial input (smoke)', () => {
    // Use timeout=0 to force the budget check to fire on the first non-trivial
    // node. The exact threshold is implementation detail; we only require that
    // (a) it doesn't throw, and (b) for clearly non-trivial input, an
    // unreasonably small budget can return null.
    const src = 'a | b | c | d | e | f ; '.repeat(200)
    expect(() => parse(src, 0)).not.toThrow()
  })

  test('parse(src, Infinity) on substantial input succeeds', () => {
    // Sanity check that disabling the timeout does what the docstring claims.
    const src = 'a; '.repeat(500)
    const ast = parse(src, Infinity)
    expect(ast).not.toBeNull()
    expect(ast!.type).toBe('program')
  })
})
