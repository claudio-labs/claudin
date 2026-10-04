/**
 * Characterization of the frame every permission dialog is drawn in, and of
 * the small pieces drawn with it: the title block, the worker badge, the
 * "waiting for the team lead" card a worker shows, and the line that says
 * which rule or hook asked for the prompt. Written before the clean-base
 * rewrite of permissions/promptFrame; the spec is
 * docs/tech/rewrite/permissions/promptFrame.md.
 *
 * Layout is checked by fact (which line, which column, which edge) and
 * colours by comparison with the theme colour rendered on its own, never by
 * a snapshot of the whole screen.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { clearDynamicTeamContext, setDynamicTeamContext } from 'src/agent/coordinator/teammate.js'
import type { PermissionDecisionReason } from 'src/permissions/PermissionResult.js'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import { PermissionRequestTitle } from 'src/permissions/ui/PermissionRequestTitle.js'
import { PermissionRuleExplanation, type PermissionRuleExplanationProps } from 'src/permissions/ui/PermissionRuleExplanation.js'
import { WorkerBadge } from 'src/permissions/ui/WorkerBadge.js'
import { WorkerPendingPermission } from 'src/permissions/ui/WorkerPendingPermission.js'
import { Text } from 'src/terminal/ink.js'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import { toInkColor } from 'src/terminal/render/ink.js'
import type { Theme } from 'src/terminal/theme/theme.js'
import { flat, linesOf, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

withTruecolor()

/** The SGR codes the renderer uses for a style, read off a reference word. */
async function codesFor(style: React.ComponentProps<typeof Text>): Promise<string> {
  const screen = await mount(<Text {...style}>REFERENCE</Text>)
  const codes = styleBefore(screen.styled(), 'REFERENCE')
  await screen.close()
  return codes
}

const PATH = '/home/someone/projects/payments/src/ledger/reconcile.ts'

describe('PermissionDialog: the frame', () => {
  for (const columns of [80, 52]) {
    test(
      `at ${columns} columns: a blank line, a rule as wide as the terminal, the title and subtitle at column 1, then the body`,
      async () => {
        const screen = await mount(
          <PermissionDialog title="Edit file" subtitle="reconcile.ts">
            <Text>the body</Text>
          </PermissionDialog>,
          { columns },
        )
        expect(linesOf(screen.text())).toEqual(['', '─'.repeat(columns), ' Edit file', ' reconcile.ts', ' the body'])
      },
      SLOW,
    )
  }

  test(
    'only the top edge is drawn: no corners, no sides, nothing under the body',
    async () => {
      const screen = await mount(
        <PermissionDialog title="Tool use">
          <Text>first</Text>
          <Text>second</Text>
        </PermissionDialog>,
      )
      const frame = screen.text()
      expect(frame).not.toMatch(/[│╭╮╰╯]/)
      expect(linesOf(frame).slice(2)).toEqual([' Tool use', ' first', ' second'])
    },
    SLOW,
  )

  for (const [padding, indent] of [
    [0, ''],
    [4, '    '],
  ] as const) {
    test(
      `an inner padding of ${padding} moves the body, never the title`,
      async () => {
        const screen = await mount(
          <PermissionDialog title="Fetch" innerPaddingX={padding}>
            <Text>the body</Text>
          </PermissionDialog>,
        )
        expect(linesOf(screen.text()).slice(2)).toEqual([' Fetch', `${indent}the body`])
      },
      SLOW,
    )
  }

  test(
    'a worker badge follows the title on its line as "· @name"',
    async () => {
      const screen = await mount(
        <PermissionDialog title="Bash command" workerBadge={{ name: 'tester', color: 'green' }}>
          <Text>the body</Text>
        </PermissionDialog>,
      )
      expect(linesOf(screen.text())[2]).toBe(' Bash command · @tester')
    },
    SLOW,
  )

  test(
    'whatever goes on the right of the title is pushed to the right edge of the same line',
    async () => {
      const columns = 60
      const screen = await mount(
        <PermissionDialog title="Ready to code?" titleRight={<Text>ctrl+g to edit</Text>}>
          <Text>the body</Text>
        </PermissionDialog>,
        { columns },
      )
      const titleLine = linesOf(screen.text())[2]!
      expect(titleLine.startsWith(' Ready to code?')).toBe(true)
      expect(titleLine.endsWith('ctrl+g to edit')).toBe(true)
      expect(titleLine.length).toBe(columns - 1)
    },
    SLOW,
  )

  test(
    'a subtitle given as an element is drawn as it is, on the line under the title',
    async () => {
      const screen = await mount(
        <PermissionDialog title="Edit notebook" subtitle={<Text color="error">a custom subtitle</Text>}>
          <Text>the body</Text>
        </PermissionDialog>,
      )
      expect(linesOf(screen.text())[3]).toBe(' a custom subtitle')
      expect(styleBefore(screen.styled(), 'a custom subtitle')).toBe(await codesFor({ color: 'error' }))
    },
    SLOW,
  )

  for (const columns of [80, 34, 24]) {
    test(
      `at ${columns} columns a long subtitle keeps one line and loses its start, never its end`,
      async () => {
        const screen = await mount(
          <PermissionDialog title="Edit file" subtitle={PATH}>
            <Text>the body</Text>
          </PermissionDialog>,
          { columns },
        )
        const lines = linesOf(screen.text())
        expect(lines[4]).toBe(' the body')
        const subtitle = lines[3]!.trim()
        if (PATH.length <= columns - 2) {
          expect(subtitle).toBe(PATH)
        } else {
          expect(subtitle.startsWith('…')).toBe(true)
          expect(PATH.endsWith(subtitle.slice(1))).toBe(true)
          expect(subtitle.length).toBe(columns - 2)
        }
      },
      SLOW,
    )
  }

  for (const columns of [80, 30, 18]) {
    test(
      `at ${columns} columns a long title wraps as one sentence`,
      async () => {
        const title = 'Allow this agent to rewrite the payment ledger?'
        const screen = await mount(
          <PermissionDialog title={title}>
            <Text>the body</Text>
          </PermissionDialog>,
          { columns },
        )
        expect(flat(screen.text())).toContain(`${title} the body`)
      },
      SLOW,
    )
  }
})

