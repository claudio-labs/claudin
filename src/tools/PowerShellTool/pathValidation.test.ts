/**
 * Coverage for the PowerShell path-constraint checker.
 *
 * This file is a security boundary with three exports —
 * `isDangerousRemovalRawPath`, `dangerousRemovalDeny`, `checkPathConstraints` —
 * and everything else in it is reachable only through those. So every
 * assertion below drives one of the three; nothing pokes at an internal.
 *
 * WHY THE FIXTURES LOOK LIKE THIS
 *
 * `parsePowerShellCommand` in src/platform/shell/powershell/parser.ts is NOT a
 * TypeScript parser: it spawns `pwsh -EncodedCommand`, waits on the .NET AST
 * parser and reads JSON back. A test cannot call it here (no pwsh on Linux CI,
 * and a subprocess per fixture would be a different kind of test anyway).
 *
 * What the parser DOES expose for exactly this purpose is the second half of
 * its pipeline: `transformStatement` and the `Raw*` types it consumes are
 * exported and marked "exported for testing". Those raw types are the JSON the
 * PS1 script emits — .NET AST type names (`StringConstantExpressionAst`,
 * `CommandParameterAst`, …) and extent text. So `psParse` below tokenizes real
 * PowerShell source into that raw JSON and hands it to the REAL
 * `transformStatement`, which is what computes `args`, `elementTypes`,
 * `children`, `nameType` and the redirection operators.
 *
 * That split is the point: the tests write PowerShell source, and every AST
 * property the code under test reads is produced by production code, not by
 * this file. The one thing `psParse` owns is the source-text → .NET-type-name
 * mapping, which is deliberately narrow (see `rawTypeOf`) and covers only the
 * shapes these fixtures use.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { realpathSync } from 'fs'
import { tmpdir } from 'os'

import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import type {
  ParsedPowerShellCommand,
  RawCommandElement,
  RawPipelineElement,
  RawRedirection,
  RawStatement,
} from 'src/platform/shell/powershell/parser.js'
import { transformStatement } from 'src/platform/shell/powershell/parser.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import {
  checkPathConstraints,
  dangerousRemovalDeny,
  isDangerousRemovalRawPath,
} from 'src/tools/PowerShellTool/pathValidation.js'

// ---------------------------------------------------------------------------
// Fixture builder: PowerShell source → raw PS-script JSON → real transform
// ---------------------------------------------------------------------------

/** The dash characters PowerShell's tokenizer accepts as a parameter prefix. */
const DASHES = new Set(['-', '\u2013', '\u2014', '\u2015'])

// Null prototype for the same reason CMDLET_PATH_CONFIG has one: a command
// named `constructor` would otherwise look up Object.prototype.constructor
// here and be tokenized as a redirection operator.
const REDIRECTION_OPS: Record<string, { append: boolean; fromStream: string }> =
  Object.assign(
    Object.create(null) as Record<string, { append: boolean; fromStream: string }>,
    {
      '>': { append: false, fromStream: 'Output' },
      '>>': { append: true, fromStream: 'Output' },
      '2>': { append: false, fromStream: 'Error' },
      '2>>': { append: true, fromStream: 'Error' },
      '*>': { append: false, fromStream: 'All' },
    },
  )

/**
 * Split on a separator that is outside quotes and outside bracket nesting —
 * the two places PowerShell does not treat `;` or `|` as a separator.
 */
