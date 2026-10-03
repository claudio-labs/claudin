/**
 * Characterization of `useSSHSession`: the REPL's side of a session that runs
 * on another machine over ssh.
 *
 * The session object is the input. In the product it wraps an ssh child
 * process and a local auth proxy, made before the REPL mounts; that module is
 * not in this fork. Here it is a scripted stand-in that records what the hook
 * asks of it and lets the test fire the callbacks the hook registers. The
 * other boundary is process exit: `gracefulShutdown` is recorded instead of
 * ending the test runner.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as shutdown from 'src/shared/proc/gracefulShutdown.js'
import { useSSHSession } from 'src/sessions/hooks/useSSHSession.js'
import { cell, type Cell, mountHook, type HookUnderTest, unmountAll } from 'src/sessions/__testutils__/remoteRig.js'
import { frames, localTool } from 'src/sessions/__testutils__/remoteSessionHost.js'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import type { Message } from 'src/shared/types/message.js'
import type { Tool } from 'src/tools/Tool.js'

// --- process exit -----------------------------------------------------------

const realShutdown = { ...shutdown }
const exits: unknown[][] = []
mock.module('src/shared/proc/gracefulShutdown.js', () => ({
  ...realShutdown,
  gracefulShutdown: async (...args: unknown[]) => {
    exits.push(args)
  },
}))

afterAll(() => {
  mock.module('src/shared/proc/gracefulShutdown.js', () => realShutdown)
})

// --- the ssh session stand-in -----------------------------------------------

type Callbacks = {
  onMessage: (message: unknown) => void
  onPermissionRequest: (request: unknown, requestId: string) => void
  onConnected: () => void
  onReconnecting: (attempt: number, max: number) => void
  onDisconnected: () => void
  onError: (error: Error) => void
}

type Ssh = {
  session: any
  /** The callbacks of the latest manager the hook made. */
  fire: () => Callbacks
  log: string[]
  sent: unknown[]
  answers: Array<[string, unknown]>
  sendResult: boolean
  stderr: string
  exit: { exitCode: number | null; signalCode: string | null }
}

function sshSession(): Ssh {
  let callbacks: Callbacks | undefined
  const ssh: Ssh = {
    session: undefined,
    fire: () => {
      if (!callbacks) throw new Error('no manager yet')
      return callbacks
    },
    log: [],
    sent: [],
    answers: [],
    sendResult: true,
    stderr: '',
    exit: { exitCode: null, signalCode: null },
  }
  ssh.session = {
    createManager: (given: Callbacks) => {
      callbacks = given
      ssh.log.push('create')
      return {
        connect: () => ssh.log.push('connect'),
        disconnect: () => ssh.log.push('disconnect'),
        sendInterrupt: () => ssh.log.push('interrupt'),
        sendMessage: async (content: unknown) => {
          ssh.sent.push(content)
          return ssh.sendResult
        },
        respondToPermissionRequest: (requestId: string, answer: unknown) => {
          ssh.answers.push([requestId, answer])
        },
      }
    },
    getStderrTail: () => ssh.stderr,
    get proc() {
      return ssh.exit
    },
    proxy: { stop: () => ssh.log.push('proxy stopped') },
  }
  return ssh
}

// --- mounting ---------------------------------------------------------------

type Props = Parameters<typeof useSSHSession>[0]
type Host = {
  hook: HookUnderTest<Props, ReturnType<typeof useSSHSession>>
  props: Props
  messages: Cell<Message[]>
  loading: Cell<boolean | undefined>
  queue: Cell<ToolUseConfirm[]>
}

async function mountSsh(ssh: Ssh | undefined, tools: Tool[] = []): Promise<Host> {
  const messages = cell<Message[]>([])
  const loading = cell<boolean | undefined>(undefined)
  const queue = cell<ToolUseConfirm[]>([])
  const props: Props = {
    session: ssh?.session,
    setMessages: messages.set,
    setIsLoading: loading.set,
    setToolUseConfirmQueue: queue.set,
    tools,
  }
  const hook = await mountHook(useSSHSession, props)
  return { hook, props, messages, loading, queue }
}

