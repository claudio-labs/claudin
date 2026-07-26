import { describe, expect, test, beforeEach } from 'bun:test'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import {
  analyzeCommandForRedirect,
  renderToolRedirect,
  resetToolRedirectMemoForTesting,
  shouldRedirectToTools,
  type SuggestedCall,
} from './toolRedirect.js'

// Real files, because the analyzer refuses any path that is not a regular file
// on disk — a fixture-free existence gate is the point, not an inconvenience.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FILE_A = 'src/utils/bash/segments.ts'
const FILE_B = 'src/utils/bash/commands.ts'

function analyze(command: string) {
  return analyzeCommandForRedirect(command, REPO_ROOT)
}

function calls(command: string): SuggestedCall[] {
  const analysis = analyze(command)
  if (!analysis) throw new Error(`expected a redirect for: ${command}`)
  return analysis.units.flatMap(unit => unit.calls)
}

describe('file reads → Read', () => {
  test('cat maps to a whole-file Read with an absolute path', () => {
    expect(calls(`cat ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}` },
    ])
  })

  test('cat -n is the same Read — Read numbers lines anyway', () => {
    expect(calls(`cat -n ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}` },
    ])
  })

  test('nl maps to a whole-file Read', () => {
    expect(calls(`nl ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}` },
    ])
  })

  test('several files become several Reads', () => {
    expect(calls(`cat ${FILE_A} ${FILE_B}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}` },
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_B}` },
    ])
  })

  test('head -n N becomes a limit', () => {
    expect(calls(`head -n 50 ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, limit: 50 },
    ])
  })

  test('bare head is the 10-line default', () => {
    expect(calls(`head ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, limit: 10 },
    ])
  })

  test('head -20 and head -n20 are the same as head -n 20', () => {
    const expected: SuggestedCall[] = [
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, limit: 20 },
    ]
    expect(calls(`head -20 ${FILE_A}`)).toEqual(expected)
    expect(calls(`head -n20 ${FILE_A}`)).toEqual(expected)
  })

  test("sed -n 'A,Bp' becomes offset + limit", () => {
    expect(calls(`sed -n '330,400p' ${FILE_A}`)).toEqual([
      {
        tool: 'Read',
        file_path: `${REPO_ROOT}/${FILE_A}`,
        offset: 330,
        limit: 71,
      },
    ])
  })

  test("sed -n 'Np' is a single line", () => {
    expect(calls(`sed -n '42p' ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, offset: 42, limit: 1 },
    ])
  })

  test("sed -n 'A,$p' is open-ended", () => {
    expect(calls(`sed -n '330,$p' ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, offset: 330 },
    ])
  })

  test('grep -n "" is a whole-file read wearing a search\'s clothes', () => {
    expect(calls(`grep -n "" ${FILE_A}`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}` },
    ])
  })
})

