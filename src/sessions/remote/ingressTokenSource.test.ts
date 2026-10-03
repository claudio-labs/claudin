/**
 * What the characterization suite cannot reach of the on-disk ingress token:
 * the CCR copy for subprocesses (it would write under /home/claude), the
 * macOS/FreeBSD descriptor path (the platform is fixed per process), and the
 * debug lines that must never carry the token.
 */
import { describe, expect, test } from 'bun:test'
import { CCR_SESSION_INGRESS_TOKEN_PATH } from 'src/providers/auth/authFileDescriptor.js'
import {
  type IngressTokenLocation,
  type IngressTokenSourceDeps,
  readIngressTokenFromDisk,
} from 'src/sessions/remote/ingressTokenSource.js'

type Recorded = {
  deps: IngressTokenSourceDeps
  textReads: string[]
  fileReads: string[]
  copies: string[]
  debug: string[]
}

function makeDeps(opts: {
  platform?: NodeJS.Platform
  texts?: Record<string, string>
  files?: Record<string, string>
}): Recorded {
  const rec: Omit<Recorded, 'deps'> = { textReads: [], fileReads: [], copies: [], debug: [] }
  const deps: IngressTokenSourceDeps = {
    platform: opts.platform ?? 'linux',
    readText: path => {
      rec.textReads.push(path)
      const text = opts.texts?.[path]
      if (text === undefined) throw new Error(`ENXIO: ${path}`)
      return text
    },
    readTokenFile: path => {
      rec.fileReads.push(path)
      return opts.files?.[path]?.trim() || null
    },
    keepCopyForSubprocesses: token => rec.copies.push(token),
    debug: line => rec.debug.push(line),
  }
  return { ...rec, deps }
}

const where = (descriptor?: string, tokenFile?: string): IngressTokenLocation => ({ descriptor, tokenFile })

describe('the descriptor path follows the platform', () => {
  // BSD-family kernels expose descriptors under /dev/fd; everything else is read through procfs.
  const bsdFamily: NodeJS.Platform[] = ['darwin', 'freebsd']
  const procfsFamily: NodeJS.Platform[] = ['linux', 'win32']
  const cases = [
    ...procfsFamily.map(platform => [platform, '/proc/self/fd/7'] as const),
    ...bsdFamily.map(platform => [platform, '/dev/fd/7'] as const),
  ]
  test.each(cases)('%s reads %s', (platform, path) => {
    const rec = makeDeps({ platform, texts: { [path]: ' tok \n' } })
    expect(readIngressTokenFromDisk(where('7'), rec.deps)).toBe('tok')
    expect(rec.textReads).toEqual([path])
  })
})

describe('the copy for subprocesses', () => {
  test('a token from the descriptor is handed over for the copy', () => {
    const rec = makeDeps({ texts: { '/proc/self/fd/3': 'from-fd\n' } })
    readIngressTokenFromDisk(where('3'), rec.deps)
    expect(rec.copies).toEqual(['from-fd'])
  })

  const noCopy: Array<[string, IngressTokenLocation, Parameters<typeof makeDeps>[0]]> = [
    ['a token read from the file', where(undefined, '/t'), { files: { '/t': 'from-file' } }],
    ['the file read after an unreadable descriptor', where('3', '/t'), { files: { '/t': 'from-file' } }],
    ['an empty descriptor', where('3'), { texts: { '/proc/self/fd/3': '  \n' } }],
    ['a descriptor variable that is not a number', where('x'), {}],
  ]
  test.each(noCopy)('%s is not copied', (_name, location, opts) => {
    const rec = makeDeps(opts)
    readIngressTokenFromDisk(location, rec.deps)
    expect(rec.copies).toEqual([])
  })
})

describe('which file is the fallback', () => {
  const cases: Array<[string, IngressTokenLocation, string]> = [
    ['the well-known path by default', where(), CCR_SESSION_INGRESS_TOKEN_PATH],
    ['the override when set', where(undefined, '/custom'), '/custom'],
    ['the well-known path when the override is empty', where(undefined, ''), CCR_SESSION_INGRESS_TOKEN_PATH],
    ['the override after an unreadable descriptor', where('9', '/custom'), '/custom'],
  ]
  test.each(cases)('%s', (_name, location, path) => {
    const rec = makeDeps({})
    readIngressTokenFromDisk(location, rec.deps)
    expect(rec.fileReads).toEqual([path])
  })

  test('a descriptor variable that is not a number reads nothing at all', () => {
    const rec = makeDeps({ files: { '/t': 'tok' } })
    expect(readIngressTokenFromDisk(where('three', '/t'), rec.deps)).toBeNull()
    expect(rec.textReads).toEqual([])
    expect(rec.fileReads).toEqual([])
  })
})

test('no debug line carries the token', () => {
  const secret = 'sk-ant-sid01-secret'
  const runs: Array<[IngressTokenLocation, Parameters<typeof makeDeps>[0]]> = [
    [where('3'), { texts: { '/proc/self/fd/3': secret } }],
    [where('4', '/t'), { files: { '/t': secret } }],
  ]
  for (const [location, opts] of runs) {
    const rec = makeDeps(opts)
    expect(readIngressTokenFromDisk(location, rec.deps)).toBe(secret)
    expect(rec.debug.length).toBeGreaterThan(0)
    for (const line of rec.debug) expect(line).not.toContain(secret)
  }
})
