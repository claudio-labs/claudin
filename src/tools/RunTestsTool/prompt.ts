export const RUN_TESTS_TOOL_NAME = 'RunTests'

export const DESCRIPTION = `Run the project's automated test suite and get back a compact, structured result instead of raw runner output.

Prefer this tool over Bash for running unit/integration tests: it detects the framework, runs the suite, and returns a failures-first summary (pass/fail/skip counts, and for each failure the test name, file:line, a source excerpt, and a one-line problem summary). On a green run it returns just the counts — no passing noise. This saves tokens and gives you the failing file and line without a separate Read.

Usage:
- Call with no arguments to auto-detect and run the whole suite in the current project. Auto-detected runners: vitest, jest, mocha, bun test, node --test, playwright (JS/TS); deno test; pytest (Python); go test; cargo/nextest (Rust); dart/flutter test; ctest (C/C++); phpunit, pest (PHP); rspec, minitest (Ruby); mix test / ExUnit (Elixir); dotnet; maven, gradle (JVM) — plus any runner that emits JUnit XML or TAP.
- Pass \`command\` to run an exact test command (e.g. "pytest tests/unit").
- Pass \`path\` to scope the run to a file or directory, and \`pattern\` to filter by test name.
- Pass \`framework\` to override detection. Required for Catch2 and doctest (C/C++), which aren't auto-detected: give the test binary as \`command\` and set \`framework\` to "catch2" or "doctest".

Notes:
- A non-zero exit from failing tests is expected and is not an error.
- Watch/interactive flags (--watch, --ui) are stripped so the run terminates.
- Use plain Bash only when you need raw output or a non-test command.`
