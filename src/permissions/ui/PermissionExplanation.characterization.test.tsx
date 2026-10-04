/**
 * The ctrl+e explanation panel of the shell permission dialogs.
 *
 * A small host plays the part of the dialog: it calls the hook, prints the
 * state it gets back, and renders the panel. Keys go through the real key
 * bindings. The one boundary replaced is the model call (`sideQuery`), held
 * open by each test until it chooses to answer.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const realSideQueryModule = { ...(await import('src/agent/sideQuery.js')) }
type Ask = Parameters<typeof realSideQueryModule.sideQuery>[0]

const asked: Ask[] = []
let answer: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | null = null
mock.module('src/agent/sideQuery.js', () => ({
  ...realSideQueryModule,
  sideQuery: (ask: Ask) => {
    asked.push(ask)
    return new Promise((resolve, reject) => {
      answer = { resolve, reject }
    })
  },
}))
afterAll(() => {
  mock.module('src/agent/sideQuery.js', () => realSideQueryModule)
})

const React = await import('react')
const { Box, Text } = await import('src/terminal/ink.js')
const { PermissionExplainerContent, usePermissionExplainerUI } = await import('src/permissions/ui/PermissionExplanation.js')
const { resetGlobalConfigForTests, saveGlobalConfig } = await import('src/platform/config/config.js')
const { createAssistantMessage } = await import('src/agent/messages/factories.js')
const rig = await import('src/permissions/ui/__testutils__/promptFrameRig.js')

type Explanation = import('src/permissions/permissionExplainer.js').PermissionExplanation
type HostProps = Parameters<typeof usePermissionExplainerUI>[0]

const CTRL_E = '\x05'
const LOADING = 'Loading explanation…'

rig.isolatedWorld()
rig.withTruecolor()

beforeEach(() => {
  asked.length = 0
  answer = null
})
afterEach(() => {
  saveGlobalConfig(config => ({ ...config, permissionExplainerEnabled: undefined }))
  resetGlobalConfigForTests()
})

function Host(props: HostProps) {
  const state = usePermissionExplainerUI(props)
  return (
    <Box flexDirection="column">
      <Text>{`state enabled=${state.enabled} visible=${state.visible} fetched=${state.promise ? 'yes' : 'no'}`}</Text>
      <PermissionExplainerContent visible={state.visible} promise={state.promise} />
      <Text>end of host</Text>
    </Box>
  )
}

const HOST_PROPS: HostProps = {
  toolName: 'Bash',
  toolInput: { command: 'git push --force origin main' },
  toolDescription: 'Force-push main',
  messages: [createAssistantMessage({ content: 'I am publishing the rebased branch.' })],
}

const stateLine = (frame: string) => rig.linesOf(frame).find(line => line.startsWith('state '))

/** The lines the panel adds between the state line and the host's last line. */
function panelOf(frame: string): string[] {
  const lines = rig.linesOf(frame)
  const from = lines.findIndex(line => line.startsWith('state '))
  const to = lines.indexOf('end of host')
  return lines.slice(from + 1, to)
}

const toolReply = (input: Partial<Explanation>) => ({
  id: 'msg_x',
  type: 'message',
  role: 'assistant',
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_x', name: 'explain_command', input }],
})

const EXPLAINED: Explanation = {
  riskLevel: 'HIGH',
  explanation: 'Overwrites the remote main branch.',
  reasoning: 'I need the remote to match my rebase.',
  risk: 'Teammates lose pushed commits',
}

async function waitForAsk(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!answer) {
    if (Date.now() > deadline) throw new Error('the model was never asked')
    await Bun.sleep(10)
  }
}

/** The SGR codes Ink paints for a reference element, for comparing colours. */
async function codesOf(node: React.ReactNode, marker: string): Promise<string> {
  const screen = await rig.mount(node)
  await screen.until(frame => frame.includes(marker), marker)
  const codes = rig.styleBefore(screen.styled(), marker)
  await screen.close()
  return codes
}

