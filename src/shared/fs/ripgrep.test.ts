import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import path from 'path'

import {
  classifyRipgrepFailure,
  countFilesRoundedRg,
  createRipgrepOutputBuffer,
  getRipgrepStatus,
  resolveRipgrepConfig,
  resolveVendoredRipgrepPath,
  RipgrepTimeoutError,
  ripGrep,
  ripgrepCommand,
  ripGrepStream,
  ripGrepWithStatus,
  wrapRipgrepUnavailableError,
} from 'src/shared/fs/ripgrep.js'

const MOCK_BUILTIN_PATH = path.normalize(
  process.platform === 'win32'
    ? `vendor/ripgrep/${process.arch}-win32/rg.exe`
    : `vendor/ripgrep/${process.arch}-${process.platform}/rg`,
)

test('ripgrepCommand falls back to system rg when builtin binary is missing', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: false,
    builtinCommand: MOCK_BUILTIN_PATH,
    builtinExists: false,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'system',
    command: 'rg',
    args: [],
  })
})

test('ripgrepCommand keeps builtin mode when bundled binary exists', () => {
  const config = resolveRipgrepConfig({
    userWantsSystemRipgrep: false,
    bundledMode: false,
    builtinCommand: MOCK_BUILTIN_PATH,
    builtinExists: true,
    systemExecutablePath: '/usr/bin/rg',
    processExecPath: '/fake/bun',
  })

  expect(config).toMatchObject({
    mode: 'builtin',
    command: MOCK_BUILTIN_PATH,
    args: [],
  })
})

test('getRipgrepConfig prefers the packaged @vscode/ripgrep binary when present', () => {
  // @vscode/ripgrep is a real dependency, so its per-platform prebuilt rg is in
  // node_modules during tests. getRipgrepConfig should resolve to it (builtin
  // mode, no argv0) rather than the legacy vendored path or a system rg.
  const { rgPath, argv0 } = ripgrepCommand()

  expect(argv0).toBeUndefined()
  // Assert the resolved binary is specifically the packaged one — a
  // node_modules/@vscode/ripgrep* path — not the in-tree vendored copy or a
  // system `rg` (either of which would satisfy a looser "contains ripgrep").
  expect(rgPath).toContain('node_modules')
  expect(rgPath).toContain(`@vscode${path.sep}ripgrep`)
  expect(existsSync(rgPath)).toBe(true)
})

// resolveVendoredRipgrepPath: the compiled-binary vendored-rg lookup. The
// production caller reads process.execPath directly, so these tests exercise the
// helper with a fake exec path — the only coverage of the "vendored rg beside the
// real executable" path (which the whole native-binary search relies on).
const rgRel = (plat: NodeJS.Platform, arch: string) =>
  plat === 'win32'
    ? path.join('vendor', 'ripgrep', `${arch}-win32`, 'rg.exe')
    : path.join('vendor', 'ripgrep', `${arch}-${plat}`, 'rg')