describe('PermissionDialog: colours', () => {
  type Row = { name: string; props: { color?: keyof Theme; titleColor?: keyof Theme }; rule: keyof Theme; title: keyof Theme }
  const rows: Row[] = [
    { name: 'by default the rule and the bold title are in the permission colour', props: {}, rule: 'permission', title: 'permission' },
    { name: 'a colour recolours the rule only', props: { color: 'error' }, rule: 'error', title: 'permission' },
    { name: 'a title colour recolours the title only', props: { titleColor: 'warning' }, rule: 'permission', title: 'warning' },
    { name: 'both together', props: { color: 'error', titleColor: 'success' }, rule: 'error', title: 'success' },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const screen = await mount(
          <PermissionDialog title="Bash command" {...row.props}>
            <Text>the body</Text>
          </PermissionDialog>,
        )
        const styled = screen.styled()
        expect(styleBefore(styled, '────')).toBe(await codesFor({ color: row.rule }))
        expect(styleBefore(styled, 'Bash command')).toBe(await codesFor({ color: row.title, bold: true }))
      },
      SLOW,
    )
  }

  test(
    'a text subtitle and the worker badge are dim',
    async () => {
      const screen = await mount(
        <PermissionDialog title="Fetch" subtitle="example.com" workerBadge={{ name: 'scout', color: 'blue' }}>
          <Text>the body</Text>
        </PermissionDialog>,
      )
      const dim = await codesFor({ dimColor: true })
      expect(styleBefore(screen.styled(), 'example.com')).toBe(dim)
      expect(styleBefore(screen.styled(), '· @scout')).toBe(dim)
    },
    SLOW,
  )
})