beforeEach(() => {
  exits.length = 0
})

afterEach(() => {
  unmountAll()
})

const contents = (host: Host) => host.messages.value().map(m => m as Record<string, any>)

describe('without a session', () => {
  test('it is not remote, sends nothing, and cancelling only stops loading', async () => {
    const host = await mountSsh(undefined)
    const hook = host.hook.current()
    expect(hook.isRemoteMode).toBe(false)
    expect(await hook.sendMessage('hi')).toBe(false)
    expect(host.loading.history).toEqual([undefined])
    hook.cancelRequest()
    hook.disconnect()
    expect(host.loading.value()).toBe(false)
  })
})

describe('the session', () => {
  test('one manager is made and connected when the hook mounts', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    expect(host.hook.current().isRemoteMode).toBe(true)
    expect(ssh.log).toEqual(['create', 'connect'])
  })

  test('the result is the same object across renders with the same props', async () => {
    const host = await mountSsh(sshSession())
    const first = host.hook.current()
    await host.hook.rerender({ ...host.props })
    expect(host.hook.current()).toBe(first)
  })

  test('unmounting disconnects the manager and stops the auth proxy', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    host.hook.unmount()
    expect(ssh.log).toEqual(['create', 'connect', 'disconnect', 'proxy stopped'])
  })

  test('a new session replaces the old one, which is disconnected and its proxy stopped', async () => {
    const first = sshSession()
    const host = await mountSsh(first)
    first.fire().onMessage(frames.init(['/a']))
    const second = sshSession()
    await host.hook.rerender({ ...host.props, session: second.session })
    expect(first.log).toEqual(['create', 'connect', 'disconnect', 'proxy stopped'])
    expect(second.log).toEqual(['create', 'connect'])
    second.fire().onMessage(frames.init(['/b']))
    expect(contents(host).filter(m => m.type === 'system')).toHaveLength(2)
  })

  test('sending passes the content to the session and turns loading on', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    expect(await host.hook.current().sendMessage('ls -la')).toBe(true)
    expect(ssh.sent).toEqual(['ls -la'])
    expect(host.loading.value()).toBe(true)
    ssh.sendResult = false
    expect(await host.hook.current().sendMessage([{ type: 'text', text: 'again' }])).toBe(false)
    expect(ssh.sent).toHaveLength(2)
  })

  test('cancelling interrupts the remote turn and stops loading', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    host.loading.set(true)
    host.hook.current().cancelRequest()
    expect(ssh.log.at(-1)).toBe('interrupt')
    expect(host.loading.value()).toBe(false)
  })

  test('after disconnect nothing is sent or interrupted, and the proxy is left to unmount', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    host.hook.current().disconnect()
    expect(await host.hook.current().sendMessage('late')).toBe(false)
    host.hook.current().cancelRequest()
    expect(ssh.sent).toEqual([])
    expect(ssh.log).toEqual(['create', 'connect', 'disconnect'])
  })
})

