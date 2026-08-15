import type { Framework, TestFailure } from 'src/tools/RunTestsTool/types.js'

/**
 * Best-effort `file:line` extraction from a stack trace / failure body, for the
 * common case where a reporter gives us only the test name (or the test file)
 * but the actual failing line lives in the trace.
 *
 * We collect every candidate frame across the JS/Python/Rust/PHP/generic
 * formats, then prefer a frame that points at *project* source over one in a
 * dependency / stdlib directory.
 */

// Node/V8: `at fn (/abs/file.ts:12:5)` and `at /abs/file.ts:12:5`
const JS_FRAME_RE = /at\s+(?:.*?\()?(?:file:\/\/)?((?:[A-Za-z]:)?[\w./\\-]+\.[cm]?[jt]sx?):(\d+):\d+/g
// Python: `File "path/to/file.py", line 12, in test_foo`
const PY_FRAME_RE = /File\s+"([^"]+\.py)",\s+line\s+(\d+)/g
// JVM: `at com.foo.Bar.method(Bar.java:42)` / Kotlin `(Bar.kt:12)` / Scala `.scala`
const JVM_FRAME_RE = /at\s+[\w.$<>]+\(([\w$]+\.(?:java|kt|kts|scala|groovy)):(\d+)\)/g
// Dart: `test/foo_test.dart 12:34   main.<fn>` — location is `path.dart LINE:COL`
// (whitespace-separated, so the generic `path:line` form never matches it).
const DART_FRAME_RE = /([\w./\\-]+\.dart)\s+(\d+):\d+/g
// C/C++: `/path/foo_test.cpp:42` (also .cc/.cxx/.c/.h/.hpp/.hxx)
const CPP_FRAME_RE = /([\w./\\-]+\.(?:c|cc|cpp|cxx|h|hpp|hxx)):(\d+)/g
// Rust/generic panic: `at src/lib.rs:42:9`
const RUST_FRAME_RE = /(?:panicked at|at)\s+([\w./\\-]+\.rs):(\d+)(?::\d+)?/g
// PHP: `/path/file.php:12`
const PHP_FRAME_RE = /([\w./\\-]+\.php):(\d+)/g
// Last-ditch generic `path.ext:line`
const GENERIC_FRAME_RE = /([\w./\\-]+\.\w{1,5}):(\d+)(?::\d+)?/g

const DEP_DIR_RE = /(?:node_modules|site-packages|dist-packages|\/usr\/|vendor\/|\.cargo\/|dist\/|\/std\/)/

type Frame = { file: string; line: number }

function collect(re: RegExp, text: string): Frame[] {
  const frames: Frame[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    frames.push({ file: m[1], line: Number.parseInt(m[2], 10) })
  }
  return frames
}

export function extractFileLine(text: string): Frame | undefined {
  if (!text) return undefined
  const frames = [
    ...collect(JS_FRAME_RE, text),
    ...collect(PY_FRAME_RE, text),
    ...collect(JVM_FRAME_RE, text),
    ...collect(DART_FRAME_RE, text),
    ...collect(CPP_FRAME_RE, text),
    ...collect(RUST_FRAME_RE, text),
    ...collect(PHP_FRAME_RE, text),
  ]
  const pool = frames.length > 0 ? frames : collect(GENERIC_FRAME_RE, text)
  if (pool.length === 0) return undefined

  // Prefer the first project-local frame; else the first frame overall.
  const projectFrame = pool.find(f => !DEP_DIR_RE.test(f.file))
  return projectFrame ?? pool[0]
}

/** Fill in file/line on failures that lack them, mining the diff then message. */
export function enrichFailuresWithStackLocation(failures: TestFailure[]): void {
  for (const f of failures) {
    if (f.file && f.line) continue
    const loc = extractFileLine(f.diff ?? '') ?? extractFileLine(f.message)
    if (loc) {
      f.file = f.file ?? loc.file
      f.line = f.line ?? loc.line
    }
  }
}

/** Last project-local frame in `text` whose file matches `file` (by suffix). */
function lastFrameLineForFile(text: string, file: string): number | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/')
  const target = norm(file)
  for (const re of [
    JS_FRAME_RE,
    PY_FRAME_RE,
    JVM_FRAME_RE,
    DART_FRAME_RE,
    CPP_FRAME_RE,
    RUST_FRAME_RE,
    PHP_FRAME_RE,
  ]) {
    let found: number | undefined
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (!DEP_DIR_RE.test(m[1]) && norm(m[1]).endsWith(target)) {
        found = Number.parseInt(m[2], 10)
      }
    }
    if (found) return found
  }
  return undefined
}

/**
 * bun emits an EMPTY `<failure/>` in JUnit XML — the `file`/`line` we have is
 * the test *declaration* line, and the real assertion line lives only in the
 * text stdout. Refine each failure's line from the stack frame that stdout
 * prints for its test, attributing by bun's `(fail) <name>` marker so multiple
 * failures in the same file each get their own frame.
 *
 * Gated to bun: every other JUnit reporter already emits the real assertion
 * line, so for them this whole-stdout frame scan is pure waste (O(failures ×
 * frame-regexes × stdout)) and its bun-specific markers would never match,
 * silently rescoping to the entire stdout and risking a mis-attributed frame.
 */
export function refineFailureLinesFromStdout(
  failures: TestFailure[],
  stdout: string,
  framework: Framework,
): void {
  if (framework !== 'bun' || !stdout) return
  for (const f of failures) {
    if (!f.file) continue
    const short = f.name.includes(' › ') ? f.name.slice(f.name.lastIndexOf(' › ') + 3) : f.name
    // Scope to the region before this test's failure marker so a same-file
    // sibling's frame isn't picked up. Fall back to the whole stdout.
    let scope = stdout
    for (const marker of [`(fail) ${short}`, `✗ ${short}`]) {
      const idx = stdout.indexOf(marker)
      if (idx > 0) {
        scope = stdout.slice(0, idx)
        break
      }
    }
    const line = lastFrameLineForFile(scope, f.file)
    if (line) f.line = line
  }
}
