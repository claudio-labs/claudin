/**
 * The fixes the permissions/toolDialogs rewrite applies (spec Findings 1, 4,
 * 6 and 9), and the rule functions on their own, without Ink. The kept
 * behaviour is pinned by the four characterization suites.
 */
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool } from 'src/tools/Tool.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'
import { WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js'
import { WebFetchTool } from 'src/tools/WebFetchTool/WebFetchTool.js'
import { isolatedWorld, KEYS, linesOf, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { allowed, answer, ask, denied, shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'
import {
  addAllowRule,
  fetchHost,
  fetchRule,
  shellDelegateRule,
  skillRule,
  skillRuleContents,
  wholeToolRule,
} from 'src/permissions/ui/toolDialogs/rules.js'

isolatedWorld()
const optionLines = (frame: string) => shown(frame).filter(line => /^(❯ )?\d\./.test(line))

describe('the rule functions', () => {
  test('every allow-always update is one allow rule in the local settings', () => {
    expect(addAllowRule({ toolName: 'X', ruleContent: 'y' })).toEqual({
      type: 'addRules',
      rules: [{ toolName: 'X', ruleContent: 'y' }],
      behavior: 'allow',
      destination: 'localSettings',
    })
  })

  test('the tool-wide rule names the whole tool, with no content', () => {
    expect(wholeToolRule('mcp__infra__deploy')).toEqual({ toolName: 'mcp__infra__deploy' })
  })

  const skills: Array<[string, { exact: string; prefix: string | null } | null]> = [
    ['release', { exact: 'release', prefix: null }],
    ['review pr', { exact: 'review pr', prefix: 'review:*' }],
    ['a b c', { exact: 'a b c', prefix: 'a:*' }],
    ['/commit', { exact: '/commit', prefix: null }],
    ['plugin:deploy', { exact: 'plugin:deploy', prefix: null }],
    [' lead', { exact: ' lead', prefix: null }],
    // An empty name would be saved as the bare Skill rule, which allows every skill.
    ['', null],
  ]
  for (const [skill, contents] of skills) {
    test(`skill rules for ${JSON.stringify(skill)}`, () => {
      expect(skillRuleContents(skill)).toEqual(contents)
    })
  }

  test('a skill rule is a Skill rule with the content as given', () => {
    expect(skillRule('review:*')).toEqual({ toolName: 'Skill', ruleContent: 'review:*' })
  })

  const urls: Array<[unknown, string | null]> = [
    ['https://Docs.Example.COM:8443/x', 'docs.example.com'],
    ['https://api.github.com/repos', 'api.github.com'],
    ['https://user:secret@files.example.org/a', 'files.example.org'],
    ['https://bücher.example/katalog', 'xn--bcher-kva.example'],
    ['http://127.0.0.1:3000/health', '127.0.0.1'],
    ['http://[::1]:8080/', '[::1]'],
    ['not a url', null],
    ['', null],
    ['file:///etc/passwd', null],
    ['mailto:someone@example.com', null],
    [{ href: 'https://example.com' }, null],
    [undefined, null],
  ]
  for (const [url, host] of urls) {
    test(`the fetch host of ${JSON.stringify(url)}`, () => {
      expect(fetchHost(url)).toBe(host)
    })
  }

  test('a fetch rule holds the host alone, under the tool name', () => {
    expect(fetchRule('WebFetch', 'docs.example.com')).toEqual({ toolName: 'WebFetch', ruleContent: 'domain:docs.example.com' })
  })

  const commands: Array<[unknown, string | null]> = [
    ['make', 'make:*'],
    ['npm test', 'npm test:*'],
    ['tail -f build.log', 'tail -f:*'],
    ['rm -rf /tmp/scratch', 'rm -rf:*'],
    ['   npm    run   dev  ', 'npm run:*'],
    ['echo hi\nrm -rf /tmp/x', 'echo hi:*'],
    ['cd /srv && make deploy', 'cd /srv:*'],
    ['\ttabbed\tcommand\there', 'tabbed command:*'],
    ['', null],
    ['  \t ', null],
    [undefined, null],
    [42, null],
  ]
  for (const [command, content] of commands) {
    test(`the shell-delegate rule for ${JSON.stringify(command)}`, () => {
      expect(shellDelegateRule(command)).toEqual(content === null ? null : { toolName: 'Bash', ruleContent: content })
    })
  }
})

describe('Finding 1: the skill dialog never saves a rule from input it could not read', () => {
  const unreadable: Array<[string, Record<string, unknown>]> = [
    ['no skill field', { name: 'release' }],
    ['a skill that is not a string', { skill: 42 }],
    ['an empty skill name', { skill: '' }],
  ]
  for (const [name, input] of unreadable) {
    test(
      `${name}: only Yes and No are offered, and 2 is the deny`,
      async () => {
        const asked = await ask({ tool: SkillTool, input })
        expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No'])
        expect(asked.screen.text()).not.toContain("don't ask again")
        expect(await answer(asked, ['2', '3'])).toEqual(denied(undefined))
      },
      SLOW,
    )
  }

  test(
    'unreadable input still allows once with Yes, saving nothing',
    async () => {
      const input = { name: 'release' }
      const asked = await ask({ tool: SkillTool, input })
      expect(await answer(asked, ['1'])).toEqual(allowed(input, [], undefined))
    },
    SLOW,
  )
})

describe('Finding 4: the fetch dialog opens for any input and offers allow-always only for a readable host', () => {
  const cases: Array<[string, Record<string, unknown>, string | null]> = [
    ['a URL that does not parse', { url: 'not a url', prompt: 'p' }, 'not a url'],
    ['a URL with no host', { url: 'file:///etc/passwd', prompt: 'p' }, 'file:///etc/passwd'],
    ['input the schema refuses, with a parseable URL', { url: 'https://docs.example.com/', prompt: 'p', extra: true }, 'https://docs.example.com/'],
    ['a URL that is not a string', { url: { href: 'https://docs.example.com/' }, prompt: 'p' }, null],
  ]
  for (const [name, input, rendered] of cases) {
    test(
      `${name}: the dialog renders, Yes and No only, and 2 is the deny`,
      async () => {
        const asked = await ask({ tool: WebFetchTool, input, description: 'fetch it' })
        const lines = shown(asked.screen.text())
        expect(lines[1]).toBe('Fetch')
        if (rendered !== null) expect(lines[2]).toBe(rendered)
        expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No, and tell Claude what to do differently (esc)'])
        expect(asked.screen.text()).not.toContain('input:')
        expect(await answer(asked, ['2', '3'])).toEqual(denied())
      },
      SLOW,
    )
  }

  test(
    'Yes on an unreadable fetch allows once and saves nothing',
    async () => {
      const input = { url: 'not a url', prompt: 'p' }
      const asked = await ask({ tool: WebFetchTool, input })
      expect(await answer(asked, ['1'])).toEqual(allowed(input, []))
    },
    SLOW,
  )
})

describe('Finding 6: option numbers keep their space when an allow-always label wraps', () => {
  const mcpTool = {
    name: 'mcp__infra__deploy',
    isMcp: true,
    inputSchema: z.object({ target: z.string() }),
    userFacingName: () => 'infra - deploy (MCP)',
    renderToolUseMessage: (input: { target: string }) => `to ${input.target}`,
    isReadOnly: () => false,
  } as unknown as Tool
  const dialogs: Array<[string, Tool, Record<string, unknown>, number[]]> = [
    ['tool-wide', mcpTool, { target: 'production' }, [40, 45, 55, 60, 90]],
    ['skill', SkillTool, { skill: 'review pr' }, [40, 45, 50, 85]],
    ['shell delegate', WaitForTool as unknown as Tool, { command: 'tail -f build.log', until: 'ready' }, [45, 50, 80]],
  ]
  for (const [name, tool, input, widths] of dialogs) {
    test(
      `the ${name} dialog at ${widths.join(', ')} columns`,
      async () => {
        for (const columns of widths) {
          const { screen } = await ask({ tool, input, columns })
          const numbered = linesOf(screen.text()).filter(line => /^\s*(❯ )?\d\./.test(line))
          expect(numbered.length).toBeGreaterThanOrEqual(3)
          for (const line of numbered) expect(`${columns}: ${line}`).toMatch(/^\d+: \s*(❯ )?\d\. \S/)
          await screen.close()
        }
      },
      SLOW,
    )
  }
})

describe('an allow-always option never takes a note', () => {
  const dialogs: Array<[string, Tool, Record<string, unknown>]> = [
    ['skill', SkillTool, { skill: 'review pr' }],
    ['shell delegate', WaitForTool as unknown as Tool, { command: 'tail -f build.log', until: 'ready' }],
  ]
  for (const [name, tool, input] of dialogs) {
    test(
      `the ${name} dialog: on an allow-always option the hint offers no amend, and Tab opens nothing`,
      async () => {
        const asked = await ask({ tool, input })
        await asked.screen.press(KEYS.down)
        await asked.screen.until(() => shown(asked.screen.text()).at(-1) === 'Esc to cancel', 'the hint without amend')
        await asked.screen.press(KEYS.tab)
        await Bun.sleep(120)
        expect(shown(asked.screen.text()).at(-1)).toBe('Esc to cancel')
        expect(optionLines(asked.screen.text())[1]).toMatch(/^❯ 2\. Yes, and don't ask again for \S/)
      },
      SLOW,
    )
  }
})

describe('Finding 9: the skill dialog draws no empty box without a command description', () => {
  test(
    'one blank line between the note and the question, and nothing else',
    async () => {
      const { screen } = await ask({ tool: SkillTool, input: { skill: 'release' } })
      const lines = linesOf(screen.text())
      const note = lines.findIndex(line => line.includes('Claude may use instructions'))
      const question = lines.findIndex(line => line.includes('Do you want to proceed?'))
      expect(lines.slice(note + 1, question)).toEqual([''])
    },
    SLOW,
  )

  test(
    'an empty description draws nothing either',
    async () => {
      const permissionResult = { behavior: 'ask', message: 'Execute skill', metadata: { command: { description: '' } } } as never
      const { screen } = await ask({ tool: SkillTool, input: { skill: 'release' }, permissionResult })
      const lines = linesOf(screen.text())
      const note = lines.findIndex(line => line.includes('Claude may use instructions'))
      const question = lines.findIndex(line => line.includes('Do you want to proceed?'))
      expect(lines.slice(note + 1, question)).toEqual([''])
    },
    SLOW,
  )

  test(
    'a description sits between the note and the question, indented',
    async () => {
      const permissionResult = { behavior: 'ask', message: 'Execute skill', metadata: { command: { description: 'Cuts a release' } } } as never
      const { screen } = await ask({ tool: SkillTool, input: { skill: 'release' }, permissionResult })
      const lines = linesOf(screen.text())
      const note = lines.findIndex(line => line.includes('Claude may use instructions'))
      const question = lines.findIndex(line => line.includes('Do you want to proceed?'))
      const between = lines.slice(note + 1, question)
      expect(between.map(line => line.trim())).toEqual(['Cuts a release', ''])
      expect(between[0]!.indexOf('Cuts')).toBeGreaterThan(lines[note]!.indexOf('Claude'))
    },
    SLOW,
  )
})