describe('PermissionRequestTitle', () => {
  test(
    'on its own: the title with the badge, then the subtitle, with nothing around them',
    async () => {
      const screen = await mount(
        <PermissionRequestTitle title="Which file?" subtitle="pick one" workerBadge={{ name: 'helper', color: 'red' }} />,
      )
      expect(linesOf(screen.text())).toEqual(['Which file? · @helper', 'pick one'])
      expect(styleBefore(screen.styled(), 'Which file?')).toBe(await codesFor({ color: 'permission', bold: true }))
    },
    SLOW,
  )

  test(
    'a colour recolours the title, and without a subtitle or badge only the title is drawn',
    async () => {
      const screen = await mount(<PermissionRequestTitle title="Plain" color="error" />)
      expect(linesOf(screen.text())).toEqual(['Plain'])
      expect(styleBefore(screen.styled(), 'Plain')).toBe(await codesFor({ color: 'error', bold: true }))
    },
    SLOW,
  )
})

describe('WorkerBadge', () => {
  for (const color of ['red', 'cyan', 'magenta', '']) {
    test(
      `"● @name", the name bold, all in the colour the agent colour "${color}" stands for`,
      async () => {
        const screen = await mount(<WorkerBadge name="reviewer" color={color} />)
        expect(screen.text().trim()).toBe('● @reviewer')
        expect(styleBefore(screen.styled(), '●')).toBe(await codesFor({ color: toInkColor(color) }))
        expect(styleBefore(screen.styled(), '@reviewer').endsWith(await codesFor({ bold: true }))).toBe(true)
      },
      SLOW,
    )
  }
})

describe('WorkerPendingPermission', () => {
  afterEach(() => clearDynamicTeamContext())

  /** The card's content lines, without the box drawn round them. */
  const inside = (frame: string) =>
    linesOf(frame)
      .slice(1, -1)
      .map(line => line.replace(/^│/, '').replace(/│$/, '').trim())

  const team = { agentId: 'builder@alpha', agentName: 'builder', teamName: 'alpha', planModeRequired: false }
  type Row = { name: string; context: (typeof team & { color?: string }) | null; content: string[] }
  const rows: Row[] = [
    {
      name: 'a named, coloured worker in a team',
      context: { ...team, color: 'green' },
      content: ['Waiting for team lead approval', '', '● @builder', '', 'Tool: Bash', 'Action: run the tests', '', 'Permission request sent to team "alpha" leader'],
    },
    {
      name: 'a worker without a colour gets no badge',
      context: team,
      content: ['Waiting for team lead approval', '', 'Tool: Bash', 'Action: run the tests', '', 'Permission request sent to team "alpha" leader'],
    },
    {
      name: 'without a team name the last line goes',
      context: { ...team, teamName: '', color: 'green' },
      content: ['Waiting for team lead approval', '', '● @builder', '', 'Tool: Bash', 'Action: run the tests'],
    },
    {
      name: 'outside any team only the request is shown',
      context: null,
      content: ['Waiting for team lead approval', '', 'Tool: Bash', 'Action: run the tests'],
    },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        if (row.context) setDynamicTeamContext(row.context)
        const screen = await mount(<WorkerPendingPermission toolName="Bash" description="run the tests" />)
        const content = inside(screen.text())
        // The first line starts with a spinner frame, which moves.
        expect(content[0]).toMatch(/^\S+\s+Waiting for team lead approval$/)
        expect(['Waiting for team lead approval', ...content.slice(1)]).toEqual(row.content)
      },
      SLOW,
    )
  }

  test(
    'a rounded box in the warning colour, as wide as the terminal, with the waiting line in bold warning',
    async () => {
      const columns = 60
      const screen = await mount(<WorkerPendingPermission toolName="Fetch" description="example.com" />, { columns })
      const lines = linesOf(screen.text())
      expect(lines[0]).toBe(`╭${'─'.repeat(columns - 2)}╮`)
      expect(lines.at(-1)).toBe(`╰${'─'.repeat(columns - 2)}╯`)
      for (const line of lines.slice(1, -1)) expect(line).toMatch(/^│ .*│$/)
      const warning = await codesFor({ color: 'warning' })
      expect(styleBefore(screen.styled(), '╭')).toBe(warning)
      expect(styleBefore(screen.styled(), ' Waiting for team lead approval')).toBe(await codesFor({ color: 'warning', bold: true }))
      expect(styleBefore(screen.styled(), 'Tool: ')).toBe(await codesFor({ dimColor: true }))
    },
    SLOW,
  )

  for (const columns of [80, 44, 30]) {
    test(
      `at ${columns} columns the tool and the action keep their words in order`,
      async () => {
        const description = 'rebuild the search index for every tenant'
        const screen = await mount(<WorkerPendingPermission toolName="Bash" description={description} />, { columns })
        const words = flat(inside(screen.text()).join('\n'))
        expect(words).toContain(`Tool: Bash Action`)
        expect(words).toContain(description)
        // Only a width with room for the whole line keeps the label's colon and space (see the spec's findings).
        if (columns === 80) expect(words).toContain(`Tool: Bash Action: ${description}`)
      },
      SLOW,
    )
  }
})