describe('the hook', () => {
  test('starts hidden and asks nothing until ctrl+e', async () => {
    const screen = await rig.mount(<Host {...HOST_PROPS} />)
    expect(stateLine(screen.text())).toBe('state enabled=true visible=false fetched=no')
    expect(panelOf(screen.text())).toEqual([])
    await Bun.sleep(100)
    expect(asked).toHaveLength(0)
  }, rig.SLOW)

  test('ctrl+e shows the panel, asks once with the dialog props, and loads', async () => {
    const screen = await rig.mount(<Host {...HOST_PROPS} />)
    await screen.press(CTRL_E)
    const frame = await screen.until(f => f.includes(LOADING), 'the loading line')
    expect(stateLine(frame)).toBe('state enabled=true visible=true fetched=yes')
    expect(panelOf(frame).filter(Boolean)).toEqual([LOADING])
    await waitForAsk()
    expect(asked).toHaveLength(1)
    const prompt = asked[0]!.messages[0]!.content as string
    for (const fact of ['Tool: Bash', 'Description: Force-push main', '"command": "git push --force origin main"', 'I am publishing the rebased branch.']) {
      expect(prompt).toContain(fact)
    }
    expect(asked[0]!.signal?.aborted).toBe(false)
  }, rig.SLOW)

  test('the answer replaces the loading line: explanation, reasoning, then the risk line', async () => {
    const screen = await rig.mount(<Host {...HOST_PROPS} />)
    await screen.press(CTRL_E)
    await waitForAsk()
    answer!.resolve(toolReply(EXPLAINED))
    const frame = await screen.until(f => f.includes('High risk'), 'the risk line')
    expect(frame).not.toContain(LOADING)
    expect(panelOf(frame)).toEqual([
      '',
      'Overwrites the remote main branch.',
      '',
      'I need the remote to match my rebase.',
      '',
      'High risk: Teammates lose pushed commits',
    ])
  }, rig.SLOW)

  test('ctrl+e again hides it, and a third press shows the same answer without asking again', async () => {
    const screen = await rig.mount(<Host {...HOST_PROPS} />)
    await screen.press(CTRL_E)
    await waitForAsk()
    answer!.resolve(toolReply(EXPLAINED))
    await screen.until(f => f.includes('High risk'), 'the risk line')

    await screen.press(CTRL_E)
    let frame = await screen.until(f => !f.includes('High risk'), 'the panel to close')
    expect(stateLine(frame)).toBe('state enabled=true visible=false fetched=yes')
    expect(panelOf(frame)).toEqual([])

    await screen.press(CTRL_E)
    frame = await screen.until(f => f.includes('High risk'), 'the panel to reopen')
    expect(stateLine(frame)).toBe('state enabled=true visible=true fetched=yes')
    expect(asked).toHaveLength(1)
  }, rig.SLOW)

  test('hiding before the answer lands still asks only once', async () => {
    const screen = await rig.mount(<Host {...HOST_PROPS} />)
    await screen.press(CTRL_E)
    await waitForAsk()
    await screen.press(CTRL_E)
    await screen.until(f => !f.includes(LOADING), 'the panel to close')
    answer!.resolve(toolReply({ ...EXPLAINED, riskLevel: 'LOW' }))
    await screen.press(CTRL_E)
    await screen.until(f => f.includes('Low risk'), 'the answer')
    expect(asked).toHaveLength(1)
  }, rig.SLOW)

  test('turned off in config: enabled is false and ctrl+e does nothing', async () => {
    saveGlobalConfig(config => ({ ...config, permissionExplainerEnabled: false }))
    const screen = await rig.mount(<Host {...HOST_PROPS} />)
    expect(stateLine(screen.text())).toBe('state enabled=false visible=false fetched=no')
    await screen.press(CTRL_E)
    await Bun.sleep(100)
    expect(stateLine(screen.text())).toBe('state enabled=false visible=false fetched=no')
    expect(asked).toHaveLength(0)
  }, rig.SLOW)
})

describe('the answer panel', () => {
  const levels: Array<[Explanation['riskLevel'], string, 'success' | 'warning' | 'error']> = [
    ['LOW', 'Low risk', 'success'],
    ['MEDIUM', 'Med risk', 'warning'],
    ['HIGH', 'High risk', 'error'],
  ]
  for (const [level, label, colour] of levels) {
    test(`${level} reads "${label}:" in the ${colour} colour, and the risk text stays plain`, async () => {
      const expected = await codesOf(<Text color={colour}>colour-probe</Text>, 'colour-probe')
      const plain = await codesOf(<Text>plain-probe</Text>, 'plain-probe')
      const screen = await rig.mount(<Host {...HOST_PROPS} />)
      await screen.press(CTRL_E)
      await waitForAsk()
      answer!.resolve(toolReply({ ...EXPLAINED, riskLevel: level, risk: 'risk-words' }))
      await screen.until(f => f.includes(label), label)
      expect(panelOf(screen.text()).at(-1)).toBe(`${label}: risk-words`)
      expect(rig.styleBefore(screen.styled(), label)).toBe(expected)
      expect(rig.styleBefore(screen.styled(), 'risk-words')).toBe(plain)
    }, rig.SLOW)
  }

  const unavailable: Array<[string, (settle: NonNullable<typeof answer>) => void]> = [
    ['an unusable answer', settle => settle.resolve(toolReply({ riskLevel: 'SEVERE' as never }))],
    ['a failed call', settle => settle.reject(new Error('offline'))],
  ]
  for (const [label, settle] of unavailable) {
    test(`${label} shows a dimmed "Explanation unavailable"`, async () => {
      const dim = await codesOf(<Text dimColor>dim-probe</Text>, 'dim-probe')
      const screen = await rig.mount(<Host {...HOST_PROPS} />)
      await screen.press(CTRL_E)
      await waitForAsk()
      settle(answer!)
      const frame = await screen.until(f => f.includes('Explanation unavailable'), 'the fallback')
      expect(panelOf(frame)).toEqual(['', 'Explanation unavailable'])
      expect(rig.styleBefore(screen.styled(), 'Explanation unavailable')).toBe(dim)
    }, rig.SLOW)
  }
})

describe('the panel on its own', () => {
  const settled = Promise.resolve<Explanation | null>({ ...EXPLAINED, riskLevel: 'MEDIUM' })
  const shown: Array<[string, boolean, Promise<Explanation | null> | null, boolean]> = [
    ['hidden with an answer', false, settled, false],
    ['visible without a request', true, null, false],
    ['hidden without a request', false, null, false],
    ['visible with an answer', true, settled, true],
  ]
  for (const [label, visible, promise, paints] of shown) {
    test(`${label}: ${paints ? 'paints' : 'paints nothing'}`, async () => {
      const screen = await rig.mount(
        <Box flexDirection="column">
          <Text>state alone</Text>
          <PermissionExplainerContent visible={visible} promise={promise} />
          <Text>end of host</Text>
        </Box>,
      )
      if (paints) await screen.until(f => f.includes('Med risk'), 'the answer')
      else await Bun.sleep(150)
      const panel = panelOf(screen.text())
      if (paints) expect(panel.at(-1)).toBe('Med risk: Teammates lose pushed commits')
      else expect(panel).toEqual([])
    }, rig.SLOW)
  }
})
