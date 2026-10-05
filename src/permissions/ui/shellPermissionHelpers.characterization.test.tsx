/**
 * Characterization of the label the shell dialogs (Bash, PowerShell) put on
 * their "allow always" option when it cannot be an editable field: the
 * suggestions carry a directory, a Read rule, or several commands. Written
 * before the clean-base rewrite of permissions/shellDialogs; the spec is
 * docs/tech/rewrite/permissions/shellDialogs.md.
 *
 * The label is a React node, so each case is drawn on the fake terminal and
 * read back as text.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { generateShellSuggestionsLabel } from 'src/permissions/ui/shellPermissionHelpers.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { Text } from 'src/terminal/ink.js'
import { flat, isolatedWorld, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

isolatedWorld()
withTruecolor()

type Rule = { toolName: string; ruleContent?: string }
const rules = (...list: Rule[]): PermissionUpdate => ({ type: 'addRules', rules: list, behavior: 'allow', destination: 'localSettings' }) as PermissionUpdate
const dirs = (...directories: string[]): PermissionUpdate => ({ type: 'addDirectories', directories, destination: 'session' }) as PermissionUpdate
const bash = (ruleContent?: string): Rule => ({ toolName: 'Bash', ruleContent })
const read = (ruleContent: string): Rule => ({ toolName: 'Read', ruleContent })

async function drawn(node: React.ReactNode): Promise<{ text: string; styled: string }> {
  const screen = await mount(<Text>{node}</Text>, { columns: 300 })
  const out = { text: flat(screen.text()), styled: screen.styled() }
  await screen.close()
  return out
}

describe('generateShellSuggestionsLabel', () => {
  // `<cwd>` stands for the session's starting directory.
  const rows: Array<[string, PermissionUpdate[], string]> = [
    ['one command', [rules(bash('npm run:*'))], "Yes, and don't ask again for npm run commands in <cwd>"],
    ['an exact command is named whole', [rules(bash('git status'))], "Yes, and don't ask again for git status commands in <cwd>"],
    ['two commands', [rules(bash('npm test:*'), bash('git push:*'))], "Yes, and don't ask again for npm test and git push commands in <cwd>"],
    ['three commands, across updates', [rules(bash('a:*'), bash('b:*')), rules(bash('c:*'))], "Yes, and don't ask again for a, b, and c commands in <cwd>"],
    ['the same command twice is named once', [rules(bash('npm run:*'), bash('npm run'))], "Yes, and don't ask again for npm run commands in <cwd>"],
    ['more than 50 characters of commands: "similar"', [rules(bash('docker compose run --rm migrations:*'), bash('kubectl rollout status deployment:*'))], "Yes, and don't ask again for similar commands in <cwd>"],
    ['one Read path', [rules(read('/srv/app/docs/**'))], 'Yes, allow reading from docs/ from this project'],
    ['two Read paths', [rules(read('/srv/app/docs/**'), read('/srv/app/src/**'))], 'Yes, allow reading from docs/ and src/ from this project'],
    ['three Read paths', [rules(read('/a/x/**'), read('/a/y/**'), read('/a/z/**'))], 'Yes, allow reading from x/, y/ and 1 more from this project'],
    ['one directory', [dirs('/srv/out')], 'Yes, and always allow access to out/ from this project'],
    ['two directories', [dirs('/srv/out', '/srv/tmp')], 'Yes, and always allow access to out/ and tmp/ from this project'],
    ['four directories', [dirs('/a/p', '/a/q', '/a/r', '/a/s')], 'Yes, and always allow access to p/, q/ and 2 more from this project'],
    ['the root directory keeps its own name', [dirs('/')], 'Yes, and always allow access to // from this project'],
    ['a directory and a Read path', [dirs('/srv/out'), rules(read('/srv/docs/**'))], 'Yes, and always allow access to out/ and docs/ from this project'],
    ['one path and one command', [dirs('/srv/out'), rules(bash('make:*'))], 'Yes, and allow access to out/ and make commands'],
    ['a Read path and one command', [rules(read('/srv/docs/**'), bash('cat:*'))], 'Yes, and allow access to docs/ and cat commands'],
    ['several paths and commands', [dirs('/srv/out', '/srv/tmp'), rules(bash('make:*'), bash('cp:*'))], 'Yes, and allow out/ and tmp/ access and make and cp commands'],
    ['one path and several commands', [dirs('/srv/out'), rules(bash('make:*'), bash('cp:*'))], 'Yes, and allow out/ access and make and cp commands'],
  ]
  for (const [name, suggestions, label] of rows) {
    test(
      name,
      async () => {
        const node = generateShellSuggestionsLabel(suggestions, 'Bash')
        expect(node).not.toBeNull()
        expect((await drawn(node)).text).toBe(label.replace('<cwd>', getOriginalCwd()))
      },
      SLOW,
    )
  }

  const nothing: Array<[string, PermissionUpdate[]]> = [
    ['no suggestions', []],
    ['only another shell\'s rules', [rules({ toolName: 'PowerShell', ruleContent: 'Get-Process' })]],
    ['a whole-tool rule (no content)', [rules(bash())]],
    ['a Read rule with no path', [rules({ toolName: 'Read' })]],
    ['an empty directory list', [dirs()]],
    ['updates that are not additions', [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' } as PermissionUpdate]],
  ]
  for (const [name, suggestions] of nothing) {
    test(`${name}: no label at all`, () => {
      expect(generateShellSuggestionsLabel(suggestions, 'Bash')).toBeNull()
    })
  }

  test(
    'only the named shell\'s rules count, so the same updates read differently per shell',
    async () => {
      const mixed = [rules(bash('make:*'), { toolName: 'PowerShell', ruleContent: 'Get-Item:*' })]
      expect((await drawn(generateShellSuggestionsLabel(mixed, 'PowerShell'))).text).toBe(`Yes, and don't ask again for Get-Item commands in ${getOriginalCwd()}`)
      expect((await drawn(generateShellSuggestionsLabel(mixed, 'Bash'))).text).toBe(`Yes, and don't ask again for make commands in ${getOriginalCwd()}`)
    },
    SLOW,
  )

  test(
    'the transform reshapes each command for display, and equal results merge',
    async () => {
      const node = generateShellSuggestionsLabel([rules(bash('echo hi > a.txt'), bash('echo hi > b.txt'))], 'Bash', command => command.split(' >')[0]!)
      expect((await drawn(node)).text).toBe(`Yes, and don't ask again for echo hi commands in ${getOriginalCwd()}`)
    },
    SLOW,
  )

  test(
    'styling: the commands, the folder names and the working directory are bold',
    async () => {
      const bold = await (async () => {
        const probe = await mount(<Text bold>SAMPLE</Text>)
        const codes = styleBefore(probe.styled(), 'SAMPLE')
        await probe.close()
        return codes
      })()
      const commands = await drawn(generateShellSuggestionsLabel([rules(bash('npm test:*'), bash('git push:*'))], 'Bash'))
      expect(styleBefore(commands.styled, 'npm test')).toBe(bold)
      expect(styleBefore(commands.styled, 'git push')).toBe(bold)
      expect(styleBefore(commands.styled, getOriginalCwd())).toBe(bold)
      const folders = await drawn(generateShellSuggestionsLabel([dirs('/srv/out', '/srv/tmp')], 'Bash'))
      expect(styleBefore(folders.styled, 'out')).toBe(bold)
      expect(styleBefore(folders.styled, 'tmp')).toBe(bold)
    },
    SLOW,
  )
})
