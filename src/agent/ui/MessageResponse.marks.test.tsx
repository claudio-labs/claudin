import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { buildMessageLookups, CANCEL_MESSAGE, REJECT_MESSAGE } from 'src/agent/messages/messages.js'
import { MessageResponse, ToolResultBody } from 'src/agent/ui/MessageResponse.js'
import { HookProgressMessage } from 'src/agent/ui/messages/HookProgressMessage.js'
import { UserToolResultMessage } from 'src/agent/ui/messages/UserToolResultMessage/UserToolResultMessage.js'
import { UserToolSuccessMessage } from 'src/agent/ui/messages/UserToolResultMessage/UserToolSuccessMessage.js'
import type { NormalizedUserMessage } from 'src/shared/types/message.js'
import { Box, createRoot, Text } from 'src/terminal/ink.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import BashToolResultMessage from 'src/tools/BashTool/BashToolResultMessage.js'
import { BackgroundHint } from 'src/tools/BashTool/UI.js'
import { renderToolResultMessage as renderPowerShellResult } from 'src/tools/PowerShellTool/UI.js'
import type { Tool, Tools } from 'src/tools/Tool.js'

// Inside a tool row the ⎿ marks only the secondary lines around the result
// (a timeout, a command running in the background, a hook); the result itself
// keeps the gutter's four columns with no mark.

async function render(node: React.ReactNode): Promise<string> {
  return stripAnsi(await renderToString(<AppStateProvider>{node}</AppStateProvider>, 100))
}

const lines = (out: string) => out.split('\n').filter(line => line.trim() !== '')

describe('MessageResponse marks', () => {
  test('outside a tool result the line keeps its ⎿', async () => {
    expect(lines(await render(<MessageResponse><Text>Loaded rules</Text></MessageResponse>))).toEqual(['  ⎿ Loaded rules'])
  })

  test('inside a tool result the line drops the ⎿ and keeps its column', async () => {
    const out = await render(<ToolResultBody><MessageResponse><Text>Read 12 lines</Text></MessageResponse></ToolResultBody>)
    expect(lines(out)).toEqual(['    Read 12 lines'])
  })

  test('a marked line keeps the ⎿ inside a tool result', async () => {
    const out = await render(<ToolResultBody><MessageResponse mark><Text>(timeout 10m)</Text></MessageResponse></ToolResultBody>)
    expect(lines(out)).toEqual(['  ⎿ (timeout 10m)'])
  })
})

describe('a Bash result marks only its timeout and background lines', () => {
  test('the output has no ⎿ and the timeout line has the only one', async () => {
    const out = lines(await render(
      <ToolResultBody>
        <BashToolResultMessage content={{ stdout: 'probe baseline is green', stderr: '' }} verbose={false} timeoutMs={600_000} />
      </ToolResultBody>,
    ))
    expect(out.filter(line => line.includes('⎿'))).toHaveLength(1)
    expect(out.find(line => line.includes('⎿'))).toContain('timeout 10m')
    expect(out.find(line => line.includes('baseline'))).not.toContain('⎿')
  })

  test('a command running in the background keeps its ⎿', async () => {
    const out = await render(
      <ToolResultBody>
        <BashToolResultMessage content={{ stdout: '', stderr: '', backgroundTaskId: 'b1' }} verbose={false} />
      </ToolResultBody>,
    )
    expect(out).toContain('⎿ Running in the background')
  })

  test('a finished command with no output has no ⎿', async () => {
    const out = await render(
      <ToolResultBody>
        <BashToolResultMessage content={{ stdout: '', stderr: '' }} verbose={false} />
      </ToolResultBody>,
    )
    expect(out).toContain('(No output)')
    expect(out).not.toContain('⎿')
  })
})

test("UserToolSuccessMessage renders the tool's result as a tool result body", async () => {
  const tool = {
    name: 'Fake',
    userFacingName: () => 'Fake',
    renderToolResultMessage: () => <MessageResponse><Text>result line</Text></MessageResponse>,
  } as unknown as Tool
  const message = {
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    toolUseResult: { ok: true },
  } as unknown as NormalizedUserMessage
  const out = await render(
    <UserToolSuccessMessage
      message={message}
      lookups={buildMessageLookups([], [])}
      toolUseID="t1"
      progressMessagesForMessage={[]}
      tool={tool}
      tools={[tool] as Tools}
      verbose={false}
      width={96}
    />,
  )
  expect(lines(out)).toEqual(['    result line'])
})

test('the ctrl+b hint lines up under the Running line', async () => {
  const out = lines(await render(
    <Box flexDirection="column">
      <MessageResponse><Text>Running… (3m 18s · timeout 10m)</Text></MessageResponse>
      <BackgroundHint />
    </Box>,
  ))
  expect(out[1]!.indexOf('(ctrl+b')).toBe(out[0]!.indexOf('Running'))
})

