/**
 * Characterization of the tool-wide permission dialog: the one every tool
 * without a dialog of its own is routed to, MCP tools among them. Written
 * before the clean-base rewrite of permissions/toolDialogs; the spec is
 * docs/tech/rewrite/permissions/toolDialogs.md.
 *
 * The dialog is reached through `PermissionRequest`, as the REPL reaches it.
 * Its "don't ask again" writes an allow rule for the whole tool, so every
 * answer is checked for the full list of calls it makes, in order: an extra
 * or a missing call is as much a regression as a wrong argument.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { z } from 'zod/v4'
import { Text } from 'src/terminal/ink.js'
import type { Tool } from 'src/tools/Tool.js'
import { flat, isolatedWorld, KEYS, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { allowed, allowRule, answer, ask, type Call, denied, managedRulesOnly, shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'

const world = isolatedWorld()
withTruecolor()
const { enter, esc, tab, down, up } = KEYS
const chars = (text: string) => [...text]

/** What the dialog was asked to render the tool use with, per mount. */
const renderCalls: Array<{ input: unknown; verbose: unknown }> = []

function toolNamed(name: string, shownAs: string, isMcp?: boolean): Tool {
  return {
    name,
    isMcp,
    inputSchema: z.object({ target: z.string() }),
    userFacingName: () => shownAs,
    renderToolUseMessage: (input: { target: string }, options: { verbose: boolean }) => {
      renderCalls.push({ input, verbose: options.verbose })
      return `to ${input.target}`
    },
    isReadOnly: () => false,
  } as unknown as Tool
}

const mcpTool = toolNamed('mcp__infra__deploy', 'infra - deploy (MCP)', true)
const localTool = toolNamed('ShipIt', 'Ship')
const INPUT = { target: 'production' }

async function referenceCodes(props: React.ComponentProps<typeof Text>): Promise<string> {
  const screen = await mount(<Text {...props}>SAMPLE</Text>)
  const codes = styleBefore(screen.styled(), 'SAMPLE')
  await screen.close()
  return codes
}

describe('FallbackPermissionRequest: what it shows', () => {
  test(
    'an MCP tool: the headline, the call without the (MCP) suffix, the suffix after it, the description, the question and three options',
    async () => {
      const { screen } = await ask({ tool: mcpTool, input: INPUT, description: 'Ships the build' })
      const cwd = world().project
      expect(shown(screen.text())).toEqual([
        '─'.repeat(120),
        'Tool use',
        'infra - deploy(to production) (MCP)',
        'Ships the build',
        'Do you want to proceed?',
        '❯ 1. Yes',
        `2. Yes, and don't ask again for infra - deploy commands in ${cwd}`,
        '3. No',
        'Esc to cancel · Tab to amend',
      ])
    },
    SLOW,
  )

  test(
    'a tool that is not an MCP tool: its user-facing name is shown as is, with no suffix',
    async () => {
      const { screen } = await ask({ tool: localTool, input: INPUT })
      const lines = shown(screen.text())
      expect(lines).toContain('Ship(to production)')
      expect(lines).toContain(`2. Yes, and don't ask again for Ship commands in ${world().project}`)
      expect(screen.text()).not.toContain('(MCP)')
    },
    SLOW,
  )

  test(
    'the tool use is always rendered in its verbose form, whatever the caller asked for',
    async () => {
      for (const verbose of [false, true]) {
        renderCalls.length = 0
        const { screen } = await ask({ tool: localTool, input: { target: 'staging' }, verbose })
        expect(renderCalls.length).toBeGreaterThan(0)
        expect(renderCalls.every(call => call.verbose === true)).toBe(true)
        expect(renderCalls[0]!.input).toEqual({ target: 'staging' })
        await screen.close()
      }
    },
    SLOW,
  )

  const descriptions: Array<[string, string, string[]]> = [
    ['one line', 'alpha', ['alpha']],
    ['three lines, shown whole', 'alpha\nbeta\ngamma', ['alpha', 'beta', 'gamma']],
    ['five lines, cut to three with an ellipsis', 'alpha\nbeta\ngamma\ndelta\nepsilon', ['alpha', 'beta', 'gamma…']],
  ]
  for (const [name, description, expected] of descriptions) {
    test(
      `the description: ${name}`,
      async () => {
        const { screen } = await ask({ tool: localTool, input: INPUT, description })
        const lines = shown(screen.text())
        const from = lines.indexOf('Ship(to production)') + 1
        expect(lines.slice(from, lines.indexOf('Do you want to proceed?'))).toEqual(expected)
      },
      SLOW,
    )
  }

  test(
    'styling: the (MCP) suffix and the description are dim; the name and the directory in the always option are bold',
    async () => {
      const { screen } = await ask({ tool: mcpTool, input: INPUT, description: 'Ships the build' })
      const styled = screen.styled()
      const dim = await referenceCodes({ dimColor: true })
      const bold = await referenceCodes({ bold: true })
      expect(styleBefore(styled, ' (MCP)')).toBe(dim)
      expect(styleBefore(styled, 'Ships the build')).toBe(dim)
      const alwaysOption = styled.slice(styled.indexOf('ask again for'))
      expect(styleBefore(alwaysOption, 'infra - deploy')).toBe(bold)
      expect(styleBefore(alwaysOption, world().project)).toBe(bold)
      expect(styleBefore(styled, 'infra - deploy(')).toBe('')
    },
    SLOW,
  )

  test(
    'the worker badge joins the headline',
    async () => {
      const { screen } = await ask({ tool: localTool, input: INPUT, workerBadge: { name: 'shipper', color: 'blue' } })
      expect(shown(screen.text())[1]).toBe('Tool use · @shipper')
    },
    SLOW,
  )

  test(
    'the reason the prompt asked is shown above the question',
    async () => {
      const { screen } = await ask({
        tool: localTool,
        input: INPUT,
        permissionResult: {
          behavior: 'ask',
          message: 'asking',
          decisionReason: { type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'ShipIt' } } },
        },
      })
      const text = flat(screen.text())
      expect(text).toContain('Permission rule ShipIt requires confirmation for this tool. /permissions to update rules Do you want to proceed?')
    },
    SLOW,
  )

  test(
    'when managed policy keeps rules to itself, only Yes and No are offered',
    async () => {
      managedRulesOnly(world().home)
      const { screen } = await ask({ tool: mcpTool, input: INPUT })
      const lines = shown(screen.text())
      expect(lines.filter(line => /^(❯ )?\d\./.test(line))).toEqual(['❯ 1. Yes', '2. No'])
      expect(screen.text()).not.toContain("don't ask again")
    },
    SLOW,
  )
})