describe('PermissionRuleExplanation', () => {
  const ruleFrom = (source: string, toolName: string, ruleContent?: string): PermissionDecisionReason =>
    ({ type: 'rule', rule: { source, ruleBehavior: 'ask', ruleValue: { toolName, ruleContent } } }) as PermissionDecisionReason

  type Row = { name: string; reason: PermissionDecisionReason | undefined; lines: (kind: string) => string[] }
  const RULES = '/permissions to update rules'
  const HOOKS = '/hooks to update'
  const rows: Row[] = [
    {
      name: 'a rule from the user settings',
      reason: ruleFrom('userSettings', 'Bash', 'git push:*'),
      lines: kind => [`Permission rule Bash(git push:*) requires confirmation for this ${kind}.`, RULES],
    },
    {
      name: 'a rule from the project settings',
      reason: ruleFrom('projectSettings', 'Write'),
      lines: kind => [`Permission rule Write requires confirmation for this ${kind}.`, RULES],
    },
    {
      name: 'a rule from managed policy, which the user cannot change',
      reason: ruleFrom('policySettings', 'WebFetch', 'domain:example.com'),
      lines: kind => [`Permission rule WebFetch(domain:example.com) requires confirmation for this ${kind}.`],
    },
    {
      name: 'a hook with a reason',
      reason: { type: 'hook', hookName: 'guard.sh', reason: 'touches production' },
      lines: kind => [`Hook guard.sh requires confirmation for this ${kind}:`, 'touches production', HOOKS],
    },
    {
      name: 'a hook with a source and no reason',
      reason: { type: 'hook', hookName: 'guard.sh', hookSource: 'projectSettings' },
      lines: kind => [`Hook guard.sh requires confirmation for this ${kind}. [projectSettings]`, HOOKS],
    },
    {
      name: 'a hook with a reason and a source',
      reason: { type: 'hook', hookName: 'guard.sh', reason: 'touches production', hookSource: 'policySettings' },
      lines: kind => [`Hook guard.sh requires confirmation for this ${kind}:`, 'touches production [policySettings]', HOOKS],
    },
    {
      name: 'a safety check shows its reason alone',
      reason: { type: 'safetyCheck', reason: 'This writes inside .git/', classifierApprovable: false },
      lines: () => ['This writes inside .git/'],
    },
    {
      name: 'another reason shows its text alone, line breaks kept',
      reason: { type: 'other', reason: 'First line\nsecond line' },
      lines: () => ['First line', 'second line'],
    },
    {
      name: 'a directory outside the workspace',
      reason: { type: 'workingDir', reason: 'Path is outside the allowed working directories' },
      lines: () => ['Path is outside the allowed working directories', RULES],
    },
  ]
  const silent: Array<[string, PermissionDecisionReason | undefined]> = [
    ['no reason', undefined],
    ['the permission mode', { type: 'mode', mode: 'default' }],
    ['subcommand results', { type: 'subcommandResults', reasons: new Map() }],
    ['a permission prompt tool', { type: 'permissionPromptTool', permissionPromptToolName: 'approver', toolResult: {} }],
    ['an async agent', { type: 'asyncAgent', reason: 'cannot prompt' }],
    ['a sandbox override', { type: 'sandboxOverride', reason: 'excludedCommand' }],
    ['a classifier, in a build without one', { type: 'classifier', classifier: 'bash', reason: 'unsure' }],
  ]

  async function explain(props: Partial<PermissionRuleExplanationProps> & { reason?: PermissionDecisionReason }, columns = 100, mode = 'default') {
    const result =
      'permissionResult' in props
        ? props.permissionResult!
        : ({ behavior: 'ask', message: 'asking', decisionReason: props.reason } as PermissionRuleExplanationProps['permissionResult'])
    const screen = await mount(
      <>
        <Text>ABOVE</Text>
        <PermissionRuleExplanation permissionResult={result} toolType={props.toolType ?? 'tool'} />
        <Text>BELOW</Text>
      </>,
      { columns, appState: { toolPermissionContext: { ...getDefaultAppState().toolPermissionContext, mode: mode as never } } },
    )
    return screen
  }

  for (const kind of ['tool', 'command', 'edit', 'read'] as const) {
    for (const row of rows) {
      test(
        `${row.name}, for a ${kind}: its lines, then a blank line`,
        async () => {
          const screen = await explain({ reason: row.reason, toolType: kind })
          expect(linesOf(screen.text())).toEqual(['ABOVE', ...row.lines(kind), '', 'BELOW'])
        },
        SLOW,
      )
    }
  }

  for (const [name, reason] of silent) {
    test(
      `nothing at all, not even a blank line, for ${name}`,
      async () => {
        const screen = await explain({ reason })
        expect(linesOf(screen.text())).toEqual(['ABOVE', 'BELOW'])
      },
      SLOW,
    )
  }

  test(
    'nothing for a missing permission result',
    async () => {
      const screen = await explain({ permissionResult: undefined as never })
      expect(linesOf(screen.text())).toEqual(['ABOVE', 'BELOW'])
    },
    SLOW,
  )

  test(
    'the rule and the hook name are bold, the hook source and the hint dim',
    async () => {
      const bold = await codesFor({ bold: true })
      const dim = await codesFor({ dimColor: true })
      const rule = await explain({ reason: ruleFrom('userSettings', 'Bash', 'npm test') })
      expect(styleBefore(rule.styled(), 'Bash(npm test)')).toBe(bold)
      expect(styleBefore(rule.styled(), RULES)).toBe(dim)
      expect(styleBefore(rule.styled(), 'Permission rule')).toBe('')
      await rule.close()
      const hook = await explain({ reason: { type: 'hook', hookName: 'guard.sh', hookSource: 'userSettings' } })
      expect(styleBefore(hook.styled(), 'guard.sh')).toBe(bold)
      // The source is dimmed with the plain SGR attribute, not the theme's dim colour.
      expect(styleBefore(hook.styled(), '[userSettings]')).toBe('\u001B[2m')
      expect(styleBefore(hook.styled(), HOOKS)).toBe(dim)
    },
    SLOW,
  )

  test(
    'in auto mode a hook\'s line is in the warning colour; in other modes, and for other reasons, it has none',
    async () => {
      const warning = await codesFor({ color: 'warning' })
      const hook: PermissionDecisionReason = { type: 'hook', hookName: 'guard.sh', reason: 'why' }
      const cases: Array<[string, PermissionDecisionReason, string, boolean]> = [
        ['auto', hook, 'Hook ', true],
        ['default', hook, 'Hook ', false],
        ['acceptEdits', hook, 'Hook ', false],
        ['auto', { type: 'other', reason: 'Something else' }, 'Something else', false],
      ]
      for (const [mode, reason, start, coloured] of cases) {
        const screen = await explain({ reason }, 100, mode)
        expect(styleBefore(screen.styled(), start)).toBe(coloured ? warning : '')
        await screen.close()
      }
    },
    SLOW,
  )

  for (const columns of [100, 40, 26]) {
    test(
      `at ${columns} columns the sentence wraps as one paragraph`,
      async () => {
        const screen = await explain({ reason: ruleFrom('localSettings', 'Bash', 'docker compose up:*'), toolType: 'command' }, columns)
        expect(flat(screen.text())).toBe(
          'ABOVE Permission rule Bash(docker compose up:*) requires confirmation for this command. /permissions to update rules BELOW',
        )
      },
      SLOW,
    )
  }
})
