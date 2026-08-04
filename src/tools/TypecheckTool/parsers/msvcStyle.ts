import type { ParseInput, ParsedDiagnostics, RawDiagnostic } from '../types.js'

/**
 * The parenthesised position format shared by TypeScript and MSBuild:
 *
 *   src/a.ts(23,5): error TS2322: Type 'string' is not assignable to 'number'.
 *   /p/Program.cs(12,20): error CS0103: The name 'x' does not exist [/p/x.csproj]
 *
 * tsc emits it under `--pretty false`, and chains related explanations on
 * INDENTED continuation lines beneath the header:
 *
 *   c.ts(2,7): error TS2322: Type '(a: number) => void' is not assignable …
 *     Types of parameters 'a' and 'a' are incompatible.
 *       Type 'string' is not assignable to type 'number'.
 *
 * Those lines are part of the diagnostic, so they are folded into `message`.
 * A non-indented line that does not match the header is dropped, which is what
 * keeps a package manager's command echo (`$ tsc --noEmit --pretty false`) out
 * of the previous diagnostic's message.
 */

const HEADER_RE =
  /^(?<file>[^(\n]+?)\((?<line>\d+)(?:,(?<col>\d+))?\):\s*(?<sev>error|warning)\s+(?<code>[A-Za-z]+\d+):\s*(?<msg>.*)$/

/**
 * tsc's DEFAULT (pretty) layout, which reaches us whenever the compact flag
 * could not be injected — a composed `typecheck` script, or a command the user
 * passed verbatim:
 *
 *   src/a.ts:23:5 - error TS2322: Type 'string' is not assignable …
 */
const PRETTY_RE =
  /^(?<file>[^\s(][^\n]*?):(?<line>\d+):(?<col>\d+)\s+-\s+(?<sev>error|warning)\s+(?<code>TS\d+):\s*(?<msg>.*)$/

/** MSBuild appends the owning project in brackets; it repeats per diagnostic. */
const MSBUILD_PROJECT_SUFFIX_RE = /\s*\[[^\]]*\.(?:cs|fs|vb|sln)proj\]\s*$/i

const CONTINUATION_RE = /^\s+\S/

export function parseMsvcStyle(input: ParseInput): ParsedDiagnostics {
  const diagnostics: RawDiagnostic[] = []
  let current: RawDiagnostic | null = null

  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    const match = HEADER_RE.exec(line) ?? PRETTY_RE.exec(line)
    if (match?.groups) {
      const g = match.groups
      current = {
        file: g.file!.trim(),
        line: Number(g.line),
        column: g.col ? Number(g.col) : undefined,
        severity: g.sev === 'warning' ? 'warning' : 'error',
        code: g.code,
        message: g.msg!.replace(MSBUILD_PROJECT_SUFFIX_RE, '').trim(),
      }
      diagnostics.push(current)
      continue
    }
    if (current && CONTINUATION_RE.test(line)) {
      current.message = `${current.message}\n${line.trimEnd()}`
      continue
    }
    // Any other line ends the diagnostic — including the BLANK one pretty mode
    // puts between a header and its code preview. That blank line is
    // load-bearing: tsc right-aligns line numbers, so a two-digit line in a
    // file with three-digit lines prints as `  9     count: …`, which is
    // indented and otherwise indistinguishable from a chained explanation.
    // Compact mode emits no blank lines, so its chains still attach.
    current = null
  }

  return diagnostics.length > 0 ? { diagnostics } : null
}
