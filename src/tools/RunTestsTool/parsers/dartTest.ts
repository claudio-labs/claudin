import { extractFileLine } from '../stackTrace.js'
import type { ParseInput, TestFailure, TestResult } from '../types.js'

/**
 * Parser for `dart test --reporter=json` / `flutter test --machine` — the same
 * line-delimited JSON protocol on stdout. Dart has no useful JUnit output, so
 * JSON is the right structured target (mirrors `goTest.ts`).
 *
 * Events we use: `testStart` carries the `Test` object (id, name, url, line =
 * declaration site); `testDone` carries `result` (success|failure|error) plus
 * `skipped`/`hidden`; the failing `error` event carries `error` + `stackTrace`.
 * As with bun/maven, the declaration line is less useful than the assertion
 * line in the stack, so we pull `file:line` from the stack when present.
 */

type DartEvent = {
  type: string
  test?: {
    id: number
    name?: string
    url?: string
    line?: number
    root_url?: string
    root_line?: number
  }
  testID?: number
  result?: string
  skipped?: boolean
  hidden?: boolean
  error?: string
  stackTrace?: string
}

function cleanUrl(url?: string): string | undefined {
  if (!url) return undefined
  return url.replace(/^file:\/\//, '') || undefined
}

export function parseDart(input: ParseInput, command: string): TestResult | null {
  const text = input.stdout
  if (!/"type"\s*:\s*"(?:testStart|testDone|suite)"/.test(text)) return null

  const info = new Map<number, { name: string; file?: string; line?: number }>()
  const status = new Map<number, 'pass' | 'fail' | 'skip'>()
  const errors = new Map<number, string>()

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let ev: DartEvent
    try {
      ev = JSON.parse(line) as DartEvent
    } catch {
      continue
    }

    if (ev.type === 'testStart' && ev.test) {
      info.set(ev.test.id, {
        name: ev.test.name ?? 'unknown',
        file: cleanUrl(ev.test.root_url ?? ev.test.url),
        line: ev.test.root_line ?? ev.test.line,
      })
    } else if (ev.type === 'error' && ev.testID != null) {
      errors.set(ev.testID, `${errors.get(ev.testID) ?? ''}${ev.error ?? ''}\n${ev.stackTrace ?? ''}\n`)
    } else if (ev.type === 'testDone' && ev.testID != null) {
      // `hidden` entries are virtual group setUp/tearDown, not real tests.
      if (ev.hidden) continue
      if (ev.skipped) status.set(ev.testID, 'skip')
      else if (ev.result === 'success') status.set(ev.testID, 'pass')
      else status.set(ev.testID, 'fail')
    }
  }

  if (status.size === 0) return null

  let passed = 0
  let failed = 0
  let skipped = 0
  const failures: TestFailure[] = []

  for (const [id, st] of status) {
    if (st === 'pass') passed++
    else if (st === 'skip') skipped++
    else {
      failed++
      const meta = info.get(id) ?? { name: 'unknown' }
      const body = errors.get(id) ?? ''
      const loc = extractFileLine(body)
      const message =
        body
          .split('\n')
          .map(l => l.trim())
          .find(Boolean) ?? 'Test failed'
      failures.push({
        name: meta.name,
        file: meta.file ?? loc?.file,
        line: loc?.line ?? meta.line,
        message,
        diff: body.trim() || undefined,
      })
    }
  }

  return {
    framework: 'dart',
    command,
    total: passed + failed + skipped,
    passed,
    failed,
    skipped,
    failures,
    degraded: false,
    exitCode: input.exitCode,
  }
}