describe('pipeline fusion', () => {
  test('the case this feature exists for: grep -n "" F | sed -n A,Bp', () => {
    expect(calls(`grep -n "" ${FILE_A} | sed -n '330,400p'`)).toEqual([
      {
        tool: 'Read',
        file_path: `${REPO_ROOT}/${FILE_A}`,
        offset: 330,
        limit: 71,
      },
    ])
  })

  test('cat F | head -n N', () => {
    expect(calls(`cat ${FILE_A} | head -n 50`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}`, limit: 50 },
    ])
  })

  test('selectors compose left to right, in the input coordinates', () => {
    // head takes lines 1-100; sed then takes lines 10-20 OF THAT, which are
    // lines 10-20 of the file.
    expect(calls(`cat ${FILE_A} | head -n 100 | sed -n '10,20p'`)).toEqual([
      {
        tool: 'Read',
        file_path: `${REPO_ROOT}/${FILE_A}`,
        offset: 10,
        limit: 11,
      },
    ])
  })

  test('a selector that reaches past the upstream window is truncated, not extended', () => {
    // head gives 20 lines; asking for 10..40 of those can only yield 11.
    expect(calls(`cat ${FILE_A} | head -n 20 | sed -n '10,40p'`)).toEqual([
      {
        tool: 'Read',
        file_path: `${REPO_ROOT}/${FILE_A}`,
        offset: 10,
        limit: 11,
      },
    ])
  })

  test('cat -n in a pipe is a no-op selector', () => {
    expect(calls(`cat ${FILE_A} | cat -n`)).toEqual([
      { tool: 'Read', file_path: `${REPO_ROOT}/${FILE_A}` },
    ])
  })

  test('a limit past Read’s ceiling is clamped and says so', () => {
    const [call] = calls(`sed -n '1,5000p' ${FILE_A}`)
    expect(call).toEqual({
      tool: 'Read',
      file_path: `${REPO_ROOT}/${FILE_A}`,
      limit: 2000,
      clamped: true,
    })
  })
})

describe('searches → Grep', () => {
  test('recursive grep with a path and includes', () => {
    expect(calls('grep -rn "foo" src --include=*.ts')).toEqual([
      {
        tool: 'Grep',
        pattern: 'foo',
        path: 'src',
        glob: '*.ts',
        output_mode: 'content',
        caseInsensitive: undefined,
        context: undefined,
      },
    ])
  })

  test('two --include flags collapse into one brace glob', () => {
    const [call] = calls('grep -rn "foo" src --include=*.ts --include=*.tsx')
    expect(call).toMatchObject({ tool: 'Grep', glob: '*.{ts,tsx}' })
  })

  test('-c maps to count mode, -l to files_with_matches', () => {
    expect(calls(`grep -c foo ${FILE_A}`)[0]).toMatchObject({
      output_mode: 'count',
    })
    expect(calls('grep -rl foo src')[0]).toMatchObject({
      output_mode: 'files_with_matches',
    })
  })

  test('-i and -C carry over', () => {
    expect(calls('grep -rin foo src -C 3')[0]).toMatchObject({
      caseInsensitive: true,
      context: { flag: '-C', lines: 3 },
    })
  })
})

describe('discovery → Glob', () => {
  test('find DIR -name PAT', () => {
    expect(calls('find src -name "*.ts"')).toEqual([
      { tool: 'Glob', pattern: '**/*.ts', path: 'src' },
    ])
  })

  test('find . -name PAT drops the redundant root', () => {
    expect(calls('find . -name "*.ts"')).toEqual([
      { tool: 'Glob', pattern: '**/*.ts', path: undefined },
    ])
  })

  test('-type f alone still maps', () => {
    expect(calls('find src -type f')).toEqual([
      { tool: 'Glob', pattern: '**/*', path: 'src' },
    ])
  })
})

describe('compound commands', () => {
  test('the exact command from the bug report', () => {
    const command = `grep -n "" ${FILE_A} | sed -n '330,400p' && echo "=== call sites ===" && grep -rn "walkCommandSegments" src --include=*.ts --include=*.tsx`
    const analysis = analyze(command)
    expect(analysis).not.toBeNull()
    // The echo is neutral and contributes no unit.
    expect(analysis!.units).toHaveLength(2)
    expect(analysis!.units[0]!.calls[0]).toMatchObject({
      tool: 'Read',
      offset: 330,
      limit: 71,
    })
    expect(analysis!.units[1]!.calls[0]).toMatchObject({
      tool: 'Grep',
      glob: '*.{ts,tsx}',
    })
    expect(analysis!.targets).toEqual(['Read', 'Grep'])
  })

  test('a chain of reads is all-or-nothing — one unmappable segment passes', () => {
    expect(analyze(`bun run build && cat ${FILE_A}`)).toBeNull()
  })

  test('an echo-only command is not a redirect', () => {
    expect(analyze('echo hello')).toBeNull()
  })
})

describe('stands down', () => {
  const NOT_REDIRECTED: Array<[string, string]> = [
    // The pipeline's tail is not a line selector — this is the case where the
    // shell genuinely wins.
    [`cat package.json | jq '.scripts'`, 'post-processing with jq'],
    [`cat ${FILE_A} | wc -l`, 'counting, not reading'],
    [`grep -rn foo src | sort | uniq -c`, 'aggregation'],
    // Output goes to a file, not into context.
    [`cat ${FILE_A} > /tmp/out`, 'redirected to a file'],
    [`grep -rn foo src >> /tmp/out`, 'appended to a file'],
    // Flags with no tool spelling.
    [`grep -v foo ${FILE_A}`, 'inverted match'],
    [`grep -o foo ${FILE_A}`, 'only-matching'],
    [`grep -P "\\d+" ${FILE_A}`, 'perl regex'],
    [`head -c 100 ${FILE_A}`, 'byte count, not lines'],
    [`cat -A ${FILE_A}`, 'shows non-printing characters'],
    [`sed -n '/a/,/b/p' ${FILE_A}`, 'regex range'],
    [`sed 's/a/b/' ${FILE_A}`, 'substitution'],
    [`sed -i 's/a/b/' ${FILE_A}`, 'in-place edit'],
    [`sed '330,400p' ${FILE_A}`, 'without -n every line prints, the range twice'],
    ['grep -rn "" src', 'an empty pattern over a tree is not a file read'],
    [`grep foo ${FILE_A} ${FILE_B}`, 'Grep searches one path'],
    [`cat ${FILE_A} | echo hi`, 'the read is discarded'],
    [`find . -name "*.ts" -delete`, 'destructive predicate'],
    ['find src -type d', 'directories, which Glob does not return'],
    ['find src -maxdepth 2 -name "*.ts"', 'depth limit'],
    // Out of scope on purpose.
    ['tail -f /tmp/log', 'tail is the Monitor tool’s job'],
    [`tail -n 20 ${FILE_A}`, 'last-N has no Read spelling'],
    ['ls src', 'Read’s own prompt sends directory listing to Bash'],
    [`awk 'NR>=1 && NR<=10' ${FILE_A}`, 'awk is out of scope'],
    // Nothing to read.
    ['cat /nonexistent/does-not-exist.ts', 'path does not exist'],
    ['cat /dev/null', 'not a regular file'],
    ['cat src', 'a directory, not a file'],
    ['grep foo', 'reads stdin'],
    [`head -n 50 ${FILE_A} ${FILE_B}`, 'head banners on multiple files'],
    [`sed -n '1,2p' ${FILE_A} ${FILE_B}`, 'sed concatenates, Read does not'],
    ['git log --oneline | head -20', 'the head is not a file read'],
    ['', 'empty'],
  ]
  for (const [command, why] of NOT_REDIRECTED) {
    test(`${command || '(empty)'} — ${why}`, () => {
      expect(analyze(command)).toBeNull()
    })
  }
})

describe('shouldRedirectToTools — one-shot escape hatch', () => {
  const anyTool: (name: string) => boolean = () => true
  const redirect = (command: string, hasTool: (name: string) => boolean = anyTool) =>
    shouldRedirectToTools(command, REPO_ROOT, hasTool)

  beforeEach(() => resetToolRedirectMemoForTesting())

  test('refuses the first attempt and runs the re-send', () => {
    const command = `cat ${FILE_A}`
    expect(redirect(command)).not.toBeNull()
    expect(redirect(command)).toBeNull()
    // The escape does not expire.
    expect(redirect(command)).toBeNull()
  })

  test('memoizes per command, not globally', () => {
    expect(redirect(`cat ${FILE_A}`)).not.toBeNull()
    expect(redirect(`cat ${FILE_B}`)).not.toBeNull()
  })

  test('surrounding whitespace does not buy a second refusal', () => {
    expect(redirect(`cat ${FILE_A}`)).not.toBeNull()
    expect(redirect(`  cat ${FILE_A}  `)).toBeNull()
  })

  test('a command that never redirects is never recorded', () => {
    expect(redirect('git status')).toBeNull()
    expect(redirect('git status')).toBeNull()
  })

  test('stands down when a target tool is missing from the toolset', () => {
    const noGrep = (name: string) => name !== 'Grep'
    expect(redirect('grep -rn foo src', noGrep)).toBeNull()
    // …and the one-shot was NOT burned: with Grep present it still refuses.
    expect(redirect('grep -rn foo src')).not.toBeNull()
  })

  test('a mixed command needs every target, not just one', () => {
    const noGrep = (name: string) => name !== 'Grep'
    const command = `cat ${FILE_A} && grep -rn foo src`
    expect(redirect(command, noGrep)).toBeNull()
    expect(redirect(command)).not.toBeNull()
  })
})

describe('renderToolRedirect', () => {
  test('spells out each call with its arguments and the escape hatch', () => {
    const command = `grep -n "" ${FILE_A} | sed -n '330,400p' && grep -rn "foo" src --include=*.ts`
    const analysis = analyze(command)!
    const message = renderToolRedirect(command, analysis)
    expect(message).toContain(`Read(file_path: "${REPO_ROOT}/${FILE_A}"`)
    expect(message).toContain('offset: 330, limit: 71')
    expect(message).toContain('Grep(pattern: "foo", path: "src", glob: "*.ts"')
    expect(message).toContain('parallel tool_use blocks')
    expect(message).toContain('re-send this exact Bash command')
  })

  test('a single call does not ask for parallel blocks', () => {
    const command = `cat ${FILE_A}`
    const message = renderToolRedirect(command, analyze(command)!)
    expect(message).not.toContain('parallel tool_use blocks')
  })

  test('names the clamp when it happened', () => {
    const command = `sed -n '1,5000p' ${FILE_A}`
    const message = renderToolRedirect(command, analyze(command)!)
    expect(message).toContain('clamped')
  })
})

// ---------------------------------------------------------------------------
// Wiring. BashTool.tsx reaches src/ink.js through its import chain, so it
// cannot be imported under `bun test` (see .claudin/rules/testing.md). Without
// this block, deleting the call from validateInput leaves every test above
// green while the redirect never fires in production.
// ---------------------------------------------------------------------------

describe('BashTool wiring', () => {
  const src = readFileSync(new URL('./BashTool.tsx', import.meta.url), 'utf8')

  test('validateInput consults the redirect', () => {
    expect(src).toContain('shouldRedirectToTools(input.command, getCwd(),')
    expect(src).toContain('renderToolRedirect(input.command, toolRedirect)')
  })

  test('only for tools in this agent toolset', () => {
    expect(src).toContain(
      'name => findToolByName(context?.options?.tools ?? [], name) !== undefined',
    )
  })

  test('records a disparo so adoption is measurable, without paths', () => {
    expect(src).toContain("logEvent('tengu_bash_tool_redirect'")
    // Analytics metadata is numbers and booleans only — no command, no paths.
    expect(src).not.toContain('command: input.command')
  })

  test('never for a backgrounded run, and honors the killswitch', () => {
    expect(src).toContain('CLAUDIN_DISABLE_TOOL_REDIRECT')
    expect(src).toContain(
      '!input.run_in_background && !isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_REDIRECT)',
    )
  })
})