describe('messages from the session', () => {
  test('the first init is shown, the ones repeated each turn are not', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    ssh.fire().onMessage(frames.init(['/x'], 'claude-ssh-model'))
    ssh.fire().onMessage(frames.init(['/x'], 'claude-ssh-model'))
    expect(contents(host)).toHaveLength(1)
    expect(contents(host)[0]!.content).toContain('claude-ssh-model')
  })

  test('assistant messages and tool results are shown; typed user messages are not', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    ssh.fire().onMessage(frames.assistant([{ type: 'text', text: 'checking' }]))
    ssh.fire().onMessage(frames.user('typed locally already'))
    ssh.fire().onMessage(frames.toolResult('toolu_1'))
    expect(contents(host).map(m => m.type)).toEqual(['assistant', 'user'])
    expect(contents(host)[1]!.message.content[0].type).toBe('tool_result')
  })

  test('a result ends loading; only an error result is shown', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    host.loading.set(true)
    ssh.fire().onMessage(frames.result('success'))
    expect(host.loading.value()).toBe(false)
    expect(contents(host)).toHaveLength(0)
    host.loading.set(true)
    ssh.fire().onMessage(frames.result('error_during_execution', ['remote crashed']))
    expect(host.loading.value()).toBe(false)
    expect(contents(host)[0]!.content).toBe('remote crashed')
  })

  test('an error from the manager shows nothing', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    ssh.fire().onError(new Error('pipe broke'))
    expect(contents(host)).toEqual([])
    expect(exits).toEqual([])
  })
})

describe('permission prompts', () => {
  const ask = {
    subtype: 'can_use_tool',
    tool_name: 'Edit',
    input: { file_path: '/srv/app.ts' },
    tool_use_id: 'toolu_ssh',
    description: 'Edit app.ts on the server',
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    blocked_path: '/srv',
  }

  test('a request queues a prompt for the local tool and pauses loading', async () => {
    const ssh = sshSession()
    const edit = localTool('Edit')
    const host = await mountSsh(ssh, [edit])
    host.loading.set(true)
    ssh.fire().onPermissionRequest(ask, 'ssh-req-1')
    const prompt = host.queue.value()[0]!
    expect(prompt.tool).toBe(edit)
    expect(prompt.toolUseID).toBe('toolu_ssh')
    expect(prompt.input).toEqual({ file_path: '/srv/app.ts' })
    expect(prompt.description).toBe('Edit app.ts on the server')
    expect(prompt.permissionResult).toEqual({
      behavior: 'ask',
      message: 'Edit app.ts on the server',
      suggestions: ask.permission_suggestions,
      blockedPath: '/srv',
    } as never)
    expect((prompt.assistantMessage.message.content as unknown[])[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_ssh',
      name: 'Edit',
      input: { file_path: '/srv/app.ts' },
    })
    expect(host.loading.value()).toBe(false)
  })

  test('an unknown tool gets a stand-in and a default description; later tools are looked up', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    ssh.fire().onPermissionRequest({ tool_name: 'Deploy', input: {}, tool_use_id: 'toolu_d' }, 'ssh-req-2')
    const stub = host.queue.value()[0]!
    expect(stub.tool.name).toBe('Deploy')
    expect(stub.description).toBe('Deploy requires permission')
    expect((stub.permissionResult as { message: string }).message).toBe('Deploy requires permission')

    const deploy = localTool('Deploy')
    await host.hook.rerender({ ...host.props, tools: [deploy] })
    ssh.fire().onPermissionRequest({ tool_name: 'Deploy', input: {}, tool_use_id: 'toolu_d2' }, 'ssh-req-3')
    expect(host.queue.value()[1]!.tool).toBe(deploy)
  })

  type Answer = [string, (prompt: any) => void, unknown, boolean | undefined]
  const answers: Answer[] = [
    ['allow', p => p.onAllow({ file_path: '/srv/other.ts' }), { behavior: 'allow', updatedInput: { file_path: '/srv/other.ts' } }, true],
    ['reject with feedback', p => p.onReject('not on prod'), { behavior: 'deny', message: 'not on prod' }, false],
    ['reject', p => p.onReject(), { behavior: 'deny', message: 'User denied permission' }, false],
    ['abort', p => p.onAbort(), { behavior: 'deny', message: 'User aborted' }, false],
  ]

  test.each(answers)('%s answers the session and leaves the queue', async (_name, act, answer, loadingAfter) => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    ssh.fire().onPermissionRequest(ask, 'ssh-req-4')
    ssh.fire().onPermissionRequest({ ...ask, tool_use_id: 'toolu_stays' }, 'ssh-req-5')
    act(host.queue.value()[0])
    expect(ssh.answers).toEqual([['ssh-req-4', answer]])
    expect(host.queue.value().map(p => p.toolUseID)).toEqual(['toolu_stays'])
    expect(host.loading.value()).toBe(loadingAfter)
  })

  test('user interaction and a recheck answer nothing', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    ssh.fire().onPermissionRequest(ask, 'ssh-req-6')
    const prompt = host.queue.value()[0]!
    prompt.onUserInteraction()
    await prompt.recheckPermission()
    expect(ssh.answers).toEqual([])
    expect(host.queue.value()).toHaveLength(1)
  })
})

