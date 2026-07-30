import type { ParseInput, TestFailure, TestResult } from '../types.js'

/**
 * Parser for `cargo test` / `cargo nextest` libtest text output. Structured
 * JSON is nightly-only, so we parse the stable text: per-test `... ok/FAILED`
 * lines, the `---- <name> stdout ----` failure blocks, and the panic location
 * (`panicked at <file>:<line>:<col>`) for file:line.
 */

const CARGO_RESULT_RE =
  /test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+(?:ignored|skipped)/gi
const CARGO_TEST_LINE_RE = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED|ignored)\b/
const CARGO_FAILURE_BLOCK_RE =
  /----\s+(\S+)\s+stdout\s+----\n([\s\S]*?)(?=\n----\s|\nfailures:|\ntest result:|$)/g
const PANIC_LOC_RE = /panicked at\s+([\w./\\-]+):(\d+):\d+/

/**
 * cargo prints ONE `test result:` line per test BINARY, and a Rust project
 * always has several — the lib's `unittests` target, one per file under
 * `tests/`, then `Doc-tests` — plus one per crate under `--workspace`. Reading
 * only the first reported whichever binary ran first, normally the empty lib
 * target, so a run of 1 passed + 1 failed rendered as "0 passed (0 total)" with
 * the failure listed right below it. Sum every line instead.
 *
 * `matchAll` (unlike `test`/`exec`) does not advance the shared regex's
 * lastIndex, so this stays correct across calls even though the regex is /g.
 */
function sumResultLines(
  text: string,
): { passed: number; failed: number; skipped: number } | null {
  let found = false
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const m of text.matchAll(CARGO_RESULT_RE)) {
    found = true
    passed += Number.parseInt(m[1], 10)
    failed += Number.parseInt(m[2], 10)
    skipped += Number.parseInt(m[3], 10)
  }
  return found ? { passed, failed, skipped } : null
}

export function parseCargo(input: ParseInput, command: string): TestResult | null {
  const text = `${input.stdout}\n${input.stderr}`
  const summary = sumResultLines(text)
  if (!summary && !CARGO_TEST_LINE_RE.test(text)) return null

  // Failure detail blocks keyed by test name.
  const blocks = new Map<string, string>()
  CARGO_FAILURE_BLOCK_RE.lastIndex = 0
  let bm: RegExpExecArray | null
  while ((bm = CARGO_FAILURE_BLOCK_RE.exec(text)) !== null) {
    blocks.set(bm[1], bm[2].trim())
  }

  const failures: TestFailure[] = []
  for (const line of text.split('\n')) {
    const m = CARGO_TEST_LINE_RE.exec(line.trim())
    if (!m || m[2] !== 'FAILED') continue
    const name = m[1]
    const body = blocks.get(name) ?? ''
    const loc = PANIC_LOC_RE.exec(body)
    const firstMsg =
      body
        .split('\n')
        .map(l => l.trim())
        .find(l => l && !l.startsWith('panicked at')) ?? 'Test failed'
    failures.push({
      name,
      file: loc?.[1],
      line: loc ? Number.parseInt(loc[2], 10) : undefined,
      message: firstMsg,
      diff: body || undefined,
    })
  }

  const passed = summary?.passed ?? 0
  const failed = summary?.failed ?? failures.length
  const skipped = summary?.skipped ?? 0

  return {
    framework: 'cargo',
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
