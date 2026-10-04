/**
 * Characterization of the dialog shared by the tools that run a shell
 * command under the Bash rules: Wait (always) and Monitor (only in a build
 * with MONITOR_TOOL, which the shipped build has). Written before the
 * clean-base rewrite of permissions/toolDialogs; the spec is
 * docs/tech/rewrite/permissions/toolDialogs.md.
 *
 * Its "don't ask again" writes a Bash prefix rule, not a rule for the tool
 * itself, so each command shape is pinned to the exact rule it produces.
 *
 * `bun test` folds build flags to false, so under the plain runner the Wait
 * route is checked here and one more test runs this file again in a child
 * `bun test --feature=MONITOR_TOOL`, where every case runs for Monitor too.
 */
import { feature } from 'bun:bundle'
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Text } from 'src/terminal/ink.js'
import type { Tool } from 'src/tools/Tool.js'
import { WaitForTool } from 'src/tools/WaitForTool/WaitForTool.js'
import { flat, isolatedWorld, KEYS, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { allowed, allowRule, answer, ask, type Call, denied, managedRulesOnly, shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'

// Under `bun test` a flag check has to be the whole condition of a ternary.
const monitorBuilt: boolean = feature('MONITOR_TOOL') ? true : false

const world = isolatedWorld()
withTruecolor()
const { enter, esc, tab, down, up } = KEYS
const chars = (text: string) => [...text]
const optionLines = (frame: string) => shown(frame).filter(line => /^(❯ )?\d\./.test(line))

type Route = { label: string; tool: Tool; extra: Record<string, unknown> }
const routes: Route[] = [{ label: 'Wait', tool: WaitForTool as unknown as Tool, extra: { until: 'ready' } }]
// Loaded after the dialogs: with the flag on, importing the tool first closes an import cycle through the tool list.
if (monitorBuilt) {
  const { MonitorTool } = await import('src/tools/MonitorTool/MonitorTool.js')
  routes.push({ label: 'Monitor', tool: MonitorTool as unknown as Tool, extra: {} })
}

for (const route of routes) {
  const inputOf = (command: string | undefined, description?: string) => {
    const input: Record<string, unknown> = { ...route.extra }
    if (command !== undefined) input.command = command
    if (description !== undefined) input.description = description
    return input
  }
  const askShell = (input: Record<string, unknown>) => ask({ tool: route.tool, input, description: 'the request description, unused here' })

  describe(`MonitorPermissionRequest (${route.label}): what it shows`, () => {
    test(
      'the tool names the headline and the call; the input description follows; three options',
      async () => {
        const { screen } = await askShell(inputOf('tail -f build.log', 'watch the build'))
        expect(shown(screen.text())).toEqual([
          '─'.repeat(120),
          route.label,
          `${route.label}(tail -f build.log)`,
          'watch the build',
          'Do you want to proceed?',
          '❯ 1. Yes',
          `2. Yes, and don't ask again for ${route.label} commands in ${world().project}`,
          '3. No',
          'Esc to cancel · Tab to amend',
        ])
      },
      SLOW,
    )

    test(
      'no description in the input: no description line (the request description is not used)',
      async () => {
        const { screen } = await askShell(inputOf('tail -f build.log'))
        const lines = shown(screen.text())
        expect(lines.slice(2, 4)).toEqual([`${route.label}(tail -f build.log)`, 'Do you want to proceed?'])
        expect(screen.text()).not.toContain('unused here')
      },
      SLOW,
    )

    test(
      'no command in the input: empty parentheses',
      async () => {
        const { screen } = await askShell(inputOf(undefined, 'nothing to run'))
        expect(shown(screen.text())[2]).toBe(`${route.label}()`)
      },
      SLOW,
    )

    test(
      'styling: the description is dim; the tool and the directory in the always option are bold',
      async () => {
        const { screen } = await askShell(inputOf('tail -f build.log', 'watch the build'))
        const styled = screen.styled()
        const reference = async (props: React.ComponentProps<typeof Text>) => {
          const probe = await mount(<Text {...props}>SAMPLE</Text>)
          const codes = styleBefore(probe.styled(), 'SAMPLE')
          await probe.close()
          return codes
        }
        const bold = await reference({ bold: true })
        expect(styleBefore(styled, 'watch the build')).toBe(await reference({ dimColor: true }))
        const option = styled.slice(styled.indexOf('ask again for'))
        expect(styleBefore(option, route.label)).toBe(bold)
        expect(styleBefore(option, world().project)).toBe(bold)
      },
      SLOW,
    )

    test(
      'the worker badge joins the headline, and the reason the prompt asked is shown',
      async () => {
        const { screen } = await ask({
          tool: route.tool,
          input: inputOf('tail -f build.log'),
          workerBadge: { name: 'watcher', color: 'yellow' },
          permissionResult: { behavior: 'ask', message: 'asking', decisionReason: { type: 'other', reason: 'This command needs a yes' } },
        })
        expect(shown(screen.text())[1]).toBe(`${route.label} · @watcher`)
        expect(flat(screen.text())).toContain('This command needs a yes Do you want to proceed?')
      },
      SLOW,
    )

    test(
      'managed policy keeps rules to itself: only Yes and No',
      async () => {
        managedRulesOnly(world().home)
        const { screen } = await askShell(inputOf('tail -f build.log'))
        expect(optionLines(screen.text())).toEqual(['❯ 1. Yes', '2. No'])
      },
      SLOW,
    )
  })

  describe(`MonitorPermissionRequest (${route.label}): what each answer reports`, () => {
    const TAIL = inputOf('tail -f build.log')
    type Row = { name: string; keys: string[]; calls: Call[]; escapes?: number; managed?: boolean }
    const rows: Row[] = [
      { name: 'Enter on Yes: allow once', keys: [enter], calls: allowed(TAIL, [], undefined) },
      { name: 'Yes with a note', keys: [tab, ...chars(' for ten minutes '), enter], calls: allowed(TAIL, [], 'for ten minutes') },
      { name: '2: allow always, a Bash prefix rule on the first two words, saved locally', keys: ['2'], calls: allowed(TAIL, [allowRule('Bash', 'tail -f:*')]) },
      { name: 'Down, Enter: allow always', keys: [down, enter], calls: allowed(TAIL, [allowRule('Bash', 'tail -f:*')]) },
      { name: '3: deny with no note', keys: ['3'], calls: denied(undefined) },
      { name: 'Up from Yes wraps to No', keys: [up, enter], calls: denied(undefined) },
      { name: 'No with a note', keys: [down, down, tab, ...chars('tail the other log'), enter], calls: denied('tail the other log') },
      { name: 'Esc: deny with no arguments, one escape counted', keys: [esc], calls: denied(), escapes: 1 },
      { name: 'Esc with a Yes note written: still a deny', keys: [tab, ...chars('ok'), esc], calls: denied(), escapes: 1 },
      { name: 'y and n: nothing', keys: ['y', 'n'], calls: [] },
      { name: 'managed policy: 2 is No', keys: ['2'], calls: denied(undefined), managed: true },
    ]
    for (const row of rows) {
      test(
        row.name,
        async () => {
          if (row.managed) managedRulesOnly(world().home)
          const asked = await askShell(TAIL)
          expect(await answer(asked, row.keys)).toEqual(row.calls)
          expect(asked.screen.state().attribution.escapeCount).toBe(row.escapes ?? 0)
        },
        SLOW,
      )
    }

    // The rule each command shape produces. `null` means the answer allows once and saves nothing.
    const shapes: Array<[string, string | undefined, string | null]> = [
      ['one word: the whole program', 'make', 'make:*'],
      ['two words', 'npm test', 'npm test:*'],
      ['more than two words: the first two', 'tail -f build.log', 'tail -f:*'],
      ['a destructive command keeps its flags', 'rm -rf /tmp/scratch', 'rm -rf:*'],
      ['runs of spaces and edges are squeezed', '   npm    run   dev  ', 'npm run:*'],
      ['tabs and line breaks split words too', 'echo hi\nrm -rf /tmp/x', 'echo hi:*'],
      ['a compound command: only its first two words', 'cd /srv && make deploy', 'cd /srv:*'],
      ['an empty command', '', null],
      ['a blank command', '  \t ', null],
      ['no command at all', undefined, null],
    ]
    for (const [name, command, rule] of shapes) {
      test(
        `the always rule for ${name}`,
        async () => {
          const input = inputOf(command)
          const asked = await askShell(input)
          const updates = rule === null ? [] : [allowRule('Bash', rule)]
          expect(await answer(asked, ['2'])).toEqual(allowed(input, updates))
        },
        SLOW,
      )
    }
  })
}

describe('MonitorPermissionRequest (Wait): what the rule leaves out', () => {
  test(
    'the setup command is not part of the rule, only the polled command',
    async () => {
      const input = { setup: 'tmux send-keys -t build Enter', command: 'tmux capture-pane -p -t build', description: 'wait for the build' }
      const asked = await ask({ tool: WaitForTool as unknown as Tool, input })
      expect(shown(asked.screen.text())[2]).toBe('Wait(tmux capture-pane -p -t build)')
      expect(await answer(asked, ['2'])).toEqual(allowed(input, [allowRule('Bash', 'tmux capture-pane:*')]))
    },
    SLOW,
  )

  test(
    'the dialog counts one permission prompt',
    async () => {
      const asked = await ask({ tool: WaitForTool as unknown as Tool, input: { command: 'ls' } })
      await asked.screen.until(() => asked.screen.state().attribution.permissionPromptCount === 1, 'the prompt count')
    },
    SLOW,
  )
})

if (!monitorBuilt) {
  test('passes again with MONITOR_TOOL on, where Monitor gets this dialog too', async () => {
    const checkout = new URL('../../../../', import.meta.url).pathname
    const child = Bun.spawn([process.execPath, 'test', '--feature=MONITOR_TOOL', import.meta.path], {
      cwd: checkout,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const report = `${out}\n${err}`
    const passing = Number(report.match(/(\d+) pass/)?.[1] ?? 0)
    const failing = Number(report.match(/(\d+) fail/)?.[1] ?? -1)
    if (code !== 0 || failing !== 0) throw new Error(`the MONITOR_TOOL run failed (exit ${code}):\n${report}`)
    // Every case runs once per route, so the flagged run has more than twice the Monitor-less count.
    expect(passing).toBeGreaterThan(50)
  }, 300_000)
}