test('a hook line keeps its ⎿ even inside a tool result', async () => {
  const lookups = {
    ...buildMessageLookups([], []),
    inProgressHookCounts: new Map([['t1', new Map([['PostToolUse' as const, 1]])]]),
  }
  const out = await render(
    <ToolResultBody>
      <HookProgressMessage hookEvent="PostToolUse" lookups={lookups} toolUseID="t1" verbose={false} isTranscriptMode />
    </ToolResultBody>,
  )
  expect(out).toContain('⎿ 1 PostToolUse hook ran')
})

describe('every branch of a tool result is a result body', () => {
  const tool = { name: 'Fake', userFacingName: () => 'Fake' } as unknown as Tool
  const lookups = {
    ...buildMessageLookups([], []),
    toolUseByToolUseID: new Map([['t1', { type: 'tool_use', id: 't1', name: 'Fake', input: {} }]]),
  } as unknown as ReturnType<typeof buildMessageLookups>
  const renderResult = (param: Partial<React.ComponentProps<typeof UserToolResultMessage>['param']>) =>
    render(
      <UserToolResultMessage
        param={{ type: 'tool_result', tool_use_id: 't1', ...param }}
        message={{ type: 'user', uuid: 'u1', message: { role: 'user', content: [] } } as unknown as NormalizedUserMessage}
        lookups={lookups}
        progressMessagesForMessage={[]}
        tools={[tool] as Tools}
        verbose={false}
        width={96}
      />,
    )

  test('an interrupted tool result has no ⎿', async () => {
    const out = await renderResult({ content: CANCEL_MESSAGE })
    expect(out).toContain('Interrupted')
    expect(out).not.toContain('⎿')
  })

  test('a rejected tool result has no ⎿', async () => {
    const out = await renderResult({ content: REJECT_MESSAGE })
    expect(out).toContain('What should Claude do instead?')
    expect(out).not.toContain('⎿')
  })

  test('an errored tool result has no ⎿', async () => {
    const out = await renderResult({ content: 'Error: the disk is full', is_error: true })
    expect(out).toContain('the disk is full')
    expect(out).not.toContain('⎿')
  })
})

describe('a PowerShell result marks only its timeout and background lines', () => {
  const renderPs = (content: Partial<Parameters<typeof renderPowerShellResult>[0]>, timeoutMs?: number) =>
    render(
      <ToolResultBody>
        {renderPowerShellResult(
          { stdout: '', stderr: '', interrupted: false, ...content } as Parameters<typeof renderPowerShellResult>[0],
          (timeoutMs ? [{ data: { timeoutMs } }] : []) as unknown as Parameters<typeof renderPowerShellResult>[1],
          { verbose: false, theme: 'dark', tools: [] },
        )}
      </ToolResultBody>,
    )

  test('a command running in the background keeps its ⎿', async () => {
    expect(await renderPs({ backgroundTaskId: 'b1' })).toContain('⎿ Running in the background')
  })

  test('the timeout line keeps its ⎿, the output has none', async () => {
    const out = lines(await renderPs({ stdout: 'Directory: C:\\repo' }, 600_000))
    expect(out.filter(line => line.includes('⎿'))).toHaveLength(1)
    expect(out.find(line => line.includes('⎿'))).toContain('timeout 10m')
  })

  test('a finished command with no output has no ⎿', async () => {
    const out = await renderPs({})
    expect(out).toContain('(No output)')
    expect(out).not.toContain('⎿')
  })
})

// A mounted line whose mark flips while its children stay the same element
// must repaint the gutter: the row is memoized on its children.
describe('a mounted line follows its mark', () => {
  function streams() {
    let output = ''
    const stdout = new PassThrough()
    const stdin = new PassThrough() as PassThrough & Record<string, unknown>
    stdin.isTTY = true
    stdin.setRawMode = () => {}
    stdin.ref = () => {}
    stdin.unref = () => {}
    ;(stdout as unknown as { columns: number; rows: number }).columns = 80
    ;(stdout as unknown as { columns: number; rows: number }).rows = 24
    stdout.on('data', chunk => {
      output += chunk.toString()
    })
    return { stdout, stdin, out: () => output }
  }

  async function renderTwice(first: React.ReactNode, second: React.ReactNode): Promise<string> {
    const { stdout, stdin, out } = streams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })
    try {
      root.render(first)
      await Bun.sleep(100)
      const before = out().length
      root.render(second)
      await Bun.sleep(100)
      return stripAnsi(out().slice(before))
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    }
  }

  const tree = (mark: boolean, child: React.ReactNode) => (
    <ToolResultBody>
      <MessageResponse height={1} mark={mark}>
        {child}
      </MessageResponse>
    </ToolResultBody>
  )

  test('with new children each render', async () => {
    expect(await renderTwice(tree(false, <Text>(timeout 10m)</Text>), tree(true, <Text>(timeout 10m)</Text>))).toContain('⎿')
  })

  test('with the same children element', async () => {
    const child = <Text>(timeout 10m)</Text>
    expect(await renderTwice(tree(false, child), tree(true, child))).toContain('⎿')
  })
})