describe('the connection', () => {
  test('a drop shows a warning with the attempt count and stops loading', async () => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    ssh.fire().onConnected()
    host.loading.set(true)
    ssh.fire().onReconnecting(2, 5)
    expect(host.loading.value()).toBe(false)
    const warning = contents(host)[0]!
    expect(warning).toMatchObject({ type: 'system', subtype: 'informational', level: 'warning' })
    expect(warning.content).toContain('2/5')
    expect(warning.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(Number.isNaN(Date.parse(warning.timestamp))).toBe(false)
    expect(exits).toEqual([])
  })

  type Ending = {
    name: string
    connected: boolean
    stderr: string
    exitCode: number | null
    signalCode?: string
    says: string[]
    saysNot: string[]
  }
  const endings: Ending[] = [
    { name: 'a clean end after connecting', connected: true, stderr: 'verbose noise', exitCode: 0, says: ['ended'], saysNot: ['verbose noise', 'stderr'] },
    { name: 'a failing end after connecting', connected: true, stderr: 'fatal: out of memory\n', exitCode: 3, says: ['ended', 'exit 3', 'fatal: out of memory'], saysNot: ['before connecting'] },
    { name: 'a failure before connecting', connected: false, stderr: 'Permission denied (publickey).', exitCode: 255, says: ['before connecting', 'exit 255', 'Permission denied (publickey).'], saysNot: ['ended'] },
    { name: 'a kill before connecting', connected: false, stderr: 'killed', exitCode: null, signalCode: 'SIGKILL', says: ['before connecting', 'signal SIGKILL', 'killed'], saysNot: [] },
    { name: 'a failure before connecting with blank stderr', connected: false, stderr: '  \n ', exitCode: 1, says: ['before connecting'], saysNot: ['stderr', 'exit'] },
  ]

  test.each(endings)('giving up ends the CLI with status 1: $name', async ending => {
    const ssh = sshSession()
    const host = await mountSsh(ssh)
    if (ending.connected) ssh.fire().onConnected()
    ssh.stderr = ending.stderr
    ssh.exit = { exitCode: ending.exitCode, signalCode: ending.signalCode ?? null }
    host.loading.set(true)
    ssh.fire().onDisconnected()
    expect(host.loading.value()).toBe(false)
    expect(exits).toHaveLength(1)
    const [code, reason, options] = exits[0] as [number, string, { finalMessage: string }]
    expect([code, reason]).toEqual([1, 'other'])
    for (const fact of ending.says) expect(options.finalMessage).toContain(fact)
    for (const fact of ending.saysNot) expect(options.finalMessage).not.toContain(fact)
    if (ending.says.length > 1) expect(options.finalMessage.split('\n').length).toBeGreaterThan(1)
  })

  test('the stderr shown is trimmed', async () => {
    const ssh = sshSession()
    await mountSsh(ssh)
    ssh.stderr = '\n\n  ssh: connect to host box port 22: Connection refused  \n'
    ssh.exit = { exitCode: 255, signalCode: null }
    ssh.fire().onDisconnected()
    const message = (exits[0]![2] as { finalMessage: string }).finalMessage
    expect(message.endsWith('ssh: connect to host box port 22: Connection refused')).toBe(true)
  })
})
