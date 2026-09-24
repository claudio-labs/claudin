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
- Pass \`timeout\` for a build you expect to be long. A build that goes quiet is stopped early only when its processes also stop using CPU — waiting, not compiling — and never before an explicit \`timeout\`; \`idleTimeout\` sets that limit on its own.

Notes:
- The detected command builds WITHOUT running tests (gradle \`assemble\`, maven \`-DskipTests\`). Use RunTests for the suite.
- A build where nothing needed rebuilding is reported as up to date. That is not the same as a clean build: a cached run recompiles nothing, so it reports no warnings and no artifacts because it produced none.
- A stopped run says how long it ran, how long it had been quiet, and the last line it printed.
- A non-zero exit from a failing build is expected and is not an error.
- Use plain Bash when you need the raw build log, or \`run_in_background\` for a build too long to wait on.`

/** The v2 description (isCompactToolPromptsEnabled). Same invariance rule. */
export const COMPACT_DESCRIPTION = `Build the project and get back the errors, not the build log. Prefer it over Bash for builds: it detects the build system (cargo, gradle, maven, sbt, mill, dotnet/msbuild, go, cmake/make/ninja, swift, xcodebuild, zig, mix, rebar3, flutter/dart, rake, luarocks, cabal/stack, or a package.json \`build\` script), runs it, and returns diagnostics with file:line and a source excerpt — or, for a failure with no file:line (dependency resolution, a linker error, out of memory), that block of the log.

- \`directory\` builds another project, such as one package of a monorepo — never \`cd\` to it in Bash. \`system\` overrides detection, \`command\` runs an exact one.
- \`path\` (a file, a directory or an array) filters the reported diagnostics; it does not narrow what is built. \`severity: "all"\` lists warnings too.
- \`timeout\` for a long build: a quiet one is stopped early only when its processes also stop using CPU, and never before an explicit \`timeout\`; \`idleTimeout\` sets that limit alone. A stopped run is reported with its last line.
- It builds without running tests (use RunTests). "Up to date" means nothing was rebuilt, not a clean build. A non-zero exit from a failing build is expected. Use plain Bash for the raw log, or \`run_in_background\` for a very long build.`
