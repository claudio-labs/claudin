/**
 * Characterization of `sessionIngressAuth`: where a CLI running in a remote
 * container finds the token for the session-ingress API, and how that token
 * becomes request headers.
 *
 * The sources are real: environment variables, a real open file descriptor
 * (read back through /proc/self/fd on Linux), and token files in a fresh temp
 * directory. The CCR well-known path under /home/claude does not exist on a
 * test machine, which is what a CLI outside CCR sees.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeSync, openSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  getSessionIngressAuthHeaders,
  getSessionIngressAuthToken,
  updateSessionIngressAuthToken,
} from 'src/sessions/sessionIngressAuth.js'
import { openScratch, type Scratch } from 'src/sessions/__testutils__/remoteRig.js'

const ENV_TOKEN = 'CLAUDE_CODE_SESSION_ACCESS_TOKEN'
const FD_VAR = 'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR'
const FILE_VAR = 'CLAUDE_SESSION_INGRESS_TOKEN_FILE'

let scratch: Scratch
const openFds: number[] = []

beforeEach(() => {
  scratch = openScratch('ingress-auth')
})

afterEach(() => {
  for (const fd of openFds.splice(0)) {
    try {
      closeSync(fd)
    } catch {}
  }
  scratch.dispose()
})

/** A token file in the scratch dir, with the given content. */
function tokenFile(name: string, content: string): string {
  const path = join(scratch.dir, name)
  writeFileSync(path, content)
  return path
}

/** An open descriptor onto a file holding `content`, as CCR passes one. */
function descriptorHolding(content: string): number {
  const fd = openSync(tokenFile(`fd-${openFds.length}`, content), 'r')
  openFds.push(fd)
  return fd
}

const UNUSED_FD = 987_654

describe('getSessionIngressAuthToken', () => {
  type Case = {
    name: string
    env: Record<string, (() => string) | string>
    token: string | null
  }

  const cases: Case[] = [
    { name: 'nothing set, outside CCR', env: {}, token: null },
    { name: 'the access-token variable', env: { [ENV_TOKEN]: 'tok-env' }, token: 'tok-env' },
    {
      name: 'the variable wins over a descriptor and a file',
      env: {
        [ENV_TOKEN]: 'tok-env',
        [FD_VAR]: () => String(descriptorHolding('tok-fd')),
        [FILE_VAR]: () => tokenFile('t', 'tok-file'),
      },
      token: 'tok-env',
    },
    { name: 'a token file, trimmed', env: { [FILE_VAR]: () => tokenFile('t', '\n  tok-file  \n') }, token: 'tok-file' },
    { name: 'a blank token file', env: { [FILE_VAR]: () => tokenFile('t', ' \n\t') }, token: null },
    { name: 'a token file that is missing', env: { [FILE_VAR]: () => join(scratch.dir, 'absent') }, token: null },
    { name: 'a token path that is a directory', env: { [FILE_VAR]: () => scratch.dir }, token: null },
    { name: 'a descriptor, trimmed', env: { [FD_VAR]: () => String(descriptorHolding('  tok-fd\n')) }, token: 'tok-fd' },
    {
      name: 'a descriptor wins over the file',
      env: { [FD_VAR]: () => String(descriptorHolding('tok-fd')), [FILE_VAR]: () => tokenFile('t', 'tok-file') },
      token: 'tok-fd',
    },
    {
      name: 'a descriptor that cannot be read falls back to the file',
      env: { [FD_VAR]: String(UNUSED_FD), [FILE_VAR]: () => tokenFile('t', 'tok-file') },
      token: 'tok-file',
    },
    { name: 'a descriptor that cannot be read, and no file', env: { [FD_VAR]: String(UNUSED_FD) }, token: null },
    {
      name: 'a descriptor variable that is not a number gives nothing, file or not',
      env: { [FD_VAR]: 'three', [FILE_VAR]: () => tokenFile('t', 'tok-file') },
      token: null,
    },
    {
      name: 'an empty descriptor gives nothing, file or not',
      env: { [FD_VAR]: () => String(descriptorHolding('\n')), [FILE_VAR]: () => tokenFile('t', 'tok-file') },
      token: null,
    },
    { name: 'an empty access-token variable is not a token', env: { [ENV_TOKEN]: '' }, token: null },
  ]

  test.each(cases)('$name', ({ env, token }) => {
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = typeof value === 'function' ? value() : value
    }
    expect(getSessionIngressAuthToken()).toBe(token)
  })

  test('what the descriptor or the file gave is kept for the life of the process', () => {
    const path = tokenFile('t', 'first')
    process.env[FILE_VAR] = path
    expect(getSessionIngressAuthToken()).toBe('first')
    writeFileSync(path, 'second')
    expect(getSessionIngressAuthToken()).toBe('first')
    delete process.env[FILE_VAR]
    expect(getSessionIngressAuthToken()).toBe('first')
  })

  test('so is finding nothing', () => {
    expect(getSessionIngressAuthToken()).toBeNull()
    process.env[FILE_VAR] = tokenFile('t', 'arrived later')
    expect(getSessionIngressAuthToken()).toBeNull()
  })

  test('a descriptor is read once', () => {
    const fd = descriptorHolding('once')
    process.env[FD_VAR] = String(fd)
    expect(getSessionIngressAuthToken()).toBe('once')
    closeSync(fd)
    openFds.length = 0
    expect(getSessionIngressAuthToken()).toBe('once')
  })

  test('the variable still wins over a kept token, and the kept one returns without it', () => {
    process.env[FILE_VAR] = tokenFile('t', 'kept')
    expect(getSessionIngressAuthToken()).toBe('kept')
    process.env[ENV_TOKEN] = 'fresh'
    expect(getSessionIngressAuthToken()).toBe('fresh')
    delete process.env[ENV_TOKEN]
    expect(getSessionIngressAuthToken()).toBe('kept')
  })
})

