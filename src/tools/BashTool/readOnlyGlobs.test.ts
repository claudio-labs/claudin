// CLAUDIN_READONLY_GLOBS (readOnlyValidation.ts, readsPathGlobs): a path glob
// in a pure file reader keeps the read-only verdict, so `cat src/*.ts` needs
// neither the auto-mode classifier nor a prompt. On by default since
// 2026-09-25; `=0` restores the old verdict. Pinned at two levels: the verdict
// itself, and the whole Bash permission decision, where the path check that
// runs before the verdict must still ask for a glob outside the project.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { bashToolHasPermission } from 'src/tools/BashTool/bashPermissions.js'
import { checkReadOnlyConstraints } from 'src/tools/BashTool/readOnlyValidation.js'
import {
  makeToolUseContext,
  overrideSandbox,
  resetPermissionState,
  stubMacroVersion,
} from 'src/tools/BashTool/__testutils__/permissionContext.js'

const FLAG = 'CLAUDIN_READONLY_GLOBS'
const prior = process.env[FLAG]

beforeEach(() => {
  stubMacroVersion()
  // Git arms are refused outside the original cwd when the sandbox is on;
  // pin it off so the verdicts do not depend on the machine.
  overrideSandbox({ isSandboxingEnabled: () => false })
  // Every test starts from the default: the flag unset.
  delete process.env[FLAG]
})
afterEach(() => {
  resetPermissionState()
  if (prior === undefined) delete process.env[FLAG]
  else process.env[FLAG] = prior
})

function verdict(command: string): string {
  return checkReadOnlyConstraints({ command }, false).behavior
}

/** Path globs in the six readers: read-only by default, not with `=0`. */
const SPARED = [
  'cat src/*.ts',
  'cat ./*.ts',
  'cat "src"/*.ts',
  'cat src/agent/*.ts README.md',
  'head -20 src/*.ts',
  'tail -f logs/*.log',
  'wc -l src/**/*.ts',
  'ls src/*',
  'grep -n foo src/*.ts',
  'git ls-files && cat README.md package.json && cat src/*.ts',
  // An absolute path, and a `/` that quoting leaves inside the word.
  'cat /repo/src/*.ts',
  "cat 'src/'*.ts",
  'cat "src/"*.ts',
]

/**
 * Globs the flag must not spare. A word whose expansion could begin with `-`
 * (a flag) or lacks a `/` (a subcommand or a command name); a `$`, brace or
 * tilde expansion; a write; and a glob behind a command that executes one of
 * its arguments, where a multi-word expansion shifts the rest into that slot.
 */
const REFUSED = [
  'cat *',
  'cat -*',
  "cat ''*",
  'cat \\-*',
  'cat "-"*',
  'cat README*',
  'ls [a-z]*',
  'find ./ -?xec',
  'cat $X*',
  'cat src/$X*',
  'cat ~/*.md',
  'cat {src,-n}/*',
  'cat src/*.ts > out',
  'rm src/*.ts',
  'sort -o out src/*.txt',
  'xargs -I src/* echo',
  'nice -n src/* cat x',
  'git diff src/*',
  // A `-` or a `{` first, whatever follows it.
  'cat -x/*',
  'grep -n foo {a}/*.ts',
  // A backslash reaches the check only inside double quotes (the split drops
  // an unquoted one), and there `\-x` starts with `\`, not with the `-` after.
  'cat "\\-x"/*',
  // The `/` of an earlier word does not count for this one.
  'cat src/a.ts README*',
  // xargs's value slots take literals only today (`-I {}`, `-E EOF`), which is
  // what refuses the shift above; this pins xargs itself as never spared.
  'xargs echo src/*.ts',
]

describe('read-only verdict', () => {
  test('on by default, and with =1: a path glob in a pure reader keeps it', () => {
    for (const value of [undefined, '1']) {
      if (value === undefined) delete process.env[FLAG]
      else process.env[FLAG] = value
      for (const command of SPARED) {
        expect([value, command, verdict(command)]).toEqual([value, command, 'allow'])
      }
    }
  })

  test('=0 turns it off: every unquoted glob costs the verdict, as before', () => {
    for (const value of ['0', 'false']) {
      process.env[FLAG] = value
      for (const command of [...SPARED, ...REFUSED]) {
        expect([value, command, verdict(command)]).toEqual([value, command, 'passthrough'])
      }
    }
  })

  test('every other glob still costs it', () => {
    for (const command of REFUSED) {
      expect([command, verdict(command)]).toEqual([command, 'passthrough'])
    }
  })

  test('quoting and plain commands judge as before', () => {
    expect(verdict("grep -r 'a*b' src")).toBe('allow')
    expect(verdict('ls -la')).toBe('allow')
    expect(verdict('uniq --skip-chars=0$_ f')).toBe('passthrough')
  })
})

describe('the whole Bash permission decision', () => {
  test('a glob inside the project is allowed as read-only', async () => {
    const result = await bashToolHasPermission(
      { command: 'cat src/tools/BashTool/*.ts' },
      makeToolUseContext(),
    )
    expect(result.behavior).toBe('allow')
  })

  test('the path check still asks for a glob outside the project', async () => {
    for (const command of ['cat /etc/*.conf', 'cat ../*.md']) {
      const result = await bashToolHasPermission({ command }, makeToolUseContext())
      expect([command, result.behavior]).toEqual([command, 'ask'])
    }
  })

  test('with =0, the same in-project glob is not allowed', async () => {
    process.env[FLAG] = '0'
    const result = await bashToolHasPermission(
      { command: 'cat src/tools/BashTool/*.ts' },
      makeToolUseContext(),
    )
    expect(result.behavior).not.toBe('allow')
  })
})
