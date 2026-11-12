// Characterization of proxy.ts as it behaves today (2026-11-12), written
// before the CONNECT-proxy TLS fix touches createHttpsProxyAgent. These tests
// pin current behavior, not intended behavior: where today's routing looks
// questionable the assertion still records what the code does.
//
// No mock.module: everything is observed through the exported functions, the
// real https-proxy-agent objects, axios adapters, and constructor captures on
// the `undici` module object proxy.ts lazy-requires (restored after each test).
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import axios, {
  type AxiosAdapter,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type * as undiciTypes from 'undici'
import { clearCACertsCache, getCACertificates } from 'src/providers/transport/caCerts.js'
import {
  clearMTLSCache,
  getMTLSAgent,
  getMTLSConfig,
} from 'src/providers/transport/mtls.js'
import {
  _resetH1OnlyForTesting,
  _resetKeepAliveForTesting,
  clearProxyCache,
  configureGlobalAgents,
  createAxiosInstance,
  disableKeepAlive,
  getAddressFamily,
  getAWSClientProxyConfig,
  getNoProxy,
  getProviderDispatcher,
  getProxyAgent,
  getProxyFetchOptions,
  getProxyUrl,
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
  isProviderH1Only,
  markProviderH1Only,
  shouldBypassProxy,
} from 'src/providers/transport/proxy.js'

// The same module object proxy.ts reaches with require('undici'); under Bun
// this is the runtime's built-in undici, whose classes keep no options, so the
// options handed to a constructor are captured by swapping the class.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const undiciMod = require('undici') as typeof undiciTypes

const PROXY = 'http://proxy.test:3128'
const CERT_PATH = import.meta.path
const KEY_PATH = join(import.meta.dir, 'proxy.ts')

const ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'CLAUDIN_CLIENT_CERT',
  'CLAUDIN_CLIENT_KEY',
  'CLAUDIN_CLIENT_KEY_PASSPHRASE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'CLAUDIN_PROXY_RESOLVES_HOSTS',
  'ANTHROPIC_UNIX_SOCKET',
] as const

const savedEnv: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

type Restorer = () => void
let restorers: Restorer[] = []

function resetCaches(): void {
  clearMTLSCache()
  clearCACertsCache()
  clearProxyCache()
  _resetH1OnlyForTesting()
  _resetKeepAliveForTesting()
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  resetCaches()
})

