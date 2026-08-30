import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { extractLogErrors } from 'src/containers/diagnostics/extractLogErrors.js'

const FIXTURES = resolve(import.meta.dir, '__fixtures__')
const fixture = (name: string): string =>
  readFileSync(resolve(FIXTURES, name), 'utf8')

describe('empty and unreadable logs', () => {
  test('an empty log from a dead container says it died before writing', () => {
    const out = extractLogErrors('', { containerState: 'exited' })
    expect(out.kind).toBe('empty')
    if (out.kind === 'empty') expect(out.reason).toBe('died-before-writing')
  })

  test('an empty log from a live container is merely quiet', () => {
    const out = extractLogErrors('   \n\n', { containerState: 'running' })
    expect(out.kind).toBe('empty')
    if (out.kind === 'empty') expect(out.reason).toBe('never-wrote')
  })

  test('an unreadable driver is not reported as no errors', () => {
    const out = extractLogErrors(
      'Error response from daemon: configured logging driver does not support reading',
    )
    expect(out.kind).toBe('driver-unreadable')
  })

  test('a log with nothing wrong is no-errors, not empty', () => {
    const out = extractLogErrors('INFO ready\nINFO listening on 8000\n')
    expect(out.kind).toBe('no-errors')
    if (out.kind === 'no-errors') expect(out.totalLines).toBe(2)
  })
})

describe('multi-line traces stay whole', () => {
  test('a Python traceback keeps every frame and its exception line', () => {
    const out = extractLogErrors(fixture('python-traceback.txt'))
    expect(out.kind).toBe('errors')
    if (out.kind !== 'errors') return
    const trace = out.blocks.find(b => b.kind === 'python-traceback')
    expect(trace).toBeDefined()
    const text = trace?.lines.join('\n') ?? ''
    expect(text).toContain('Traceback (most recent call last):')
    expect(text).toContain('routing.py", line 693')
    expect(text).toContain('db.py", line 31')
    // The exception line terminates the block and must be inside it.
    expect(text).toContain('RuntimeError: database is not reachable')
    // …and the unrelated line after it must not be.
    expect(text).not.toContain('Application startup failed')
  })

  test('a Go panic keeps the signal line and the goroutine frames', () => {
    const out = extractLogErrors(fixture('go-panic.txt'))
    expect(out.kind).toBe('errors')
    if (out.kind !== 'errors') return
    const panic = out.blocks.find(b => b.kind === 'go-panic')
    const text = panic?.lines.join('\n') ?? ''
    expect(text).toContain('panic: runtime error')
    expect(text).toContain('[signal SIGSEGV')
    expect(text).toContain('goroutine 1 [running]')
    expect(text).toContain('resolver.go:118')
    expect(text).toContain('main.main()')
    expect(text).toContain('exit status 2')
  })

  test('a Java exception keeps its at-frames and the Caused by chain', () => {
    const out = extractLogErrors(fixture('java-exception.txt'))
    expect(out.kind).toBe('errors')
    if (out.kind !== 'errors') return
    const ex = out.blocks.find(b => b.kind === 'java-exception')
    const text = ex?.lines.join('\n') ?? ''
    expect(text).toContain('IllegalStateException')
    expect(text).toContain('DataSourceFactory.java:41')
    expect(text).toContain('Caused by: java.lang.NullPointerException')
    expect(text).toContain('... 2 more')
    // The INFO lines before it are not part of the block.
    expect(text).not.toContain('reading configuration')
  })

  test('a Node stack keeps its frames and its property block', () => {
    const out = extractLogErrors(fixture('node-stack.txt'))
    expect(out.kind).toBe('errors')
    if (out.kind !== 'errors') return
    const stack = out.blocks.find(b => b.kind === 'node-stack')
    const text = stack?.lines.join('\n') ?? ''
    expect(text).toContain('ECONNREFUSED 127.0.0.1:6379')
    expect(text).toContain('TCPConnectWrap.afterConnect')
    expect(text).toContain("code: 'ECONNREFUSED'")
    expect(text.trimEnd().endsWith('}')).toBe(true)
  })
})

describe('structured logs', () => {
  test('a multi-line JSON error record keeps its lines separate', () => {
    const out = extractLogErrors(fixture('json-records.txt'))
    expect(out.kind).toBe('errors')
    if (out.kind !== 'errors') return
    const record = out.blocks.find(b => b.kind === 'json-record')
    expect(record).toBeDefined()
    // Not collapsed onto one line.
    expect((record?.lines.length ?? 0)).toBeGreaterThan(1)
    expect(record?.lines.join('\n')).toContain('"msg": "sync failed"')
  })

  test('info-level JSON records are not errors', () => {
    const out = extractLogErrors(fixture('json-records.txt'))
    if (out.kind !== 'errors') throw new Error('expected errors')
    const text = out.blocks.map(b => b.lines.join('\n')).join('\n')
    expect(text).not.toContain('server started')
    expect(text).not.toContain('retrying in 5s')
  })
})

describe('caps and counts', () => {
  test('mixed output yields one block per error, traces included', () => {
    const out = extractLogErrors(fixture('mixed-errors.txt'))
    expect(out.kind).toBe('errors')
    if (out.kind !== 'errors') return
    expect(out.blocks.filter(b => b.kind === 'error-line')).toHaveLength(3)
    expect(out.blocks.filter(b => b.kind === 'python-traceback')).toHaveLength(1)
    expect(out.droppedBlocks).toBe(0)
  })

  test('the block cap drops whole blocks and reports how many', () => {
    const out = extractLogErrors(fixture('mixed-errors.txt'), { maxBlocks: 2 })
    if (out.kind !== 'errors') throw new Error('expected errors')
    expect(out.blocks).toHaveLength(2)
    expect(out.droppedBlocks).toBe(2)
  })

  test('the cap never splits a trace in half', () => {
    const out = extractLogErrors(fixture('mixed-errors.txt'), { maxBlocks: 3 })
    if (out.kind !== 'errors') throw new Error('expected errors')
    // Whichever blocks survive, each is whole: the traceback either arrives
    // with its exception line or does not arrive at all.
    for (const b of out.blocks) {
      if (b.kind !== 'python-traceback') continue
      expect(b.lines.join('\n')).toContain('TimeoutError: sonarr did not respond')
    }
  })

  test('ANSI escapes are stripped', () => {
    const out = extractLogErrors('\u001b[31mERROR boom\u001b[0m\n')
    if (out.kind !== 'errors') throw new Error('expected errors')
    expect(out.blocks[0]?.lines[0]).toBe('ERROR boom')
  })

  test('startLine points at the real line in the input', () => {
    const out = extractLogErrors('INFO a\nINFO b\nERROR c\n')
    if (out.kind !== 'errors') throw new Error('expected errors')
    expect(out.blocks[0]?.startLine).toBe(2)
  })
})
