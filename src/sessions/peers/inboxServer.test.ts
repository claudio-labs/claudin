import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { PeerDeliveryError, pingInbox, sendFrame } from 'src/sessions/peers/client.js'
import type { RequestFrame, ResponseFrame } from 'src/sessions/peers/frames.js'
import {
  crossSessionUnavailableReason,
  getOwnInbox,
  type InboundFrame,
  type PeerInbox,
  startPeerInbox,
} from 'src/sessions/peers/inboxServer.js'
import {
  ensurePrivateSocketDir,
  isOwnedSocket,
  socketPathFor,
} from 'src/sessions/peers/socketPath.js'

let root: string
const opened: PeerInbox[] = []

beforeAll(() => {
  // Short: a socket path has to fit in sun_path.
  root = mkdtempSync(join(tmpdir(), 'pi-'))
})

afterEach(async () => {
  for (const inbox of opened.splice(0)) await inbox.close()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function open(
  name: string,
  handler: (frame: InboundFrame) => Promise<ResponseFrame> = async () => ({
    ok: true,
    outcome: 'delivered',
  }),
): Promise<PeerInbox> {
  const inbox = await startPeerInbox({ socketPath: join(root, 'socks', name), handler })
  opened.push(inbox)
  return inbox
}

function message(token: string, overrides: Partial<RequestFrame> = {}): RequestFrame {
  return {
    v: 1,
    type: 'message',
    msg_id: 'm1',
    token,
    text: 'run the tests',
    ...overrides,
  } as RequestFrame
}

describe('peer inbox', () => {
  test('hands an authenticated frame to the handler and returns its answer', async () => {
    const seen: InboundFrame[] = []
    const inbox = await open('a.sock', async frame => {
      seen.push(frame)
      return { ok: true, outcome: 'delivered' }
    })
    expect(await sendFrame(inbox.socketPath, message(inbox.token))).toEqual({
      ok: true,
      outcome: 'delivered',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'message', text: 'run the tests' })
  })

  test('refuses a frame carrying the wrong token without reaching the handler', async () => {
    let reached = false
    const inbox = await open('b.sock', async () => {
      reached = true
      return { ok: true, outcome: 'delivered' }
    })
    const response = await sendFrame(inbox.socketPath, message('f'.repeat(64)))
    expect(response).toMatchObject({ ok: false, outcome: 'refused' })
    expect(response.detail).toContain('wrong token')
    expect(reached).toBe(false)
  })

  test('refuses another protocol version with the reason', async () => {
    const inbox = await open('c.sock')
    const response = await sendFrame(
      inbox.socketPath,
      message(inbox.token, { v: 2 } as unknown as Partial<RequestFrame>),
    )
    expect(response.detail).toContain('unsupported protocol version 2')
  })

  test('answers a ping itself, and a closed inbox reads as gone', async () => {
    const inbox = await open('d.sock')
    expect(await pingInbox(inbox.socketPath, inbox.token)).toBe(true)
    expect(await pingInbox(inbox.socketPath, 'nope')).toBe(false)
    await inbox.close()
    expect(getOwnInbox()).not.toBe(inbox)
    const error = await sendFrame(inbox.socketPath, message(inbox.token)).catch(e => e)
    expect(error).toBeInstanceOf(PeerDeliveryError)
    expect((error as PeerDeliveryError).reason).toBe('gone')
  })

  test('the socket is owner-only inside an owner-only directory', async () => {
    const inbox = await open('e.sock')
    expect(statSync(inbox.socketPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'socks')).mode & 0o777).toBe(0o700)
    expect(await isOwnedSocket(inbox.socketPath)).toBe(true)
  })
})

describe('socket paths', () => {
  test('a symlinked or plain file never passes for a socket', async () => {
    const inbox = await open('f.sock')
    const link = join(root, 'link.sock')
    symlinkSync(inbox.socketPath, link)
    const plain = join(root, 'plain.sock')
    writeFileSync(plain, '')
    expect(await isOwnedSocket(link)).toBe(false)
    expect(await isOwnedSocket(plain)).toBe(false)
  })

  test('a symlink where the socket directory should be is refused', async () => {
    const real = join(root, 'real-dir')
    mkdirSync(real)
    const link = join(root, 'dir-link')
    symlinkSync(real, link)
    await expect(ensurePrivateSocketDir(link)).rejects.toThrow('not a directory')
  })

  test('prefers the runtime dir and falls back under /tmp when sun_path would overflow', () => {
    expect(socketPathFor(42, { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(
      '/run/user/1000/claudin-socks/42.sock',
    )
    const long = socketPathFor(42, { XDG_RUNTIME_DIR: `/${'x'.repeat(120)}` })
    expect(long).toStartWith('/tmp/claudin-socks-')
    expect(long).toEndWith('/42.sock')
  })
})

test('crossSessionUnavailableReason covers Windows and the killswitch', () => {
  expect(crossSessionUnavailableReason('linux', {})).toBeUndefined()
  expect(crossSessionUnavailableReason('win32', {})).toContain('Windows')
  expect(
    crossSessionUnavailableReason('darwin', { CLAUDIN_DISABLE_CROSS_SESSION: '1' }),
  ).toContain('CLAUDIN_DISABLE_CROSS_SESSION')
})