function splitTopLevel(source: string, separator: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  let depth = 0
  for (const ch of source) {
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === separator && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map(s => s.trim()).filter(s => s.length > 0)
}

/** Whitespace tokenization with the same quote/nesting awareness. */
function splitTokens(source: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  let depth = 0
  for (const ch of source) {
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

/**
 * The .NET AST type name PowerShell's parser reports for a token.
 *
 * Narrow on purpose — it covers the token shapes these fixtures use and
 * nothing else. `mapElementType` in the parser is what turns these into the
 * `CommandElementType` union the code under test reads.
 */
function rawTypeOf(token: string): string {
  if (token.length > 1 && DASHES.has(token[0]!)) return 'CommandParameterAst'
  if (token.startsWith("'")) return 'StringConstantExpressionAst'
  if (token.startsWith('"')) {
    return token.includes('$')
      ? 'ExpandableStringExpressionAst'
      : 'StringConstantExpressionAst'
  }
  if (token.startsWith('$(')) return 'SubExpressionAst'
  if (token.startsWith('@(')) return 'ArrayExpressionAst'
  if (token.startsWith('$')) return 'VariableExpressionAst'
  if (token.startsWith('(')) return 'ParenExpressionAst'
  return 'StringConstantExpressionAst'
}

/** True when a token starts an EXPRESSION pipeline element, not a command. */
function startsExpression(token: string): boolean {
  if (token.startsWith("'") || token.startsWith('"')) return true
  return rawTypeOf(token) !== 'StringConstantExpressionAst'
}

function unquote(token: string): string {
  const first = token[0]
  if (
    (first === "'" || first === '"') &&
    token.length > 1 &&
    token.endsWith(first)
  ) {
    return token.slice(1, -1)
  }
  return token
}

function toRawElement(token: string): RawCommandElement {
  const type = rawTypeOf(token)
  const element: RawCommandElement = { type, text: token }
  if (
    type === 'StringConstantExpressionAst' ||
    type === 'ExpandableStringExpressionAst'
  ) {
    // .Value resolves quotes; .Extent.Text keeps them. transformCommandAst
    // prefers .value for string literals, which is what makes `'-Include'`
    // arrive as a StringConstant rather than a parameter.
    element.value = unquote(token)
  }
  if (type === 'CommandParameterAst') {
    const colon = token.indexOf(':', 1)
    const bound = colon > 0 ? token.slice(colon + 1) : ''
    if (bound) {
      element.children = [{ type: rawTypeOf(bound), text: bound }]
    }
  }
  return element
}

function buildPipelineElement(text: string): RawPipelineElement {
  const tokens = splitTokens(text)
  const kept: string[] = []
  const redirections: RawRedirection[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '2>&1') {
      redirections.push({ type: 'MergingRedirectionAst' })
      continue
    }
    const op = REDIRECTION_OPS[token]
    if (op) {
      const target = tokens[i + 1]
      if (target !== undefined) {
        redirections.push({
          type: 'FileRedirectionAst',
          append: op.append,
          fromStream: op.fromStream,
          locationText: target,
        })
        i++
      }
      continue
    }
    kept.push(token)
  }

  const first = kept[0]
  if (first !== undefined && startsExpression(first)) {
    return {
      type: 'CommandExpressionAst',
      text,
      expressionType: rawTypeOf(first),
      ...(redirections.length > 0 ? { redirections } : {}),
    }
  }
  return {
    type: 'CommandAst',
    text,
    commandElements: kept.map(toRawElement),
    ...(redirections.length > 0 ? { redirections } : {}),
  }
}

function wrap(statements: RawStatement[], source: string) {
  return {
    valid: true,
    errors: [],
    statements: statements.map(transformStatement),
    variables: [],
    hasStopParsing: false,
    originalCommand: source,
  } satisfies ParsedPowerShellCommand
}

/** Parse a pipeline / compound PowerShell command into the real parsed shape. */
function psParse(source: string): ParsedPowerShellCommand {
  const statements: RawStatement[] = splitTopLevel(source, ';').map(text => ({
    type: 'PipelineAst',
    text,
    elements: splitTopLevel(text, '|').map(buildPipelineElement),
  }))
  return wrap(statements, source)
}

/**
 * A control-flow statement, the way the PS1 script reports one: no `elements`,
 * and the commands found inside the body hoisted into `nestedCommands` by
 * FindAll. This is the shape that reaches the second half of
 * `checkPathConstraintsForStatement`.
 */
function psParseControlFlow(
  text: string,
  bodySource: string,
): ParsedPowerShellCommand {
  return wrap(
    [
      {
        type: 'IfStatementAst',
        text,
        nestedCommands: splitTopLevel(bodySource, ';').map(
          buildPipelineElement,
        ),
      },
    ],
    text,
  )
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// `MACRO` is replaced at build time by Bun.define and is absent under the test
// runner. A read of a path OUTSIDE the working directories reaches
// checkReadableInternalPath → getBundledSkillsRoot, which dereferences
// MACRO.VERSION. Same values as src/skills/bundled/portedSkills.test.ts, so a
// run containing both files agrees on the memoized skills root.
const globals = globalThis as Record<string, unknown>
const MACRO_WAS_DEFINED = globals.MACRO !== undefined
if (!MACRO_WAS_DEFINED) {
  globals.MACRO = {
    VERSION: '99.0.0',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: '1970-01-01T00:00:00.000Z',
    ISSUES_EXPLAINER: 'report the issue',
    PACKAGE_URL: '@claudiolabs/claudin',
    NATIVE_PACKAGE_URL: undefined,
  }
}

let DIR = ''

beforeAll(() => {
  DIR = realpathSync(mkdtempSync(join(tmpdir(), 'psh-pathval-')))
  mkdirSync(join(DIR, 'sub'), { recursive: true })
  writeFileSync(join(DIR, 'notes.txt'), 'notes\n')
  // An ordinary-looking relative path whose realpath is the filesystem root.
  symlinkSync('/', join(DIR, 'rootlink'))
})

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
  if (!MACRO_WAS_DEFINED) delete globals.MACRO
})

type CtxOptions = {
  mode?: ToolPermissionContext['mode']
  deny?: string[]
  allow?: string[]
}

/**
 * A context whose only additional working directory is the temp dir. Note
 * `allWorkingDirectories` ALWAYS folds in `getOriginalCwd()` (the repo root
 * under `bun test`), so every "outside" path below is outside both.
 */
function ctx(options: CtxOptions = {}): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    mode: options.mode ?? 'default',
    additionalWorkingDirectories: new Map([
      [DIR, { path: DIR, source: 'session' as const }],
    ]),
    ...(options.deny ? { alwaysDenyRules: { cliArg: options.deny } } : {}),
    ...(options.allow ? { alwaysAllowRules: { cliArg: options.allow } } : {}),
  }
}

