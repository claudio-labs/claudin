/**
 * The parts of permissions/promptFrame that only exist in the shipped build:
 * the Monitor tool's own dialog (MONITOR_TOOL) and the explanation of a
 * classifier's ask (TRANSCRIPT_CLASSIFIER or BASH_CLASSIFIER).
 *
 * `bun test` folds every build flag to false. Under the plain runner this
 * file registers one test, which runs the file again in a child `bun test`
 * with the shipped flags on and fails with the child's output when anything
 * in it fails.
 */
import { feature } from 'bun:bundle'
import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import * as React from 'react'

// A flag check must be the whole condition of a ternary under `bun test`.
const shippedFlags: boolean = feature('MONITOR_TOOL') ? true : false
const FLAGS = ['MONITOR_TOOL', 'TRANSCRIPT_CLASSIFIER', 'BASH_CLASSIFIER']

if (!shippedFlags) {
  test('passes again with the shipped build flags on', async () => {
    const checkout = join(dirname(import.meta.path), '..', '..', '..')
    const child = Bun.spawn([process.execPath, 'test', ...FLAGS.map(flag => `--feature=${flag}`), import.meta.path], {
      cwd: checkout,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const output = `${out}\n${err}`
    const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? '0')
    const failed = Number(/(\d+) fail/.exec(output)?.[1] ?? '1')
    if (exit !== 0 || failed !== 0 || passed === 0) throw new Error(`the flagged run did not pass (exit ${exit}):\n${output}`)
    expect(passed).toBeGreaterThan(0)
  }, 180_000)
} else {
  await flaggedSuite()
}

async function flaggedSuite(): Promise<void> {
  const { z } = await import('zod/v4')
  const { createAssistantMessage } = await import('src/agent/messages/factories.js')
  const { PermissionRequest } = await import('src/permissions/ui/PermissionRequest.js')
  const { PermissionRuleExplanation } = await import('src/permissions/ui/PermissionRuleExplanation.js')
  const { MonitorTool } = await import('src/tools/MonitorTool/MonitorTool.js')
  const { Text } = await import('src/terminal/ink.js')
  const { getDefaultAppState } = await import('src/terminal/state/AppStateStore.js')
  const rig = await import('src/permissions/ui/__testutils__/promptFrameRig.js')
  type Tool = import('src/tools/Tool.js').Tool
  type ToolUseConfirm = import('src/permissions/ui/PermissionRequest.js').ToolUseConfirm
  type Reason = import('src/permissions/PermissionResult.js').PermissionDecisionReason

  rig.isolatedWorld()
  rig.withTruecolor()

  function confirmFor(tool: Tool, input: Record<string, unknown>): ToolUseConfirm {
    return {
      assistantMessage: createAssistantMessage({ content: 'working' }),
      tool,
      description: 'watch the build log',
      input,
      toolUseContext: { options: { tools: [] }, getAppState: () => ({}), setAppState: () => {} } as never,
      toolUseID: 'toolu_shipped',
      permissionResult: { behavior: 'ask', message: 'asking' },
      permissionPromptStartTimeMs: Date.now(),
      onUserInteraction: () => {},
      onAbort: () => {},
      onAllow: () => {},
      onReject: () => {},
      recheckPermission: async () => {},
    } as unknown as ToolUseConfirm
  }

  describe('shipped build: routing', () => {
    test(
      'Monitor gets its own dialog, named after the tool, instead of the tool-wide one',
      async () => {
        const confirm = confirmFor(MonitorTool as Tool, { command: 'tail -f build.log', description: 'watch the build log' })
        const screen = await rig.mount(
          <PermissionRequest toolUseConfirm={confirm} toolUseContext={confirm.toolUseContext} onDone={() => {}} onReject={() => {}} verbose={false} workerBadge={undefined} />,
        )
        const lines = rig.linesOf(screen.text()).map(line => line.trim()).filter(line => line !== '')
        expect(lines[0]).toMatch(/^─+$/)
        expect(lines[1]).toBe('Monitor')
      },
      rig.SLOW,
    )

    test(
      'a tool without a dialog of its own still gets the tool-wide one',
      async () => {
        const plain = {
          name: 'mcp__logs__tail',
          isMcp: true,
          inputSchema: z.object({}),
          userFacingName: () => 'logs - tail (MCP)',
          renderToolUseMessage: () => 'tail',
          isReadOnly: () => true,
        } as unknown as Tool
        const confirm = confirmFor(plain, {})
        const screen = await rig.mount(
          <PermissionRequest toolUseConfirm={confirm} toolUseContext={confirm.toolUseContext} onDone={() => {}} onReject={() => {}} verbose={false} workerBadge={undefined} />,
        )
        expect(screen.text()).toContain('Tool use')
      },
      rig.SLOW,
    )
  })

  describe('shipped build: a classifier\'s ask', () => {
    async function explain(reason: Reason, toolType: 'tool' | 'command' | 'edit' | 'read') {
      return rig.mount(
        <>
          <Text>ABOVE</Text>
          <PermissionRuleExplanation permissionResult={{ behavior: 'ask', message: 'asking', decisionReason: reason }} toolType={toolType} />
          <Text>BELOW</Text>
        </>,
        { columns: 100, appState: { toolPermissionContext: { ...getDefaultAppState().toolPermissionContext } } },
      )
    }
    async function codesFor(style: React.ComponentProps<typeof Text>): Promise<string> {
      const screen = await rig.mount(<Text {...style}>REFERENCE</Text>)
      const codes = rig.styleBefore(screen.styled(), 'REFERENCE')
      await screen.close()
      return codes
    }

    for (const toolType of ['tool', 'command'] as const) {
      test(
        `the auto-mode classifier, for a ${toolType}: its sentence and reason, in the error colour, with no hint`,
        async () => {
          const screen = await explain({ type: 'classifier', classifier: 'auto-mode', reason: 'Pushes to a protected branch' }, toolType)
          expect(rig.linesOf(screen.text())).toEqual([
            'ABOVE',
            `Auto mode classifier requires confirmation for this ${toolType}.`,
            'Pushes to a protected branch',
            '',
            'BELOW',
          ])
          expect(rig.styleBefore(screen.styled(), 'Auto mode')).toBe(await codesFor({ color: 'error' }))
        },
        rig.SLOW,
      )

      test(
        `another classifier, for a ${toolType}: named in bold, then its reason, uncoloured, with no hint`,
        async () => {
          const screen = await explain({ type: 'classifier', classifier: 'bash-prompt', reason: 'Matches "deploys"' }, toolType)
          expect(rig.linesOf(screen.text())).toEqual([
            'ABOVE',
            `Classifier bash-prompt requires confirmation for this ${toolType}.`,
            'Matches "deploys"',
            '',
            'BELOW',
          ])
          expect(rig.styleBefore(screen.styled(), 'Classifier ')).toBe('')
          expect(rig.styleBefore(screen.styled(), 'bash-prompt')).toBe(await codesFor({ bold: true }))
        },
        rig.SLOW,
      )
    }
  })
}
