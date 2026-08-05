export const BUILD_TOOL_NAME = 'Build'

/**
 * MUST stay invariant across projects, toolchains and configuration. The tool
 * description is part of the shared system prompt, so interpolating anything
 * environment-derived here would fragment the prompt cache for every user — the
 * same constraint `TypecheckTool/prompt.ts` documents. Detection results belong
 * in the tool RESULT, never here.
 */
export const DESCRIPTION = `Build the project and get back the errors, not the build log.

Prefer this tool over Bash for \`cargo build\`, \`./gradlew assemble\`, \`mvn package\`, \`make\`, \`dotnet build\` and friends: it detects the build system, runs it, and returns the diagnostics with file:line and a source excerpt instead of the hundreds of progress lines around them. When a build fails for a reason that has no file:line — dependency resolution, a linker error, a failed task, an out-of-memory — it extracts that block instead of making you page through the log for it.

Usage:
- Call with no arguments to build the current project. Auto-detected: cargo (Rust), gradle and maven (Java/Kotlin/Scala), sbt and mill (Scala), dotnet/msbuild (C#/F#), go, cmake/make/ninja (C/C++), swift and xcodebuild, zig, mix (Elixir), rebar3 (Erlang), flutter/dart, rake (Ruby), luarocks (Lua), cabal/stack (Haskell), and the \`build\` script of a package.json.
- Pass \`system\` to override detection, and \`command\` to run an exact one.
- Pass \`directory\` to build a project that is NOT the current working directory — one package of a monorepo, say. Detection runs there, so \`directory: "web"\` alone is usually enough. Never \`cd\` to it in Bash instead.
- Pass \`path\` to filter the reported diagnostics to a file or directory, or an ARRAY of them. It does not narrow what is built.
- Pass \`severity: "all"\` to list warnings as well as count them.
- Pass \`timeout\` for a build you expect to be long, and \`idleTimeout\` for one that legitimately goes quiet for a long stretch (linking, a cold daemon).

Notes:
- The detected command builds WITHOUT running tests (gradle \`assemble\`, maven \`-DskipTests\`). Use RunTests for the suite.
- A build where nothing needed rebuilding is reported as up to date. That is not the same as a clean build: a cached run recompiles nothing, so it reports no warnings and no artifacts because it produced none.
- The run is stopped after a stretch with no output at all, and the result says how long it ran, how long it had been silent, and the last line it printed. Silence is reported, not diagnosed — linking is legitimately quiet.
- A non-zero exit from a failing build is expected and is not an error.
- Use plain Bash when you need the raw build log, or \`run_in_background\` for a build too long to wait on.`
