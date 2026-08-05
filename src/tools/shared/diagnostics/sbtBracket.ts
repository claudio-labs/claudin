import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from './types.js'

/**
 * The severity-prefixed lines sbt and mill print around scalac:
 *
 *   [error] /p/src/main/scala/Foo.scala:12:5: not found: value bar
 *   [warn] /p/src/main/scala/Foo.scala:3:1: unused import
 *   [error] -- [E006] Not Found Error: /p/Foo.scala:12:4 ------------
 *
 * The prefix is why this cannot be left to `gnuStyle`: that parser's file group
 * accepts spaces, so `[error] /p/Foo.scala:12:5: msg` matches it with the file
 * captured as `[error] /p/Foo.scala` — a path that resolves to nothing and an
 * excerpt that never loads. Running this one first is what keeps that from
 * happening.
 *
 * The extension is required. sbt puts the same prefix on `[error] Total time:
 * 3 s` and `[error] (Compile / compileIncremental) Compilation failed`, which
 * are the build talking about itself; those belong to the failure block, not to
 * the diagnostic list.
 */

const SOURCE_EXT = String.raw`\.(?:scala|sc|java)`

/** Scala 2 / mill / javac-through-sbt. */
const CLASSIC_RE = new RegExp(
  String.raw`^\[(?<sev>error|warn(?:ing)?)\]\s+(?<file>\S*${SOURCE_EXT}):(?<line>\d+)(?::(?<col>\d+))?:\s*(?<msg>.+)$`,
)

/**
 * Scala 3 heads the block with the error class and puts the message body in the
 * following `[error] 12 |…` lines. The class ("Not Found Error") is what this
 * keeps: it is a real description of the diagnostic, and reassembling the body
 * would mean tracking box-drawing continuation lines for no added meaning.
 */
const SCALA3_RE = new RegExp(
  String.raw`^\[(?<sev>error|warn(?:ing)?)\]\s+--\s+(?:\[(?<code>E\d+)\]\s*)?(?<kind>[^:]+?):\s*(?<file>\S*${SOURCE_EXT}):(?<line>\d+):(?<col>\d+)\s*-*\s*$`,
)

function severityOf(word: string | undefined): 'error' | 'warning' {
  return word === 'error' ? 'error' : 'warning'
}

export function parseSbtBracket(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []

  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    const scala3 = SCALA3_RE.exec(line)
    if (scala3?.groups) {
      const g = scala3.groups
      diagnostics.push({
        file: g.file!,
        line: Number(g.line),
        column: Number(g.col),
        severity: severityOf(g.sev),
        code: g.code,
        message: g.kind!.trim(),
      })
      continue
    }

    const classic = CLASSIC_RE.exec(line)
    if (!classic?.groups) continue
    const g = classic.groups
    diagnostics.push({
      file: g.file!,
      line: Number(g.line),
      column: g.col ? Number(g.col) : undefined,
      severity: severityOf(g.sev),
      message: g.msg!.trim(),
    })
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