test('resolveVendoredRipgrepPath finds rg beside the executable (not moduleDir)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-exec-'))
  try {
    const binDir = path.join(tmp, 'binroot')
    const rg = path.join(binDir, rgRel(process.platform, process.arch))
    mkdirSync(path.dirname(rg), { recursive: true })
    writeFileSync(rg, '')
    const execPath = path.join(binDir, 'claudin')
    writeFileSync(execPath, '')

    const res = resolveVendoredRipgrepPath(path.join(tmp, 'nowhere'), execPath)
    expect(res.exists).toBe(true)
    expect(res.command).toBe(path.resolve(rg))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveVendoredRipgrepPath resolves a symlinked execPath (npm global bin)', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-symlink-'))
  try {
    // Real package layout: <pkg>/bin/{claudin,vendor/...}. The global bin is a
    // symlink into it — realpathSync must resolve to <pkg>/bin to find vendor/.
    const pkgBin = path.join(tmp, 'node_modules', 'claudin', 'bin')
    const rg = path.join(pkgBin, rgRel(process.platform, process.arch))
    mkdirSync(path.dirname(rg), { recursive: true })
    writeFileSync(rg, '')
    const realBinary = path.join(pkgBin, 'claudin.exe')
    writeFileSync(realBinary, '')

    const globalBin = path.join(tmp, 'globalbin')
    mkdirSync(globalBin, { recursive: true })
    const link = path.join(globalBin, 'claudin')
    symlinkSync(realBinary, link)

    const res = resolveVendoredRipgrepPath(path.join(tmp, 'nowhere'), link)
    expect(res.exists).toBe(true)
    expect(res.command).toBe(path.resolve(rg))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolveVendoredRipgrepPath reports exists=false when neither root has rg', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-missing-'))
  try {
    const execPath = path.join(tmp, 'bin', 'claudin')
    mkdirSync(path.dirname(execPath), { recursive: true })
    writeFileSync(execPath, '')
    const res = resolveVendoredRipgrepPath(path.join(tmp, 'moduledir'), execPath)
    expect(res.exists).toBe(false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('wrapRipgrepUnavailableError explains missing packaged fallback', () => {
  const error = wrapRipgrepUnavailableError(
    { code: 'ENOENT', message: 'spawn rg ENOENT' },
    { mode: 'builtin', command: 'C:\\fake\\vendor\\ripgrep\\rg.exe', args: [] },
    'win32',
  )

  expect(error.name).toBe('RipgrepUnavailableError')
  expect(error.code).toBe('ENOENT')
  expect(error.message).toContain('packaged ripgrep fallback')
  expect(error.message).toContain('winget install BurntSushi.ripgrep.MSVC')
})

test('wrapRipgrepUnavailableError explains missing system ripgrep', () => {
  const error = wrapRipgrepUnavailableError(
    { code: 'ENOENT', message: 'spawn rg ENOENT' },
    { mode: 'system', command: 'rg', args: [] },
    'linux',
  )

  expect(error.message).toContain('system ripgrep binary was not found on PATH')
  expect(error.message).toContain('apt install ripgrep')
})

// ---------------------------------------------------------------------------
// classifyRipgrepFailure — telling "found nothing" apart from "never looked".
//
// Every case below is a real code/signal/stderr combination ripgrep produces
// (captured from rg 15.2.0), none of which can be triggered on demand from a
// live run, which is why the classifier is pure.
// ---------------------------------------------------------------------------

test('classifyRipgrepFailure reports a killed search as an incomplete one', () => {
  expect(
    classifyRipgrepFailure({
      code: undefined,
      signal: 'SIGTERM',
      stdout: 'src/a.ts:1:hit\nsrc/b.ts:2:hit\n',
      stderr: '',
    }),
  ).toEqual({ incomplete: 'timeout', usageError: null })

  expect(
    classifyRipgrepFailure({
      code: undefined,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
    }).incomplete,
  ).toBe('timeout')
})

test('classifyRipgrepFailure separates a caller abort from a timeout', () => {
  // Both cut the search short, but only one of them is a problem worth
  // reporting — interactive callers abort on every keystroke.
  expect(
    classifyRipgrepFailure({
      code: 'ABORT_ERR',
      signal: 'SIGTERM',
      stdout: 'src/a.ts:1:hit\n',
      stderr: '',
    }),
  ).toEqual({ incomplete: 'aborted', usageError: null })
})

test('classifyRipgrepFailure reports a buffer overflow as incomplete', () => {
  expect(
    classifyRipgrepFailure({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      signal: undefined,
      stdout: 'src/a.ts:1:hit\n',
      stderr: '',
    }),
  ).toEqual({ incomplete: 'buffer', usageError: null })
})

test.each([
  ['an unrecognized flag', 'rg: unrecognized flag --bogus-flag\n'],
  [
    'an unknown encoding label',
    'rg: error parsing flag --encoding: grep config error: unknown encoding: utf16\n',
  ],
  [
    'an invalid regex',
    'rg: regex parse error:\n    (?:[a-)\n        ^^^\nerror: invalid character class range, the start must be <= the end\n',
  ],
  ['an unknown file type', 'rg: unrecognized file type: nosuchtype\n'],
])('classifyRipgrepFailure surfaces %s as a usage error', (_name, stderr) => {
  const result = classifyRipgrepFailure({
    code: 2,
    signal: undefined,
    stdout: '',
    stderr,
  })
  expect(result.incomplete).toBeNull()
  expect(result.usageError).toBe(stderr.trim())
})

test('classifyRipgrepFailure does NOT call an unreadable directory a usage error', () => {
  // The case that rules out matching on the message shape: ripgrep exits 2 with
  // stderr and no stdout here too, but the search itself ran to completion and
  // genuinely found nothing. Reporting it as a usage error would turn an
  // ordinary search of a tree with one locked directory into an error.
  expect(
    classifyRipgrepFailure({
      code: 2,
      signal: undefined,
      stdout: '',
      stderr: 'rg: /tmp/locked: Permission denied (os error 13)\n',
    }),
  ).toEqual({ incomplete: null, usageError: null })
})

test('classifyRipgrepFailure keeps partial output over an I/O warning', () => {
  expect(
    classifyRipgrepFailure({
      code: 2,
      signal: undefined,
      stdout: '/tmp/ok.txt:ZQPROBE\n',
      stderr: 'rg: /tmp/locked: Permission denied (os error 13)\n',
    }),
  ).toEqual({ incomplete: null, usageError: null })
})

// ---------------------------------------------------------------------------
// createRipgrepOutputBuffer — the chunk-boundary decode.
// ---------------------------------------------------------------------------

test('createRipgrepOutputBuffer decodes a character split across two chunks', () => {
  // 'é' is 0xC3 0xA9. Node splits stdout at arbitrary byte offsets, so the
  // continuation byte can land in the next chunk; decoding each chunk on its
  // own yields U+FFFD in place of the character.
  const bytes = Buffer.from('café', 'utf8')
  const buffer = createRipgrepOutputBuffer()
  buffer.write(bytes.subarray(0, 4)) // 'caf' + the lead byte of 'é'
  buffer.write(bytes.subarray(4)) // the continuation byte

  expect(buffer.end()).toBe('café')
})

test('createRipgrepOutputBuffer handles a 4-byte character split three ways', () => {
  const bytes = Buffer.from('🙂', 'utf8')
  expect(bytes.length).toBe(4)
  const buffer = createRipgrepOutputBuffer()
  buffer.write(bytes.subarray(0, 1))
  buffer.write(bytes.subarray(1, 3))
  buffer.write(bytes.subarray(3))

  expect(buffer.end()).toBe('🙂')
})

test('createRipgrepOutputBuffer stops accumulating once the cap is reached', () => {
  const buffer = createRipgrepOutputBuffer(8)
  buffer.write(Buffer.from('123456789012', 'utf8'))
  buffer.write(Buffer.from('and more', 'utf8'))

  expect(buffer.end()).toBe('12345678')
})

// ---------------------------------------------------------------------------
// ripGrepWithStatus — end to end against the real ripgrep binary.
// ---------------------------------------------------------------------------

test('ripGrepWithStatus reports an invalid regex instead of "no matches"', async () => {
  const result = await ripGrepWithStatus(
    ['--no-messages', '[a-'],
    process.cwd(),
    new AbortController().signal,
  )

  expect(result.lines).toEqual([])
  expect(result.usageError).toContain('regex parse error')
  expect(result.incomplete).toBeNull()
})

test('ripGrepWithStatus reports an unknown encoding label', async () => {
  const result = await ripGrepWithStatus(
    ['--encoding', 'utf16', 'anything'],
    process.cwd(),
    new AbortController().signal,
  )

  expect(result.usageError).toContain('unknown encoding')
})

test('ripGrepWithStatus leaves a completed search unmarked', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-status-'))
  try {
    writeFileSync(path.join(tmp, 'hit.txt'), 'ZQPROBE\n')
    const found = await ripGrepWithStatus(
      ['-l', 'ZQPROBE'],
      tmp,
      new AbortController().signal,
    )
    expect(found.lines.length).toBe(1)
    expect(found).toMatchObject({ incomplete: null, usageError: null })

    // The genuine no-match case must stay distinguishable from both of the above.
    const missing = await ripGrepWithStatus(
      ['-l', 'NOTHINGMATCHESTHIS'],
      tmp,
      new AbortController().signal,
    )
    expect(missing).toEqual({ lines: [], incomplete: null, usageError: null })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('ripGrepWithStatus strips the CR a CRLF file leaves on each line', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-crlf-'))
  try {
    writeFileSync(path.join(tmp, 'win.txt'), 'one ZQPROBE\r\ntwo ZQPROBE\r\n')
    const { lines } = await ripGrepWithStatus(
      ['--no-filename', 'ZQPROBE'],
      path.join(tmp, 'win.txt'),
      new AbortController().signal,
    )
    expect(lines).toEqual(['one ZQPROBE', 'two ZQPROBE'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('ripGrepWithStatus throws a timeout error for a search stopped before any line', async () => {
  // An aborted run and a timed-out one both read "did not finish"; with no
  // line to show, the caller has to hear that rather than "no matches".
  const controller = new AbortController()
  controller.abort()
  const error = await ripGrepWithStatus(['-l', 'ZQPROBE'], process.cwd(), controller.signal).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(RipgrepTimeoutError)
  expect((error as RipgrepTimeoutError).name).toBe('RipgrepTimeoutError')
  expect((error as RipgrepTimeoutError).partialResults).toEqual([])
})

test('ripGrep returns the lines alone', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-lines-'))
  try {
    writeFileSync(path.join(tmp, 'a.txt'), 'ZQPROBE\n')
    expect(await ripGrep(['-c', 'ZQPROBE'], path.join(tmp, 'a.txt'), new AbortController().signal)).toEqual(['1'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('ripGrepStream hands over every line, the last one without its newline too', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-stream-'))
  try {
    for (let i = 0; i < 3; i++) writeFileSync(path.join(tmp, `f${i}.txt`), 'x')
    const seen: string[] = []
    await ripGrepStream(['--files', '--sort=path'], tmp, new AbortController().signal, lines =>
      seen.push(...lines),
    )
    expect(seen.map(l => path.basename(l))).toEqual(['f0.txt', 'f1.txt', 'f2.txt'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('ripGrepStream rejects an invocation ripgrep refuses', async () => {
  await expect(
    ripGrepStream(['[a-'], process.cwd(), new AbortController().signal, () => {}),
  ).rejects.toThrow('ripgrep exited with code 2')
})

test('countFilesRoundedRg keeps one significant digit, and skips the home directory', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'rg-count-'))
  const empty = mkdtempSync(path.join(tmpdir(), 'rg-count-empty-'))
  try {
    for (let i = 0; i < 40; i++) writeFileSync(path.join(tmp, `f${i}.txt`), 'x')
    mkdirSync(path.join(tmp, 'skip'))
    for (let i = 0; i < 5; i++) writeFileSync(path.join(tmp, 'skip', `s${i}.txt`), 'x')
    const signal = new AbortController().signal
    expect(await countFilesRoundedRg(tmp, signal)).toBe(50)
    // The ignore list is part of the cache key, so this is a second count.
    expect(await countFilesRoundedRg(tmp, signal, ['skip'])).toBe(40)
    expect(await countFilesRoundedRg(empty, signal)).toBe(0)
    expect(await countFilesRoundedRg(homedir(), signal)).toBeUndefined()
    // A path ripgrep cannot walk is logged and counts as unknown.
    expect(await countFilesRoundedRg(path.join(tmp, 'missing'), signal)).toBeUndefined()
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test('getRipgrepStatus reports the resolved binary', () => {
  const status = getRipgrepStatus()
  expect(status.path).toBe(ripgrepCommand().rgPath)
  expect(['system', 'builtin', 'embedded']).toContain(status.mode)
  expect(status.working === null || typeof status.working === 'boolean').toBe(true)
})