afterEach(() => {
  for (const r of restorers.reverse()) r()
  restorers = []
  for (const k of ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetCaches()
})

/** Replace an undici class with a subclass that records constructor options. */
function captureCtor(name: 'Agent' | 'EnvHttpProxyAgent'): unknown[] {
  const calls: unknown[] = []
  const slots = undiciMod as unknown as Record<string, unknown>
  const Original = slots[name] as new (opts: unknown) => object
  class Capturing extends Original {
    constructor(opts: unknown) {
      super(opts)
      calls.push(opts)
    }
  }
  slots[name] = Capturing
  restorers.push(() => {
    slots[name] = Original
  })
  return calls
}

function setMTLSEnv(): void {
  process.env.CLAUDIN_CLIENT_CERT = CERT_PATH
  process.env.CLAUDIN_CLIENT_KEY = KEY_PATH
  process.env.CLAUDIN_CLIENT_KEY_PASSPHRASE = 'pp'
}

function setCAEnv(): void {
  process.env.NODE_EXTRA_CA_CERTS = CERT_PATH
}

type ConnectOpts = Record<string, unknown> & {
  lookup?: (
    hostname: string,
    options: { family?: unknown },
    cb: (err: unknown, address: string, family: number) => void,
  ) => void
}

function connectOptsOf(agent: unknown): ConnectOpts {
  expect(agent).toBeInstanceOf(HttpsProxyAgent)
  return (agent as HttpsProxyAgent<string>).connectOpts as unknown as ConnectOpts
}

/** Run a request through `client` and return the config its adapter saw. */
async function capturedConfig(
  client: AxiosInstance,
  url: string,
): Promise<InternalAxiosRequestConfig> {
  let seen: InternalAxiosRequestConfig | undefined
  const adapter: AxiosAdapter = config => {
    seen = config
    return Promise.resolve({
      data: null,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    })
  }
  await client.get(url, { adapter })
  expect(seen).toBeDefined()
  return seen!
}

describe('getAddressFamily', () => {
  test.each([
    [0, 0],
    [4, 4],
    [6, 6],
    ['IPv4', 4],
    ['IPv6', 6],
    [undefined, 4],
  ] as const)('family %p → %p', (family, expected) => {
    expect(getAddressFamily({ family } as never)).toBe(expected)
  })

  test('throws on an unsupported family', () => {
    expect(() => getAddressFamily({ family: 5 } as never)).toThrow(
      'Unsupported address family: 5',
    )
  })
})

describe('getProxyUrl / getNoProxy precedence', () => {
  test('https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY', () => {
    const all = {
      https_proxy: 'a',
      HTTPS_PROXY: 'b',
      http_proxy: 'c',
      HTTP_PROXY: 'd',
    }
    expect(getProxyUrl(all)).toBe('a')
    expect(getProxyUrl({ ...all, https_proxy: undefined })).toBe('b')
    expect(getProxyUrl({ http_proxy: 'c', HTTP_PROXY: 'd' })).toBe('c')
    expect(getProxyUrl({ HTTP_PROXY: 'd' })).toBe('d')
    expect(getProxyUrl({})).toBeUndefined()
  })

  test('an empty lowercase value falls through to the uppercase one', () => {
    expect(getProxyUrl({ https_proxy: '', HTTPS_PROXY: 'b' })).toBe('b')
    expect(getNoProxy({ no_proxy: '', NO_PROXY: 'y' })).toBe('y')
  })

  test('no_proxy wins over NO_PROXY', () => {
    expect(getNoProxy({ no_proxy: 'x', NO_PROXY: 'y' })).toBe('x')
    expect(getNoProxy({ NO_PROXY: 'y' })).toBe('y')
    expect(getNoProxy({})).toBeUndefined()
  })

  test('both default to process.env', () => {
    process.env.HTTP_PROXY = PROXY
    process.env.NO_PROXY = 'internal'
    expect(getProxyUrl()).toBe(PROXY)
    expect(getNoProxy()).toBe('internal')
  })
})

describe('shouldBypassProxy defaults', () => {
  test('reads NO_PROXY from the environment when no value is passed', () => {
    process.env.no_proxy = 'internal.test'
    expect(shouldBypassProxy('https://api.internal.test')).toBe(true)
    expect(shouldBypassProxy('https://example.com')).toBe(false)
  })

  test('with no NO_PROXY nothing bypasses', () => {
    expect(shouldBypassProxy('https://localhost')).toBe(false)
  })

  test('whitespace and comma separators, and a wss: default port of 443', () => {
    expect(shouldBypassProxy('wss://a.test', 'x.test  a.test:443')).toBe(true)
    expect(shouldBypassProxy('wss://a.test', 'a.test:80')).toBe(false)
  })
})

describe('createHttpsProxyAgent (through getWebSocketProxyAgent)', () => {
  test('no mTLS and no CA: only the proxy endpoint and the ALPN default', () => {
    process.env.HTTPS_PROXY = PROXY
    const agent = getWebSocketProxyAgent('wss://api.example.com')
    const opts = connectOptsOf(agent)
    expect((agent as HttpsProxyAgent<string>).proxy.href).toBe(`${PROXY}/`)
    expect(opts).toEqual({
      ALPNProtocols: ['http/1.1'],
      host: 'proxy.test',
      port: 3128,
    })
  })

  test('mTLS cert/key/passphrase and CA go into the proxy socket options', () => {
    // Today these are constructor options, which https-proxy-agent applies to
    // the socket it opens to the PROXY (connectOpts), not to the target.
    process.env.HTTPS_PROXY = PROXY
    setMTLSEnv()
    setCAEnv()
    const opts = connectOptsOf(getWebSocketProxyAgent('wss://api.example.com'))
    expect(opts.cert).toBe(readFileSync(CERT_PATH, 'utf8'))
    expect(opts.key).toBe(readFileSync(KEY_PATH, 'utf8'))
    expect(opts.passphrase).toBe('pp')
    expect(opts.ca).toBe(getCACertificates())
    const ca = opts.ca as string[]
    expect(ca.at(-1)).toBe(readFileSync(CERT_PATH, 'utf8'))
    expect(ca.length).toBeGreaterThan(1)
    expect(opts.host).toBe('proxy.test')
    expect(opts.port).toBe(3128)
  })

  test('mTLS without CA carries no ca key', () => {
    process.env.HTTPS_PROXY = PROXY
    process.env.CLAUDIN_CLIENT_KEY_PASSPHRASE = 'only-pass'
    const opts = connectOptsOf(getWebSocketProxyAgent('wss://api.example.com'))
    expect(opts.passphrase).toBe('only-pass')
    expect('ca' in opts).toBe(false)
    // getMTLSConfig never set cert/key, but the spread still writes the keys.
    expect('cert' in opts).toBe(true)
    expect(opts.cert).toBeUndefined()
    expect(opts.key).toBeUndefined()
  })

  test('CA without mTLS carries ca and no cert/key keys', () => {
    process.env.HTTPS_PROXY = PROXY
    setCAEnv()
    const opts = connectOptsOf(getWebSocketProxyAgent('wss://api.example.com'))
    expect(opts.ca).toBe(getCACertificates())
    expect('cert' in opts).toBe(false)
    expect('key' in opts).toBe(false)
    expect('passphrase' in opts).toBe(false)
  })

  test('an https: proxy without a port defaults to 443', () => {
    process.env.HTTPS_PROXY = 'https://secure-proxy.test'
    const opts = connectOptsOf(getWebSocketProxyAgent('wss://api.example.com'))
    expect(opts.port).toBe(443)
    expect(opts.host).toBe('secure-proxy.test')
  })

  test('CLAUDIN_PROXY_RESOLVES_HOSTS installs a lookup that echoes the hostname', () => {
    process.env.HTTPS_PROXY = PROXY
    process.env.CLAUDIN_PROXY_RESOLVES_HOSTS = 'true'
    const opts = connectOptsOf(getWebSocketProxyAgent('wss://api.example.com'))
    expect(typeof opts.lookup).toBe('function')
    const results: unknown[][] = []
    opts.lookup!('api.example.com', { family: 'IPv6' }, (...args) =>
      results.push(args),
    )
    opts.lookup!('api.example.com', {}, (...args) => results.push(args))
    expect(results).toEqual([
      [null, 'api.example.com', 6],
      [null, 'api.example.com', 4],
    ])
  })

  test('a falsy CLAUDIN_PROXY_RESOLVES_HOSTS installs no lookup', () => {
    process.env.HTTPS_PROXY = PROXY
    process.env.CLAUDIN_PROXY_RESOLVES_HOSTS = '0'
    const opts = connectOptsOf(getWebSocketProxyAgent('wss://api.example.com'))
    expect('lookup' in opts).toBe(false)
  })

  test('each call builds a fresh agent (not memoized)', () => {
    process.env.HTTPS_PROXY = PROXY
    const a = getWebSocketProxyAgent('wss://a.example.com')
    const b = getWebSocketProxyAgent('wss://a.example.com')
    expect(a).toBeInstanceOf(HttpsProxyAgent)
    expect(a).not.toBe(b)
  })
})

describe('getWebSocketProxyAgent / getWebSocketProxyUrl', () => {
  test('no proxy configured → undefined', () => {
    expect(getWebSocketProxyAgent('wss://api.example.com')).toBeUndefined()
    expect(getWebSocketProxyUrl('wss://api.example.com')).toBeUndefined()
  })

  test('NO_PROXY match → undefined', () => {
    process.env.HTTPS_PROXY = PROXY
    process.env.NO_PROXY = 'example.com'
    expect(getWebSocketProxyAgent('wss://api.example.com')).toBeUndefined()
    expect(getWebSocketProxyUrl('wss://api.example.com')).toBeUndefined()
  })

  test('proxied → agent / the raw proxy URL string', () => {
    process.env.http_proxy = PROXY
    process.env.NO_PROXY = 'other.test'
    expect(getWebSocketProxyAgent('wss://api.example.com')).toBeInstanceOf(
      HttpsProxyAgent,
    )
    expect(getWebSocketProxyUrl('wss://api.example.com')).toBe(PROXY)
  })
})

describe('createAxiosInstance', () => {
  test('no proxy, no TLS config: plain instance with proxy:false and no agents', async () => {
    const client = createAxiosInstance()
    expect(client.defaults.proxy).toBe(false)
    expect(client.defaults.httpsAgent).toBeUndefined()
    const cfg = await capturedConfig(client, 'https://api.example.com/x')
    expect(cfg.httpsAgent).toBeUndefined()
    expect(cfg.httpAgent).toBeUndefined()
  })

  test('no proxy, mTLS configured: the mTLS agent is the instance default', async () => {
    setMTLSEnv()
    const client = createAxiosInstance()
    const mtlsAgent = getMTLSAgent()
    expect(mtlsAgent).toBeDefined()
    expect(client.defaults.httpsAgent).toBe(mtlsAgent)
    const cfg = await capturedConfig(client, 'https://api.example.com/x')
    expect(cfg.httpsAgent).toBe(mtlsAgent)
    expect(cfg.httpAgent).toBeUndefined()
  })

  test('proxied request uses one shared HttpsProxyAgent for http and https', async () => {
    process.env.HTTPS_PROXY = PROXY
    const client = createAxiosInstance()
    const first = await capturedConfig(client, 'https://api.example.com/x')
    const second = await capturedConfig(client, 'http://other.example.com/y')
    expect(first.httpsAgent).toBeInstanceOf(HttpsProxyAgent)
    expect(first.httpAgent).toBe(first.httpsAgent)
    expect(second.httpsAgent).toBe(first.httpsAgent)
    expect(
      (first.httpsAgent as HttpsProxyAgent<string>).proxy.href,
    ).toBe(`${PROXY}/`)
  })

  test('bypassed request without mTLS gets undefined agents', async () => {
    process.env.HTTPS_PROXY = PROXY
    process.env.NO_PROXY = 'internal.test'
    const client = createAxiosInstance()
    const cfg = await capturedConfig(client, 'https://svc.internal.test/x')
    expect(cfg.httpsAgent).toBeUndefined()
    expect(cfg.httpAgent).toBeUndefined()
  })

  test('bypassed request with mTLS gets the mTLS agent on both slots', async () => {
    process.env.HTTPS_PROXY = PROXY
    process.env.NO_PROXY = 'internal.test'
    setMTLSEnv()
    const client = createAxiosInstance()
    const cfg = await capturedConfig(client, 'https://svc.internal.test/x')
    expect(cfg.httpsAgent).toBe(getMTLSAgent())
    expect(cfg.httpAgent).toBe(getMTLSAgent())
  })

  test('NO_PROXY is read per request, not when the instance is built', async () => {
    process.env.HTTPS_PROXY = PROXY
    const client = createAxiosInstance()
    process.env.NO_PROXY = 'api.example.com'
    const cfg = await capturedConfig(client, 'https://api.example.com/x')
    expect(cfg.httpsAgent).toBeUndefined()
  })

  test('extra options are merged over the computed TLS options', async () => {
    process.env.HTTPS_PROXY = PROXY
    setMTLSEnv()
    setCAEnv()
    const client = createAxiosInstance({
      ca: 'override-ca',
      headers: { 'Proxy-Authorization': 'Basic abc' },
      timeout: 1234,
    })
    const cfg = await capturedConfig(client, 'https://api.example.com/x')
    const agent = cfg.httpsAgent as HttpsProxyAgent<string>
    const opts = connectOptsOf(agent)
    expect(opts.ca).toBe('override-ca')
    expect(opts.passphrase).toBe('pp')
    expect(opts.timeout).toBe(1234)
    expect('headers' in opts).toBe(false)
    expect(agent.proxyHeaders).toEqual({ 'Proxy-Authorization': 'Basic abc' })
  })

  test('the interceptor stays scoped to the instance, not global axios', async () => {
    process.env.HTTPS_PROXY = PROXY
    createAxiosInstance()
    const cfg = await capturedConfig(axios, 'https://api.example.com/x')
    expect(cfg.httpsAgent).not.toBeInstanceOf(HttpsProxyAgent)
  })
})

describe('getProviderDispatcher pool profiles', () => {
  test('a known provider gets the h2 profile with a 30s keep-alive', () => {
    const calls = captureCtor('Agent')
    const d = getProviderDispatcher('gemini')
    expect(d).toBeInstanceOf(undiciMod.Agent)
    expect(calls).toEqual([
      {
        allowH2: true,
        connections: 12,
        keepAliveTimeout: 30_000,
        pipelining: 1,
      },
    ])
  })

  test('an unknown provider falls back to the same optimistic profile', () => {
    const calls = captureCtor('Agent')
    getProviderDispatcher('some-gateway')
    getProviderDispatcher('bedrock')
    expect(calls).toEqual([
      { allowH2: true, connections: 12, keepAliveTimeout: 30_000, pipelining: 1 },
      { allowH2: true, connections: 12, keepAliveTimeout: 30_000, pipelining: 1 },
    ])
  })

  test('h1-only and keep-alive-disabled are both reflected after rebuild', () => {
    const calls = captureCtor('Agent')
    markProviderH1Only('mistral')
    getProviderDispatcher('mistral')
    disableKeepAlive('mistral')
    getProviderDispatcher('mistral')
    expect(calls).toEqual([
      { allowH2: false, connections: 12, keepAliveTimeout: 30_000, pipelining: 1 },
      { allowH2: false, connections: 12, keepAliveTimeout: 100, pipelining: 1 },
    ])
  })

  test('the per-provider resets touch only that provider', () => {
    markProviderH1Only('a')
    markProviderH1Only('b')
    disableKeepAlive('a')
    disableKeepAlive('b')
    const bBefore = getProviderDispatcher('b')
    _resetH1OnlyForTesting('a')
    _resetKeepAliveForTesting('a')
    expect(isProviderH1Only('a')).toBe(false)
    expect(isProviderH1Only('b')).toBe(true)
    expect(getProviderDispatcher('b')).toBe(bBefore)
    expect(getProxyFetchOptions({ provider: 'a' }).keepalive).toBeUndefined()
    expect(getProxyFetchOptions({ provider: 'b' }).keepalive).toBe(false)
  })

  test('a provider-scoped reset invalidates that provider dispatcher', () => {
    const before = getProviderDispatcher('openai')
    _resetKeepAliveForTesting('openai')
    const mid = getProviderDispatcher('openai')
    _resetH1OnlyForTesting('openai')
    expect(mid).not.toBe(before)
    expect(getProviderDispatcher('openai')).not.toBe(mid)
  })
})

describe('getProxyAgent', () => {
  test('without TLS config: both proxies set to the URI, NO_PROXY passed through', () => {
    const calls = captureCtor('EnvHttpProxyAgent')
    process.env.no_proxy = 'internal.test'
    const agent = getProxyAgent(PROXY)
    expect(agent).toBeInstanceOf(undiciMod.EnvHttpProxyAgent)
    expect(calls).toEqual([
      { httpProxy: PROXY, httpsProxy: PROXY, noProxy: 'internal.test' },
    ])
  })

  test('with mTLS and CA: one TLS object on both connect and requestTls', () => {
    const calls = captureCtor('EnvHttpProxyAgent')
    setMTLSEnv()
    setCAEnv()
    getProxyAgent(PROXY)
    const opts = calls[0] as Record<string, Record<string, unknown>>
    expect(opts.connect).toBe(opts.requestTls)
    expect(opts.connect).toEqual({
      cert: readFileSync(CERT_PATH, 'utf8'),
      key: readFileSync(KEY_PATH, 'utf8'),
      passphrase: 'pp',
      ca: getCACertificates(),
    })
  })

  test('with only a CA: TLS object holds ca alone', () => {
    const calls = captureCtor('EnvHttpProxyAgent')
    setCAEnv()
    getProxyAgent(PROXY)
    const opts = calls[0] as Record<string, Record<string, unknown>>
    expect(Object.keys(opts.connect!)).toEqual(['ca'])
    expect(opts.requestTls).toBe(opts.connect)
  })

  test('memoized per URI; NO_PROXY and TLS are frozen until clearProxyCache', () => {
    const calls = captureCtor('EnvHttpProxyAgent')
    const a = getProxyAgent(PROXY)
    process.env.NO_PROXY = 'late.test'
    setMTLSEnv()
    expect(getProxyAgent(PROXY)).toBe(a)
    expect(getProxyAgent('http://other-proxy.test:8080')).not.toBe(a)
    expect(calls).toHaveLength(2)
    clearProxyCache()
    const b = getProxyAgent(PROXY)
    expect(b).not.toBe(a)
    expect((calls[2] as Record<string, unknown>).noProxy).toBe('late.test')
  })
})

describe('getProxyFetchOptions (Bun runtime branches)', () => {
  test('forAnthropicAPI with ANTHROPIC_UNIX_SOCKET returns only the socket', () => {
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/auth.sock'
    process.env.HTTPS_PROXY = PROXY
    expect(getProxyFetchOptions({ forAnthropicAPI: true })).toEqual({
      unix: '/tmp/auth.sock',
    })
  })

  test('the unix socket keeps keepalive:false for a disabled provider', () => {
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/auth.sock'
    disableKeepAlive('firstParty')
    expect(
      getProxyFetchOptions({ forAnthropicAPI: true, provider: 'firstParty' }),
    ).toEqual({ keepalive: false, unix: '/tmp/auth.sock' })
  })

  test('ANTHROPIC_UNIX_SOCKET is ignored for non-Anthropic callers', () => {
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/auth.sock'
    expect(getProxyFetchOptions()).toEqual({})
    expect(getProxyFetchOptions({ forAnthropicAPI: false })).toEqual({})
  })

  test('forAnthropicAPI without a socket falls through to the proxy path', () => {
    process.env.HTTPS_PROXY = PROXY
    expect(getProxyFetchOptions({ forAnthropicAPI: true })).toEqual({
      proxy: PROXY,
    })
  })

  test('proxy + TLS config: proxy string plus the tls object', () => {
    process.env.HTTPS_PROXY = PROXY
    setMTLSEnv()
    setCAEnv()
    const opts = getProxyFetchOptions({ provider: 'openai' })
    expect(opts.proxy).toBe(PROXY)
    expect(opts.dispatcher).toBeUndefined()
    expect(opts.tls).toEqual({
      ...getMTLSConfig(),
      ca: getCACertificates(),
    })
  })

  test('proxy + keep-alive disabled provider: keepalive:false rides along', () => {
    process.env.HTTPS_PROXY = PROXY
    disableKeepAlive('openai')
    expect(getProxyFetchOptions({ provider: 'openai' })).toEqual({
      keepalive: false,
      proxy: PROXY,
    })
  })

  test('keep-alive state of a provider does not leak to provider-less callers', () => {
    disableKeepAlive('openai')
    expect(getProxyFetchOptions()).toEqual({})
  })

  test('no proxy, TLS config, known provider: tls plus the per-provider dispatcher', () => {
    // Under Bun getTLSFetchOptions returns {tls} without a dispatcher, so the
    // per-provider Agent is attached next to it.
    setMTLSEnv()
    const opts = getProxyFetchOptions({ provider: 'openai' })
    expect(opts.tls).toEqual(getMTLSConfig())
    expect(opts.dispatcher).toBe(getProviderDispatcher('openai'))
  })

  test('no proxy, TLS config, no provider: tls only', () => {
    setCAEnv()
    expect(getProxyFetchOptions()).toEqual({
      tls: { ca: getCACertificates() },
    })
  })

  test('no proxy, keep-alive disabled provider: keepalive:false and a dispatcher', () => {
    disableKeepAlive('codex')
    const opts = getProxyFetchOptions({ provider: 'codex' })
    expect(opts.keepalive).toBe(false)
    expect(opts.dispatcher).toBe(getProviderDispatcher('codex'))
  })
})

describe('configureGlobalAgents', () => {
  type InterceptorList = { handlers: (unknown | null)[] }
  const saved = {
    proxy: axios.defaults.proxy,
    httpAgent: axios.defaults.httpAgent,
    httpsAgent: axios.defaults.httpsAgent,
  }

  function liveInterceptors(): number {
    return (axios.interceptors.request as unknown as InterceptorList).handlers.filter(
      Boolean,
    ).length
  }

  let setGlobal: ReturnType<typeof spyOn>

  beforeEach(() => {
    setGlobal = spyOn(undiciMod, 'setGlobalDispatcher').mockImplementation(
      () => {},
    )
  })

  afterEach(() => {
    // Eject our interceptor and reset the axios defaults: with a clean env,
    // configureGlobalAgents() does exactly that. The file-level afterEach
    // runs after this one, so the env is cleared here first.
    for (const k of ENV_KEYS) delete process.env[k]
    resetCaches()
    configureGlobalAgents()
    setGlobal.mockRestore()
    axios.defaults.proxy = saved.proxy
    axios.defaults.httpAgent = saved.httpAgent
    axios.defaults.httpsAgent = saved.httpsAgent
  })

  test('nothing configured: defaults reset, no interceptor, no dispatcher', async () => {
    axios.defaults.proxy = false
    axios.defaults.httpsAgent = {} as never
    const before = liveInterceptors()
    configureGlobalAgents()
    expect(axios.defaults.proxy).toBeUndefined()
    expect(axios.defaults.httpAgent).toBeUndefined()
    expect(axios.defaults.httpsAgent).toBeUndefined()
    expect(liveInterceptors()).toBe(before)
    expect(setGlobal).not.toHaveBeenCalled()
  })

  test('proxy: proxy:false, interceptor routes through HttpsProxyAgent, global dispatcher set', async () => {
    process.env.HTTPS_PROXY = PROXY
    configureGlobalAgents()
    expect(axios.defaults.proxy).toBe(false)
    expect(axios.defaults.httpsAgent).toBeUndefined()
    expect(axios.defaults.httpAgent).toBeUndefined()

    const cfg = await capturedConfig(axios, 'https://api.example.com/x')
    expect(cfg.httpsAgent).toBeInstanceOf(HttpsProxyAgent)
    expect(cfg.httpAgent).toBe(cfg.httpsAgent)

    expect(setGlobal).toHaveBeenCalledTimes(1)
    expect(setGlobal.mock.calls[0]![0]).toBe(getProxyAgent(PROXY))
  })

  test('proxy + NO_PROXY match without mTLS: agents removed from the request', async () => {
    process.env.HTTPS_PROXY = PROXY
    process.env.NO_PROXY = 'internal.test'
    configureGlobalAgents()
    const cfg = await capturedConfig(axios, 'https://svc.internal.test/x')
    expect('httpsAgent' in cfg).toBe(false)
    expect('httpAgent' in cfg).toBe(false)
  })

  test('proxy + NO_PROXY match with mTLS: the mTLS agent on both slots', async () => {
    process.env.HTTPS_PROXY = PROXY
    process.env.NO_PROXY = 'internal.test'
    setMTLSEnv()
    configureGlobalAgents()
    const cfg = await capturedConfig(axios, 'https://svc.internal.test/x')
    expect(cfg.httpsAgent).toBe(getMTLSAgent())
    expect(cfg.httpAgent).toBe(getMTLSAgent())
  })

  test('the proxy agent carries the mTLS/CA options (same as createHttpsProxyAgent)', async () => {
    process.env.HTTPS_PROXY = PROXY
    setMTLSEnv()
    configureGlobalAgents()
    const cfg = await capturedConfig(axios, 'https://api.example.com/x')
    const opts = connectOptsOf(cfg.httpsAgent)
    expect(opts.passphrase).toBe('pp')
    expect(opts.cert).toBe(readFileSync(CERT_PATH, 'utf8'))
  })

  test('repeated calls replace the interceptor instead of stacking', async () => {
    process.env.HTTPS_PROXY = PROXY
    const before = liveInterceptors()
    configureGlobalAgents()
    configureGlobalAgents()
    configureGlobalAgents()
    expect(liveInterceptors()).toBe(before + 1)

    delete process.env.HTTPS_PROXY
    configureGlobalAgents()
    expect(liveInterceptors()).toBe(before)
    const cfg = await capturedConfig(axios, 'https://api.example.com/x')
    expect(cfg.httpsAgent).toBeUndefined()
    expect(axios.defaults.proxy).toBeUndefined()
  })

  test('no proxy + mTLS: mTLS agent as axios default; under Bun no global dispatcher', () => {
    setMTLSEnv()
    configureGlobalAgents()
    expect(axios.defaults.httpsAgent).toBe(getMTLSAgent())
    expect(axios.defaults.httpAgent).toBeUndefined()
    expect(axios.defaults.proxy).toBeUndefined()
    // getTLSFetchOptions returns {tls} under Bun, so there is no dispatcher
    // to install.
    expect(setGlobal).not.toHaveBeenCalled()
  })
})

describe('getAWSClientProxyConfig', () => {
  test('no proxy → empty object', async () => {
    expect(await getAWSClientProxyConfig()).toEqual({})
  })

  test('proxy → NodeHttpHandler on one HttpsProxyAgent, plus a credential provider', async () => {
    process.env.HTTPS_PROXY = PROXY
    setMTLSEnv()
    const cfg = (await getAWSClientProxyConfig()) as {
      requestHandler: { configProvider: Promise<Record<string, unknown>> }
      credentials: unknown
    }
    expect(Object.keys(cfg).sort()).toEqual(['credentials', 'requestHandler'])
    expect(typeof cfg.credentials).toBe('function')
    const resolved = (await cfg.requestHandler.configProvider) as {
      httpsAgent: unknown
      httpAgentProvider: () => Promise<unknown>
    }
    expect(resolved.httpsAgent).toBeInstanceOf(HttpsProxyAgent)
    // smithy resolves the http agent lazily; it is the same proxy agent.
    expect(await resolved.httpAgentProvider()).toBe(resolved.httpsAgent)
    expect(connectOptsOf(resolved.httpsAgent).passphrase).toBe('pp')
  })
})

describe('clearProxyCache', () => {
  test('drops memoized proxy agents', () => {
    const a = getProxyAgent(PROXY)
    clearProxyCache()
    expect(getProxyAgent(PROXY)).not.toBe(a)
  })
})