describe('FallbackPermissionRequest: what each answer reports', () => {
  const ALWAYS = allowRule('mcp__infra__deploy')
  type Row = { name: string; keys: string[]; calls: Call[]; escapes?: number; managed?: boolean }
  const rows: Row[] = [
    { name: 'Enter on Yes: allow once, no rule, no note', keys: [enter], calls: allowed(INPUT, [], undefined) },
    { name: '1: allow once', keys: ['1'], calls: allowed(INPUT, [], undefined) },
    { name: 'Yes with a note: allow once, the note trimmed', keys: [tab, ...chars('  only today  '), enter], calls: allowed(INPUT, [], 'only today') },
    { name: '2: allow always, a whole-tool rule under the raw tool name, saved locally, and no third argument', keys: ['2'], calls: allowed(INPUT, [ALWAYS]) },
    { name: 'Down, Enter: allow always', keys: [down, enter], calls: allowed(INPUT, [ALWAYS]) },
    { name: 'Tab on the always option opens no note: Enter still allows always', keys: [down, tab, ...chars('x'), enter], calls: allowed(INPUT, [ALWAYS]) },
    { name: 'Up from Yes wraps to No', keys: [up, enter], calls: denied(undefined) },
    { name: '3: deny with no note', keys: ['3'], calls: denied(undefined) },
    { name: 'No with a note: deny with the note', keys: [down, down, tab, ...chars('use staging'), enter], calls: denied('use staging') },
    { name: 'Esc: deny with no arguments at all, one escape counted', keys: [esc], calls: denied(), escapes: 1 },
    { name: 'Esc with a Yes note written: still a deny', keys: [tab, ...chars('fine'), esc], calls: denied(), escapes: 1 },
    { name: 'y, n and an out-of-range 4: nothing', keys: ['y', 'n', '4'], calls: [] },
    { name: 'managed policy: 2 is the deny', keys: ['2'], calls: denied(undefined), managed: true },
    { name: 'managed policy: 3 is out of range', keys: ['3'], calls: [], managed: true },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        if (row.managed) managedRulesOnly(world().home)
        const asked = await ask({ tool: mcpTool, input: INPUT })
        expect(await answer(asked, row.keys)).toEqual(row.calls)
        expect(asked.screen.state().attribution.escapeCount).toBe(row.escapes ?? 0)
      },
      SLOW,
    )
  }

  test(
    'the rule names the tool, not what the user sees',
    async () => {
      const asked = await ask({ tool: localTool, input: INPUT })
      expect(await answer(asked, ['2'])).toEqual(allowed(INPUT, [allowRule('ShipIt')]))
    },
    SLOW,
  )

  test(
    'the dialog counts one permission prompt',
    async () => {
      const asked = await ask({ tool: mcpTool, input: INPUT })
      await asked.screen.until(() => asked.screen.state().attribution.permissionPromptCount === 1, 'the prompt count')
    },
    SLOW,
  )
})
