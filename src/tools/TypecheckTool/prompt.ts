export const TYPECHECK_TOOL_NAME = 'Typecheck'

/**
 * MUST stay invariant across projects, checkers and configuration. The tool
 * description is part of the shared system prompt, so interpolating anything
 * environment-derived here would fragment the prompt cache for every user —
 * the constraint LSPTool was rebuilt around (see the header of
 * src/tools/LSPTool/LSPTool.ts) and the one src/tools/tools.ts flags on
 * getAllBaseTools. Detection results belong in the tool RESULT, never here.
 */
export const DESCRIPTION = `Type-check the project and get back only what your changes broke, instead of raw compiler output.

Prefer this tool over Bash for \`tsc --noEmit\`, \`cargo check\`, \`pyright\`, \`mypy\` and friends: it detects the checker, runs it, and hides the diagnostics that were already there before you started. Each NEW diagnostic comes with file:line, the checker's code (TS2322, E0308, …) and a source excerpt, so you get the failing location without a follow-up Read.

How the baseline works:
- When the working tree is clean, this run's diagnostics are recorded as the project's known backlog for the current commit.
- Later runs count those but print only what is missing from the backlog — the errors you actually introduced.
- With no baseline for the current commit and uncommitted changes in the way of recording one, the last baseline from an earlier commit on this branch is used instead, and the result says how many commits behind it is.
- With no usable baseline at all, everything is reported and the result says the provenance is unknown. It never guesses.

Usage:
- Call with no arguments to auto-detect and check the current project. Auto-detected: tsc (TypeScript), deno check, cargo check (Rust), pyright and mypy (Python), go build (Go), dart analyze (Dart/Flutter), dotnet build (C#), maven/gradle compile (JVM), phpstan and psalm (PHP).
- Pass \`checker\` to override detection, and \`command\` to run an exact one.
- Pass \`path\` to filter the reported diagnostics to a file or directory, or an ARRAY of them to scope one call to everything a change touched — \`path: ["src/money.ts", "src/receipt.ts"]\`. One call covering N files, never N calls. It deliberately does not narrow what gets checked — \`tsc a.ts\` ignores tsconfig.json, so a narrowed run would disagree with CI.
- Pass \`severity: "all"\` to include warnings, \`baseline: "ignore"\` to report everything, or \`baseline: "capture"\` to re-record the backlog from this run. Capture needs a clean tree — on a dirty one it is ignored, because recording then would file the errors in your uncommitted work under this commit and call them pre-existing from that point on. It is not a way to silence a check you did not understand.

Notes:
- A non-zero exit from a failing check is expected and is not an error.
- dotnet, maven and gradle genuinely build: they write artifacts to disk and cost what a build costs. The other checkers only analyze.
- Use plain Bash only when you need raw compiler output.`

/** The v2 description (isCompactToolPromptsEnabled). Same invariance rule. */
export const COMPACT_DESCRIPTION = `Type-check the project and get back only what your changes broke. Prefer it over Bash for type checks: it detects the checker (tsc, deno check, cargo check, pyright, mypy, go build, dart analyze, dotnet build, maven/gradle compile, phpstan, psalm), runs it, and hides the diagnostics that were already there. Each new diagnostic comes with file:line, the checker's code and a source excerpt.

- The baseline: a run on a clean tree records the current commit's diagnostics as the known backlog, and later runs print only what is not in it. With uncommitted changes and no baseline for this commit, the last one from an earlier commit on the branch is used and the result says how far behind; with none, everything is reported as of unknown provenance.
- \`path\` (a file, a directory or an array — one call for everything a change touched) filters what is reported, never what is checked. \`checker\` overrides detection, \`command\` runs an exact one.
- \`severity: "all"\` adds warnings, \`baseline: "ignore"\` reports everything, \`baseline: "capture"\` re-records the backlog — only on a clean tree, and never to silence a check you don't understand.
- A non-zero exit is expected. dotnet, maven and gradle really build. Use plain Bash only for raw compiler output.`
