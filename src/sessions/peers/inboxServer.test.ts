import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { createConnection } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'

import { PeerDeliveryError, pingInbox, sendFrame } from 'src/sessions/peers/client.js'
import {
  encodeFrame,
  MAX_FRAME_BYTES,
  type RequestFrame,
  type ResponseFrame,
} from 'src/sessions/peers/frames.js'
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

/** Write `chunks` to the socket one by one, and read back whatever it answers. */
function rawExchange(socketPath: string, chunks: Buffer[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let answer = ''
    socket.on('data', data => {
      answer += data.toString('utf8')
      // The inbox answers one line, then stops reading what is still coming.
      if (answer.includes('\n')) {
        socket.destroy()
        resolve(answer)
      }
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(answer))
    socket.on('connect', async () => {
      for (const chunk of chunks) {
        socket.write(chunk)
        await new Promise(r => setTimeout(r, 5))
      }
    })
  })
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

  test('a character split across two chunks arrives whole', async () => {
    const seen: InboundFrame[] = []
    const inbox = await open('u.sock', async frame => {
      seen.push(frame)
      return { ok: true, outcome: 'delivered' }
    })
    const bytes = Buffer.from(encodeFrame(message(inbox.token, { text: 'olá — 日本語' } as Partial<RequestFrame>)))
    // Cut inside 日 (three bytes in UTF-8).
    const cut = bytes.indexOf(Buffer.from('日')) + 1
    const answer = await rawExchange(inbox.socketPath, [bytes.subarray(0, cut), bytes.subarray(cut)])
    expect(answer).toContain('"outcome":"delivered"')
    expect(seen[0]).toMatchObject({ text: 'olá — 日本語' })
  })

  test('one connection carries one frame: bytes after its newline are ignored', async () => {
    let calls = 0
    const inbox = await open('o.sock', async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 20))
      return { ok: true, outcome: 'delivered' }
    })
    const frame = Buffer.from(encodeFrame(message(inbox.token)))
    await rawExchange(inbox.socketPath, [frame, Buffer.from('x'), Buffer.from('y\n')])
    expect(calls).toBe(1)
  })

  test('the frame cap counts bytes, not characters', async () => {
    const inbox = await open('l.sock')
    // Under the cap in UTF-16 units, over it in bytes.
    const answer = await rawExchange(inbox.socketPath, [Buffer.from('日'.repeat(MAX_FRAME_BYTES / 2))])
    expect(answer).toContain('frame too large')
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

  test("without a runtime dir, the temp dir holds one directory per user — no user can claim another's", () => {
    expect(socketPathFor(42, {})).toBe(join(tmpdir(), `claudin-socks-${process.getuid?.()}`, '42.sock'))
  })
})

test('crossSessionUnavailableReason covers Windows and the killswitch', () => {
  expect(crossSessionUnavailableReason('linux', {})).toBeUndefined()
  expect(crossSessionUnavailableReason('win32', {})).toContain('Windows')
  expect(
    crossSessionUnavailableReason('darwin', { CLAUDIN_DISABLE_CROSS_SESSION: '1' }),
  ).toContain('CLAUDIN_DISABLE_CROSS_SESSION')
})