/** Run the checker with the temp dir as cwd — an ALS override, so nothing leaks. */
function check(
  source: string,
  options: CtxOptions = {},
  compoundCommandHasCd = false,
): PermissionResult {
  return runWithCwdOverride(DIR, () =>
    checkPathConstraints(
      { command: source },
      psParse(source),
      ctx(options),
      compoundCommandHasCd,
    ),
  )
}

function checkParsed(
  parsed: ParsedPowerShellCommand,
  options: CtxOptions = {},
): PermissionResult {
  return runWithCwdOverride(DIR, () =>
    checkPathConstraints(
      { command: parsed.originalCommand },
      parsed,
      ctx(options),
    ),
  )
}

/** The message every branch but `allow` carries. */
function messageOf(result: PermissionResult): string {
  return 'message' in result ? result.message : ''
}

/** Narrows to `ask` and hands back the decision, so `blockedPath` is typed. */
function asAsk(result: PermissionResult) {
  if (result.behavior !== 'ask') {
    throw new Error(
      `expected an ask decision, got '${result.behavior}': ${messageOf(result)}`,
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// The cmdlet table
// ---------------------------------------------------------------------------

describe('CMDLET_PATH_CONFIG', () => {
  test('a path-bearing parameter is recognised by name', () => {
    // -LiteralPath is in get-content's pathParams, so its value is extracted
    // and validated. The message naming the resolved path is what proves the
    // extraction happened — the unknown-parameter fallback produces a
    // different message and never reaches validatePath.
    const result = asAsk(check('Get-Content -LiteralPath /etc/passwd'))
    expect(result.message).toContain('/etc/passwd')
    expect(result.message).toContain('allowed working directories')
    expect(result.blockedPath).toBe('/etc/passwd')
  })

  test('a cmdlet absent from the table contributes no paths', () => {
    // This checker only inspects cmdlets it has a config for; an unknown name
    // is somebody else's gate (powershellPermissions' allowlist). Pinning it
    // here is what catches a fallback entry being introduced — a wrong default
    // config would validate the wrong parameters as paths.
    expect(check('Write-Rainbow /etc/passwd').behavior).toBe('passthrough')
    expect(check('Get-Content /etc/passwd').behavior).toBe('ask')
  })

  test('a cmdlet named after an Object.prototype member is not a config', () => {
    // CMDLET_PATH_CONFIG has a null prototype. With a plain object literal,
    // `CMDLET_PATH_CONFIG['constructor']` would resolve to
    // Object.prototype.constructor — truthy, with no pathParams — and the
    // spread of `config.knownSwitches` would throw on a model-chosen name.
    expect(check('constructor /etc/passwd').behavior).toBe('passthrough')
    expect(check('__proto__ /etc/passwd').behavior).toBe('passthrough')
  })

  test('a value parameter that is not a path is not validated as one', () => {
    // -Value carries file CONTENT. Treating it as a path would ask about
    // /etc/passwd here; treating it as unknown would ask about the parameter.
    // Neither happens: the write lands inside the working directory.
    const result = check(
      'Set-Content -Path ./notes.txt -Value /etc/passwd',
      { mode: 'acceptEdits' },
    )
    expect(result.behavior).toBe('passthrough')
  })

  test('a known switch does not swallow the positional path behind it', () => {
    // -Recurse takes no value, so /etc/passwd stays a positional argument and
    // is still validated. A switch misfiled as a value parameter would consume
    // it and the path would never be checked.
    const result = asAsk(check('Remove-Item -Recurse /etc/hosts'))
    expect(result.behavior).toBe('ask')
  })

  test('positionalSkip keeps a URL out of the path set', () => {
    // Invoke-WebRequest's positional 0 is a URI. Without the skip it reaches
    // validatePath and trips the non-filesystem-provider regex on `https:`.
    expect(check('Invoke-WebRequest https://example.com').behavior).toBe(
      'passthrough',
    )
  })

  test('optionalWrite exempts a write cmdlet that was given no path', () => {
    // Same cmdlet WITH a path is a write and is validated.
    const result = asAsk(
      check('Invoke-WebRequest https://example.com -OutFile /etc/evil'),
    )
    expect(result.blockedPath).toBe('/etc/evil')
  })

  test('a write cmdlet with no determinable target asks', () => {
    expect(asAsk(check('Remove-Item -Recurse')).message).toContain(
      'no target path could be determined',
    )
  })
})

// ---------------------------------------------------------------------------
// Parameter matching
// ---------------------------------------------------------------------------

describe('matchesParam', () => {
  test('an unambiguous abbreviation of a path parameter is honoured', () => {
    // PowerShell resolves -Lit to -LiteralPath; so does matchesParam, via
    // `knownParam.startsWith(typedParam)`.
    const result = asAsk(check('Get-Content -Lit /etc/passwd'))
    expect(result.blockedPath).toBe('/etc/passwd')
  })

  test('a SUPERSTRING of a path parameter is not a path parameter', () => {
    // -PathExtra is not -Path. Matching it would bind an arbitrary parameter's
    // value as a path; the direction of the prefix test is what prevents it.
    // The value still lands in paths[] as a positional, so the distinguishing
    // signal is WHICH ask comes back.
    const result = asAsk(check('Get-Content -PathExtra /etc/passwd'))
    expect(result.message).toContain('cannot be statically validated')
    expect(result.blockedPath).toBeUndefined()
  })

  test('an abbreviation of a value parameter does not swallow a path', () => {
    // -Enc abbreviates -Encoding, which takes a value; the NEXT token is that
    // value and is not a path. If the match ran the other way round, a
    // parameter merely PREFIXED by a known one would consume the positional
    // path behind it and nothing would be validated.
    const result = asAsk(
      check('Get-Content -Encoding UTF8 /etc/passwd'),
    )
    expect(result.blockedPath).toBe('/etc/passwd')
  })

  // NOT PINNED, deliberately: matchesParam's `paramLower.length > 1` guard
  // makes a one-character parameter require an exact match. Reaching it needs
  // a CommandParameterAst whose whole text is a bare `-`, and dropping the
  // guard changed no outcome in this suite (break-probe, 2026-09-19). Rather
  // than hand-build a node the real tokenizer may never emit, the claim is
  // left unmade.

  test('an unknown parameter forces an ask rather than a guess', () => {
    // The structural fix for the switch/value whack-a-mole: an invocation we
    // do not fully understand is never auto-allowed.
    const result = asAsk(
      check('Set-Content -Path ./notes.txt -Bogus x', { mode: 'acceptEdits' }),
    )
    expect(result.message).toContain('cannot be statically validated')
  })

  test('an unknown parameter still surrenders its colon-bound path', () => {
    // Defense in depth: the value is trapped inside one token, so without this
    // the deny rule below would never be consulted and deny would degrade to
    // ask.
    const result = check('Get-Content -Bogus:/etc/passwd', {
      deny: ['Read(//etc/**)'],
    })
    expect(result.behavior).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// The allowlist and validatePath
// ---------------------------------------------------------------------------

describe('validatePath — the working-directory allowlist', () => {
  test('a read inside the working directory passes through', () => {
    expect(check('Get-Content ./notes.txt').behavior).toBe('passthrough')
  })

  test('a read outside every working directory asks', () => {
    const result = asAsk(check('Get-Content /etc/passwd'))
    expect(result.blockedPath).toBe('/etc/passwd')
    expect(result.message).toContain(DIR)
  })

  test('a write inside the working directory needs acceptEdits', () => {
    expect(
      check('Set-Content -Path ./notes.txt -Value hi', { mode: 'acceptEdits' })
        .behavior,
    ).toBe('passthrough')
    expect(
      check('Set-Content -Path ./notes.txt -Value hi', { mode: 'default' })
        .behavior,
    ).toBe('ask')
  })

  test('~ is expanded before the path is checked', () => {
    // Without expansion, `~/.ssh/id_rsa` resolves to <cwd>/~/.ssh/id_rsa —
    // INSIDE the working directory — and a read of the user's private key
    // passes through.
    const result = asAsk(check('Get-Content ~/.ssh/id_rsa'))
    expect(result.blockedPath).toBe(join(homedir(), '.ssh/id_rsa'))
  })

  test('a `..` traversal that escapes the working directory is refused', () => {
    // The single most important assertion in the file: the path is resolved
    // before it is compared, so a relative path cannot walk out of the
    // allowlist.
    const result = asAsk(check('Get-Content ../../../../etc/passwd'))
    expect(result.blockedPath).toBe('/etc/passwd')
  })

  test('a traversal is resolved before deny rules are matched', () => {
    // Resolution is what lets an explicit deny rule fire on the real target.
    // Matching the unresolved text would find no rule and downgrade deny→ask.
    expect(
      check('Get-Content ../../../../etc/passwd', {
        deny: ['Read(//etc/**)'],
      }).behavior,
    ).toBe('deny')
  })

  test('a BACKSLASH traversal is normalized before it is resolved', () => {
    // PowerShell Core normalizes `\` to `/` on every platform; path.resolve on
    // POSIX does not, so without the normalization `..\..\etc\evil.txt` stays
    // one literal segment under the working directory and the deny rule on
    // /etc never matches.
    expect(
      check('Set-Content -Path ..\\..\\..\\..\\etc\\evil.txt -Value x', {
        mode: 'acceptEdits',
        deny: ['Edit(//etc/**)'],
      }).behavior,
    ).toBe('deny')
  })

  test('a deny rule produces deny, not ask', () => {
    const result = check('Get-Content /etc/passwd', {
      deny: ['Read(//etc/**)'],
    })
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason?.type).toBe('rule')
  })

  test('a deny rule beats an allow rule on the same path', () => {
    expect(
      check('Get-Content /etc/passwd', {
        deny: ['Read(//etc/**)'],
        allow: ['Read(//etc/**)'],
      }).behavior,
    ).toBe('deny')
  })

  test('an allow rule opens a path outside the working directories', () => {
    expect(
      check('Get-Content /etc/passwd', { allow: ['Read(//etc/**)'] }).behavior,
    ).toBe('passthrough')
  })
})

describe('validatePath — the unvalidatable shapes', () => {
  test('a backtick escape cannot be statically validated', () => {
    // Backtick is PowerShell's escape character and defeats isAbsolute(), so
    // the path would otherwise resolve INSIDE the working directory.
    const result = asAsk(check('Get-Content `/etc/passwd'))
    expect(result.message).toContain('Backtick escape characters')
  })

  test('a backtick path still matches a deny rule on its stripped guess', () => {
    expect(
      check('Get-Content `/etc/passwd', { deny: ['Read(//etc/**)'] }).behavior,
    ).toBe('deny')
  })

  test('a module-qualified provider path is refused', () => {
    // FileSystem::/etc/passwd reaches /etc/passwd through the provider and
    // does not match the simple `^[a-z]{2,}:` provider regex.
    const result = asAsk(check('Get-Content FileSystem::/etc/passwd'))
    expect(result.message).toContain('Module-qualified provider paths')
  })

  test('a :: path still matches a deny rule on the part after the provider', () => {
    expect(
      check('Get-Content FileSystem::/etc/passwd', {
        deny: ['Read(//etc/**)'],
      }).behavior,
    ).toBe('deny')
  })

  test('a UNC path is refused before any filesystem access', () => {
    const result = asAsk(check('Get-Content //server/share/secret'))
    expect(result.message).toContain('UNC paths are blocked')
  })

  test('a non-filesystem provider path is refused', () => {
    // On POSIX ANY `<letters>:` prefix is a PSDrive — `New-PSDrive -Name Z
    // -Root /etc` then `Get-Content Z:/secrets` would otherwise resolve to
    // <cwd>/Z:/secrets, inside the working directory.
    expect(asAsk(check('Get-Content env:HOME')).message).toContain(
      'non-filesystem provider',
    )
    expect(asAsk(check('Get-Content Z:/secrets')).message).toContain(
      'non-filesystem provider',
    )
  })

  test('variable expansion syntax in a path is refused', () => {
    const result = asAsk(check("Get-Content '/etc/$target'"))
    expect(result.message).toContain('Variable expansion syntax')
  })

  test('a glob is never allowed for a write', () => {
    const result = asAsk(
      check('Set-Content -Path ./*.txt -Value x', { mode: 'acceptEdits' }),
    )
    expect(result.message).toContain('Glob patterns are not allowed in write')
  })
})

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

describe('glob handling', () => {
  test('a read glob inside the working directory still asks', () => {
    // Symlinks inside the expansion are never examined, so a glob is not
    // statically validatable even when its base directory is allowed.
    const result = asAsk(check('Get-Content ./sub/*.txt'))
    expect(result.message).toContain(
      'Glob patterns in paths cannot be statically validated',
    )
  })

  test('a glob is matched against its BASE directory, not its literal text', () => {
    // getGlobBaseDirectory truncates to the directory before the first glob
    // char; that base is what the deny rule is matched against, which is the
    // only reason `Get-Content /etc/*.conf` denies rather than asks.
    expect(
      check('Get-Content /etc/*.conf', { deny: ['Read(//etc/**)'] }).behavior,
    ).toBe('deny')
  })

  test('a glob with a traversal is resolved in full, not truncated to its base', () => {
    // `./sub/*/../../../../etc/passwd` has an allowed base (./sub/) but
    // escapes via `..` AFTER the glob. Truncating to the base would report the
    // generic glob ask; resolving the whole thing reports the real target.
    const result = asAsk(check('Get-Content ./sub/*/../../../../etc/passwd'))
    expect(result.blockedPath).toBe('/etc/passwd')
  })

  test('braces are literal in PowerShell and do not make a glob', () => {
    // `{}` is brace EXPANSION in bash and a literal character in PowerShell.
    // Treating it as a glob would truncate to the base directory and skip
    // full-path symlink resolution.
    const result = asAsk(check('Get-Content /etc/{x}/passwd'))
    expect(result.blockedPath).toBe('/etc/{x}/passwd')
  })
})

// ---------------------------------------------------------------------------
// Path extraction — which AST element types may contribute a path
// ---------------------------------------------------------------------------

describe('SAFE_PATH_ELEMENT_TYPES', () => {
  test('a sub-expression argument is not harvested as a literal path', () => {
    // `@(...)` maps to SubExpression. Widening the safe set to include it
    // turns this ask into a passthrough: the text `@(1)` resolves inside the
    // working directory while PowerShell evaluates a pipeline.
    const result = asAsk(check('Get-Content @(1)'))
    expect(result.message).toContain('cannot be statically validated')
  })

  test('a parenthesised expression argument is not harvested as a path', () => {
    const result = asAsk(check('Get-Content (Get-Secret)'))
    expect(result.message).toContain('cannot be statically validated')
  })

  test('a variable argument is not harvested as a literal path', () => {
    const result = asAsk(check('Get-Content $target'))
    expect(result.message).toContain('cannot be statically validated')
  })

  test('an expandable string argument is not harvested as a literal path', () => {
    const result = asAsk(check('Get-Content "$env:HOME/x"'))
    expect(result.message).toContain('cannot be statically validated')
  })

  test('a plain string constant IS harvested', () => {
    // The negative cases above are only meaningful if the safe types work.
    expect(asAsk(check("Get-Content '/etc/passwd'")).blockedPath).toBe(
      '/etc/passwd',
    )
  })

  test('a quoted parameter-looking argument is a path, not a parameter', () => {
    // elementTypes is ground truth, not the leading dash: `'-Recurse'` is a
    // StringConstant, so it is Remove-Item's positional path — resolving
    // inside the working directory — rather than the -Recurse switch, which
    // would leave the write with no target at all.
    expect(
      check("Remove-Item '-Recurse'", { mode: 'acceptEdits' }).behavior,
    ).toBe('passthrough')
    expect(asAsk(check('Remove-Item -Recurse')).message).toContain(
      'no target path could be determined',
    )
  })
})

describe('hasComplexColonValue', () => {
  test('a comma-separated colon value cannot be statically validated', () => {
    // `-Path:safe.txt,/etc/passwd` is an ArrayLiteralExpressionAst hidden
    // inside one CommandParameterAst token: PowerShell writes to BOTH paths
    // while a naive read sees a single string that resolves inside the
    // working directory.
    const result = asAsk(
      check('Set-Content -Path:./notes.txt,/etc/passwd -Value x', {
        mode: 'acceptEdits',
      }),
    )
    expect(result.message).toContain('cannot be statically validated')
  })

  test('a variable inside a colon value cannot be statically validated', () => {
    const result = asAsk(
      check('Set-Content -Path:$target -Value x', { mode: 'acceptEdits' }),
    )
    expect(result.message).toContain('cannot be statically validated')
  })

  test('a plain colon value IS extracted and validated', () => {
    expect(asAsk(check('Get-Content -Path:/etc/passwd')).blockedPath).toBe(
      '/etc/passwd',
    )
  })
})

describe('leafOnlyPathParams', () => {
  test('a -Name that is a bare leaf is extracted', () => {
    expect(
      check('New-Item -Path ./sub -Name note.txt -ItemType File', {
        mode: 'acceptEdits',
      }).behavior,
    ).toBe('passthrough')
  })

  test('a -Name carrying separators is refused, not resolved against cwd', () => {
    // PowerShell resolves -Name relative to -Path; this validator resolves
    // against cwd. A non-leaf value therefore lands somewhere else entirely
    // and could miss the deny rule that covers the real target.
    const result = asAsk(
      check('New-Item -Path ./sub -Name ../../etc/evil -ItemType File', {
        mode: 'acceptEdits',
      }),
    )
    expect(result.message).toContain('cannot be statically validated')
  })
})

// ---------------------------------------------------------------------------
// Dangerous removal
// ---------------------------------------------------------------------------

describe('isDangerousRemovalRawPath', () => {
  test('flags the filesystem root', () => {
    expect(isDangerousRemovalRawPath('/')).toBe(true)
  })

  test('flags a quoted root, because quotes survive into the raw path', () => {
    expect(isDangerousRemovalRawPath("'/'")).toBe(true)
    expect(isDangerousRemovalRawPath('"/"')).toBe(true)
  })

  test('flags the home directory, reached through ~', () => {
    // The tilde has to be expanded HERE: safeResolvePath rewrites homedir on
    // macOS (/var → /private/var) in a way that defeats the === comparison.
    expect(isDangerousRemovalRawPath('~')).toBe(true)
    expect(isDangerousRemovalRawPath(homedir())).toBe(true)
  })

  test('flags a Windows drive root written with backslashes', () => {
    expect(isDangerousRemovalRawPath('C:\\')).toBe(true)
  })

  test('flags a direct child of root', () => {
    expect(isDangerousRemovalRawPath('/etc')).toBe(true)
    expect(isDangerousRemovalRawPath('/usr')).toBe(true)
  })

  test('flags a bare wildcard and a wildcard at a dangerous level', () => {
    expect(isDangerousRemovalRawPath('*')).toBe(true)
    expect(isDangerousRemovalRawPath('/usr/*')).toBe(true)
  })

  test('lets an ordinary path through', () => {
    expect(isDangerousRemovalRawPath('/usr/local/lib/thing')).toBe(false)
    expect(isDangerousRemovalRawPath('./build')).toBe(false)
    expect(isDangerousRemovalRawPath(join(homedir(), 'projects'))).toBe(false)
  })
})

describe('dangerousRemovalDeny', () => {
  test('denies, naming the path and carrying a reason', () => {
    const result = dangerousRemovalDeny('/etc')
    expect(result.behavior).toBe('deny')
    expect(messageOf(result)).toContain('/etc')
    expect(result.decisionReason).toEqual({
      type: 'other',
      reason: 'Removal targets a protected system path',
    })
  })
})

describe('removal cmdlets are hard-denied on dangerous paths', () => {
  test('Remove-Item on root denies rather than asks', () => {
    // A user cannot approve this: deny, not ask.
    expect(check('Remove-Item -Path / -Recurse -Force').behavior).toBe('deny')
  })

  test('the alias rm resolves to remove-item for the same deny', () => {
    expect(check('rm -Recurse -Force ~').behavior).toBe('deny')
  })

  test('a non-removal cmdlet on the same path asks instead', () => {
    // The hard deny is scoped to removal — proving the removal check is what
    // produced the deny above, not the generic allowlist.
    expect(check('Get-Content /etc').behavior).toBe('ask')
  })

  test('an ordinary removal inside the working directory is not denied', () => {
    expect(
      check('Remove-Item -Path ./notes.txt', { mode: 'acceptEdits' }).behavior,
    ).toBe('passthrough')
  })

  test('a symlink that RESOLVES to a protected path is denied too', () => {
    // The raw check cannot see this one: `./rootlink` is an ordinary relative
    // path until realpath turns it into `/`. That is why the removal check
    // runs twice, once on the raw text and once on the resolved path.
    expect(
      check('Remove-Item -Path ./rootlink -Recurse -Force', {
        mode: 'acceptEdits',
      }).behavior,
    ).toBe('deny')
  })

  test('a removal nested inside control flow is denied too', () => {
    // `if ($true) { Remove-Item / }` reaches the checker through
    // nestedCommands, a second copy of the loop. Without its own removal
    // check the deny degrades to an ask the user can approve.
    const parsed = psParseControlFlow(
      'if ($true) { Remove-Item / }',
      'Remove-Item /',
    )
    expect(checkParsed(parsed).behavior).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Statement-level constraints
// ---------------------------------------------------------------------------

describe('checkPathConstraints — across statements', () => {
  test('an unparsed command is passed through, not guessed at', () => {
    const parsed = { ...psParse('Get-Content /etc/passwd'), valid: false }
    expect(checkParsed(parsed).behavior).toBe('passthrough')
    expect(messageOf(checkParsed(parsed))).toContain('Cannot validate paths')
  })

  test('every statement is checked, not just the first', () => {
    // One allowed segment does not authorise the next.
    expect(
      check('Get-Content ./notes.txt; Get-Content /etc/passwd').behavior,
    ).toBe('ask')
  })

  test('a deny in a later statement beats an ask in an earlier one', () => {
    // Two-pass: returning the first ask would let the user approve a command
    // that also contains a denied path.
    const result = check(
      'Get-Content /tmp; Get-Content /etc/passwd',
      { deny: ['Read(//etc/**)'] },
    )
    expect(result.behavior).toBe('deny')
    expect(messageOf(result)).toContain('/etc/passwd')
  })

  test('all paths in one statement are checked, not just the first', () => {
    expect(
      check('Copy-Item -Path ./notes.txt -Destination /etc/evil', {
        mode: 'acceptEdits',
      }).behavior,
    ).toBe('ask')
  })

  test('a compound command containing a cd cannot validate relative paths', () => {
    // `Set-Location ./.claudin; Set-Content ./settings.json ...` resolves
    // against the CHANGED cwd at runtime but the STALE one here. Reads are
    // blocked as well as writes — a mis-resolved read leaks just as a
    // mis-resolved write destroys.
    const result = asAsk(check('Get-Content ./notes.txt', {}, true))
    expect(result.message).toContain(
      'Compound command changes working directory',
    )
  })

  test('a deny rule still fires under the compound-cd ask', () => {
    expect(
      check('Get-Content /etc/passwd', { deny: ['Read(//etc/**)'] }, true)
        .behavior,
    ).toBe('deny')
  })
})

describe('pipeline expression sources', () => {
  test('a cmdlet fed by a string literal through the pipe asks', () => {
    // `'/etc/passwd' | Get-Content` extracts zero paths — the path arrives
    // through the pipeline and binds to -Path at runtime.
    const result = asAsk(check("'/etc/passwd' | Get-Content"))
    expect(result.message).toContain('pipeline expression source')
  })

  test('the piped literal is still matched against deny rules', () => {
    expect(
      check("'/etc/passwd' | Remove-Item", { deny: ['Edit(//etc/**)'] })
        .behavior,
    ).toBe('deny')
  })

  test('a plain cmdlet-to-cmdlet pipe is not an expression source', () => {
    expect(check('Get-ChildItem ./sub | Get-Content').behavior).toBe(
      'passthrough',
    )
  })
})

describe('redirections', () => {
  test('a redirect outside the working directories asks', () => {
    const result = asAsk(check('Get-ChildItem ./sub > /etc/evil.txt'))
    expect(result.message).toContain('Output redirection')
    expect(result.blockedPath).toBe('/etc/evil.txt')
  })

  test('an append redirect is checked the same way', () => {
    expect(asAsk(check('Get-ChildItem ./sub >> /etc/evil.txt')).blockedPath).toBe(
      '/etc/evil.txt',
    )
  })

  test('a redirect to $null is not a filesystem write', () => {
    expect(check('Get-ChildItem ./sub > $null').behavior).toBe('passthrough')
  })

  test('a merging redirect is not treated as a file write', () => {
    // `2>&1` merges streams; it names no file. Validating it would resolve the
    // empty target to the cwd and ask about a write that never happens.
    //
    // Two guards achieve this — `isMerging` and the empty-target check — and
    // `transformRedirection` always gives a merging redirection `target: ''`,
    // so removing EITHER one alone changes nothing and no single probe can
    // turn this red. It is pinned as the outcome, and the probe spec removes
    // both guards together.
    expect(check('Get-ChildItem ./sub 2>&1').behavior).toBe('passthrough')
  })

  test('a redirect target is validated as a create, so a glob is refused', () => {
    const result = asAsk(check('Get-ChildItem ./sub > ./*.txt'))
    expect(result.message).toContain('Glob patterns are not allowed in write')
  })

  test('a redirect inside a control-flow statement is still checked', () => {
    // A control-flow statement carries its commands in `nestedCommands`, and
    // their redirections travel with them. The assertion is `deny` rather than
    // `ask` on purpose: the synthetic expression element that every non-
    // pipeline statement gets already produces an ask, so an ask here would
    // pass with the nested-redirection loop deleted. Only the deny rule — a
    // `return`, not a `??=` — proves the redirect was actually validated.
    const parsed = psParseControlFlow(
      'if ($true) { Get-ChildItem ./sub > /etc/evil.txt }',
      'Get-ChildItem ./sub > /etc/evil.txt',
    )
    expect(checkParsed(parsed, { deny: ['Edit(//etc/**)'] }).behavior).toBe(
      'deny',
    )
  })
})
