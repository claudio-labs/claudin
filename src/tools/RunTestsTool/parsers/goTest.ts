import type { ParseInput, TestFailure, TestResult } from '../types.js'

/**
 * Parser for `go test -json` — newline-delimited JSON events. Go has no useful
 * JUnit output natively, so JSON is the right structured target here. We
 * aggregate per-test pass/fail/skip and pull `file:line` from the captured
 * output (`foo_test.go:12: ...`).
 */

type GoEvent = {
  Action: string
  Package?: string
  Test?: string
  Output?: string
  Elapsed?: number
}

const GO_FILE_LINE_RE = /([\w./\\-]+_test\.go):(\d+):/

export function parseGoJson(
  input: ParseInput,
  command: string,
): TestResult | null {
  const text = input.reportContent ?? input.stdout
  if (!/"Action"\s*:/.test(text)) return null

  const outputs = new Map<string, string[]>()
  const status = new Map<string, 'pass' | 'fail' | 'skip'>()
  let durationMs: number | undefined

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let ev: GoEvent
    try {
      ev = JSON.parse(line) as GoEvent
    } catch {
      continue
    }
    if (!ev.Test) {
      // Package-level pass/fail carries total elapsed.
      if ((ev.Action === 'pass' || ev.Action === 'fail') && ev.Elapsed) {
        durationMs = (durationMs ?? 0) + ev.Elapsed * 1000
      }
      continue
    }
    const key = `${ev.Package ?? ''}.${ev.Test}`
    if (ev.Action === 'output' && ev.Output) {
      const arr = outputs.get(key) ?? []
      arr.push(ev.Output)
      outputs.set(key, arr)
    } else if (ev.Action === 'pass') {
      status.set(key, 'pass')
    } else if (ev.Action === 'fail') {
      status.set(key, 'fail')
    } else if (ev.Action === 'skip') {
      status.set(key, 'skip')
    }
  }

  if (status.size === 0) return null

  let passed = 0
  let failed = 0
  let skipped = 0
  const failures: TestFailure[] = []

  for (const [key, st] of status) {
    if (st === 'pass') passed++
    else if (st === 'skip') skipped++
    else {
      failed++
      const body = (outputs.get(key) ?? []).join('')
      const fl = GO_FILE_LINE_RE.exec(body)
      const name = key.replace(/^.*\./, '')
      const firstMeaningful =
        body
          .split('\n')
          .map(l => l.trim())
          .find(l => l && !/^(===|---)\s/.test(l)) ?? 'Test failed'
      failures.push({
        name,
        file: fl?.[1],
        line: fl ? Number.parseInt(fl[2], 10) : undefined,
        message: firstMeaningful,
        diff: body.trim() || undefined,
      })
    }
  }

  return {
    framework: 'go',
    command,
    total: passed + failed + skipped,
    passed,
    failed,
    skipped,
    durationMs,
    failures,
    degraded: false,
    exitCode: input.exitCode,
  }
}