describe('getSessionIngressAuthHeaders', () => {
  const cases: Array<[string, string | undefined, string | undefined, Record<string, string>]> = [
    ['no token, no headers', undefined, undefined, {}],
    ['a JWT is a bearer token', 'eyJhbGciOi.payload.sig', undefined, { Authorization: 'Bearer eyJhbGciOi.payload.sig' }],
    ['an API key is a bearer token too', 'sk-ant-api03-abc', 'org-1', { Authorization: 'Bearer sk-ant-api03-abc' }],
    ['a session key is a cookie', 'sk-ant-sid01-abc', undefined, { Cookie: 'sessionKey=sk-ant-sid01-abc' }],
    [
      'a session key carries the organization when one is set',
      'sk-ant-sid01-abc',
      'org-42',
      { Cookie: 'sessionKey=sk-ant-sid01-abc', 'X-Organization-Uuid': 'org-42' },
    ],
    ['an empty organization is left out', 'sk-ant-sid01-abc', '', { Cookie: 'sessionKey=sk-ant-sid01-abc' }],
  ]

  test.each(cases)('%s', (_name, token, org, headers) => {
    if (token !== undefined) process.env[ENV_TOKEN] = token
    if (org !== undefined) process.env.CLAUDE_CODE_ORGANIZATION_UUID = org
    expect(getSessionIngressAuthHeaders()).toEqual(headers)
  })

  test('a token from a file makes the same headers', () => {
    process.env[FILE_VAR] = tokenFile('t', 'sk-ant-sid02-from-file\n')
    expect(getSessionIngressAuthHeaders()).toEqual({ Cookie: 'sessionKey=sk-ant-sid02-from-file' })
  })
})

describe('updateSessionIngressAuthToken', () => {
  test('sets the access-token variable, so the new token wins from then on', () => {
    process.env[FILE_VAR] = tokenFile('t', 'from-file')
    expect(getSessionIngressAuthToken()).toBe('from-file')
    updateSessionIngressAuthToken('rotated-jwt')
    expect(process.env[ENV_TOKEN]).toBe('rotated-jwt')
    expect(getSessionIngressAuthToken()).toBe('rotated-jwt')
    expect(getSessionIngressAuthHeaders()).toEqual({ Authorization: 'Bearer rotated-jwt' })
  })
})
