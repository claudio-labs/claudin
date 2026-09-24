import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { InboundFrame, PeerInbox } from 'src/sessions/peers/inboxServer.js'
import { startPeerInbox } from 'src/sessions/peers/inboxServer.js'
import {
  CROSS_SESSION_SENDS_PER_USER_PROMPT,
  resetCrossSessionSends,
} from 'src/sessions/peers/sendBudget.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { SendMessageTool } from 'src/tools/SendMessageTool/SendMessageTool.js'

let root: string
let peer: PeerInbox
let own: PeerInbox
const received: InboundFrame[] = []
const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'smp-'))
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  const sessions = join(root, 'config', 'sessions')
  mkdirSync(sessions, { recursive: true })
  peer = await startPeerInbox({
    socketPath: join(root, 's', 'peer.sock'),
    handler: async frame => {
      received.push(frame)
      return { ok: true, outcome: 'delivered' }
    },
  })
  // Started last, so it is this process's own inbox — the `from` of a send.
  own = await startPeerInbox({
    socketPath: join(root, 's', 'own.sock'),
    handler: async () => ({ ok: true, outcome: 'delivered' }),
  })
  // The peer's record belongs to a process that is really alive: the parent.
  writeFileSync(
    join(sessions, `${process.ppid}.json`),
    JSON.stringify({
      pid: process.ppid,
      cwd: '/w/claudin-goal',
      startedAt: 1,
      messagingSocketPath: peer.socketPath,
      messagingToken: peer.token,
    }),
  )
})

afterAll(async () => {
  await own.close()
  await peer.close()
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  received.length = 0
  resetCrossSessionSends()
})

afterEach(() => {
  delete process.env.CLAUDIN_DISABLE_CROSS_SESSION
})

function context(agentId?: string): ToolUseContext {
  return {
    agentId,
    getAppState: () => ({
      tasks: {},
      agentNameRegistry: new Map(agentId ? [['tester', agentId]] : []),
      toolPermissionContext: { mode: 'default' },
    }),
  } as unknown as ToolUseContext
}

async function send(input: Record<string, unknown>, agentId?: string) {
  const result = await SendMessageTool.call(
    input as never,
    context(agentId),
    (() => {}) as never,
    undefined as never,
  )
  return result.data as { success: boolean; message: string }
}

describe('SendMessage to another session', () => {
  test('a session name reaches its inbox, signed with this session and its mode', async () => {
    const data = await send({ to: 'claudin-goal', message: 'run the tests' })
    expect(data.success).toBe(true)
    expect(data.message).toStartWith('Delivered to claudin-goal [')
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      type: 'message',
      text: 'run the tests',
      token: peer.token,
      from: `uds:${own.socketPath}`,
      from_name: basename(getOriginalCwd()),
      from_mode: 'prompting',
    })
  })

  test('a subagent sends under the session, and is told a reply goes to main', async () => {
    const data = await send({ to: 'claudin-goal', message: 'hi' }, 'a1')
    expect(received[0]).toMatchObject({ from_agent: 'tester' })
    expect(data.message).toContain('a reply reaches the main conversation, not this agent')
  })

  test('an address no session advertises is refused before anything is dialled', async () => {
    await expect(
      send({ to: 'uds:/var/run/docker.sock', message: 'hi' }),
    ).rejects.toThrow('No session is listening at that address')
    await expect(send({ to: `uds:${own.socketPath}`, message: 'hi' })).rejects.toThrow(
      'a message to yourself',
    )
    await expect(send({ to: 'claudin-goal [000000]', message: 'hi' })).rejects.toThrow(
      'has the ref [000000]',
    )
    expect(received).toEqual([])
  })

  test('an oversized message is refused with the way around it', async () => {
    await expect(
      send({ to: 'claudin-goal', message: 'x'.repeat(100_001) }),
    ).rejects.toThrow('write the content to a file and send the path')
    expect(received).toEqual([])
  })

  test('the send budget stops a ping-pong until the user writes again', async () => {
    for (let i = 0; i < CROSS_SESSION_SENDS_PER_USER_PROMPT; i++) {
      await send({ to: 'claudin-goal', message: `round ${i}` })
    }
    await expect(send({ to: 'claudin-goal', message: 'one more' })).rejects.toThrow(
      'Stop and ask your user',
    )
    expect(received).toHaveLength(CROSS_SESSION_SENDS_PER_USER_PROMPT)
    resetCrossSessionSends()
    expect((await send({ to: 'claudin-goal', message: 'after' })).success).toBe(true)
  })

  test('with the killswitch set, sessions are not addressable at all', async () => {
    process.env.CLAUDIN_DISABLE_CROSS_SESSION = '1'
    await expect(send({ to: 'claudin-goal', message: 'hi' })).rejects.toThrow(
      'No agent or session named "claudin-goal"',
    )
    await expect(send({ to: `uds:${peer.socketPath}`, message: 'hi' })).rejects.toThrow(
      'CLAUDIN_DISABLE_CROSS_SESSION',
    )
    expect(received).toEqual([])
  })
})
