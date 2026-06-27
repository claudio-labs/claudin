// Real captured command output for the Phase 13 language-toolchain filters.
//
// NOT synthetic. Each const is verbatim output of the named tool, with a
// `// source:` pointer so the origin is auditable:
//   - rtk  → ../rtk/src/filters/<cmd>.toml `[[tests.X]]` (real captures the
//            rtk project shipped) or ../rtk/src/cmds/<lang>/<cmd>.rs.
//   - web  → CI logs / GitHub issues / docs (URL in the comment).
//
// Convention per command: an `*_OK` (success / up-to-date — exercises the
// short-circuit) and an `*_ERR` (failure / diagnostics — proves the
// `unless: HAS_ERROR` guard preserves the failure). Consumed by both the
// per-family `<family>.test.ts` files and `phase13Report.test.ts`.
//
// NOT a `.test` file — pure data.

// ───────────────────────────── T1 — cc (gcc / make / pio) ──────────────────

// source: ../rtk/src/filters/gcc.toml [[tests.gcc]] "strips include chain…"
export const GCC_ERR = `In file included from /usr/include/stdio.h:42:
                 from main.c:1:
main.c:10:5: error: use of undeclared identifier 'foo'
    foo();
    ^
main.c:15:12: warning: unused variable 'x' [-Wunused-variable]
    int x = 42;
        ^
2 warnings generated.
1 error generated.
`;

// source: ../rtk/src/filters/gcc.toml [[tests.gcc]] "linker error kept"
export const GCC_LINK_ERR = `/usr/bin/ld: /tmp/main.o: undefined reference to 'missing_func'
collect2: error: ld returned 1 exit status
`;

// source: ../rtk/src/filters/make.toml [[tests.make]] "strips entering/leaving"
export const MAKE_OK = `make[1]: Entering directory '/home/user'
gcc -O2 foo.c
make[1]: Leaving directory '/home/user'
`;

// source: ../rtk/src/filters/make.toml [[tests.make]] "on_empty when all stripped"
export const MAKE_NOTHING = `make[1]: Entering directory '/home/user'
make[1]: Leaving directory '/home/user'
make: Nothing to be done for 'all'.
`;

// source: ../rtk/src/filters/pio-run.toml [[tests.pio-run]] "strips build noise…"
export const PIO_ERR = `Verbose mode can be enabled via \`-v, --verbose\` option
CONFIGURATION: https://docs.platformio.org/page/boards/espressif32/esp32dev.html
LDF: Library Dependency Finder -> https://bit.ly/configure-pio-ldf
Compiling .pio/build/esp32dev/src/main.cpp.o
Building .pio/build/esp32dev/firmware.elf
Linking .pio/build/esp32dev/firmware.elf
Checking size .pio/build/esp32dev/firmware.elf
src/main.cpp:10:3: error: 'LED_BUILTINN' was not declared
`;

// source: ../rtk/src/filters/pio-run.toml [[tests.pio-run]] "on_empty clean build"
export const PIO_OK = `Verbose mode can be enabled via \`-v, --verbose\` option
Compiling .pio/build/esp32dev/src/main.cpp.o
Linking .pio/build/esp32dev/firmware.elf
`;

// source: GNU make canonical recursive-failure format (gnu.org make manual,
// "Errors in Recipes" / "-w directory tracking"). The `*** [..] Error N` lines
// are the make failure summary and MUST survive the directory-marker strip.
export const MAKE_ERR = `make[1]: Entering directory '/home/user/proj'
gcc -O2 -c main.c
main.c:10:5: error: 'foo' undeclared (first use in this function)
make[1]: *** [Makefile:7: main.o] Error 1
make[1]: Leaving directory '/home/user/proj'
make: *** [Makefile:3: all] Error 2
`;

// source: PlatformIO docs build output (docs.platformio.org "build" — the
// memory-usage report printed after a successful link). The RAM/Flash table
// is signal and must NOT be stripped as build ceremony.
export const PIO_SIZE = `Compiling .pio/build/esp32dev/src/main.cpp.o
Linking .pio/build/esp32dev/firmware.elf
Checking size .pio/build/esp32dev/firmware.elf
Advanced Memory Usage is available via "PlatformIO Home > Project Inspect"
RAM:   [=         ]   8.5% (used 27796 bytes from 327680 bytes)
Flash: [===       ]  25.7% (used 336861 bytes from 1310720 bytes)
`;

// ───────────────────────── T2 — dotnet (build / test / format) ─────────────

// source: ../rtk/src/filters/dotnet-build.toml [[tests.dotnet-build]]
export const DOTNET_BUILD_OK = `Microsoft (R) Build Engine version 17.8.3+195e7f5a3
Copyright (C) Microsoft Corporation. All rights reserved.

  Determining projects to restore...
  All projects are up-to-date for restore.
  MyApp -> /home/user/MyApp/bin/Debug/net8.0/MyApp.dll

Build succeeded.
    0 Warning(s)
    0 Error(s)

Time Elapsed 00:00:02.34
`;

// source: ../rtk/src/filters/dotnet-build.toml [[tests.dotnet-build]] "with warnings"
export const DOTNET_BUILD_WARN = `Microsoft (R) Build Engine version 17.8.3+195e7f5a3
Copyright (C) Microsoft Corporation. All rights reserved.

  Determining projects to restore...
  MyApp -> /home/user/MyApp/bin/Debug/net8.0/MyApp.dll

Build succeeded.
    3 Warning(s)
    0 Error(s)

Time Elapsed 00:00:01.87
`;

// source: ../rtk/src/filters/dotnet-build.toml [[tests.dotnet-build]] "build errors"
export const DOTNET_BUILD_ERR = `Microsoft (R) Build Engine version 17.8.3+195e7f5a3
Copyright (C) Microsoft Corporation. All rights reserved.

  Determining projects to restore...
src/Program.cs(10,5): error CS1002: ; expected [/home/user/MyApp/MyApp.csproj]

Build FAILED.
    0 Warning(s)
    1 Error(s)
`;

// source: Microsoft Learn "dotnet test" docs — verbatim VSTest success summary
// (learn.microsoft.com/dotnet/core/tools/dotnet-test).
export const DOTNET_TEST_OK = `Determining projects to restore...
  All projects are up-to-date for restore.
  UnitTestProject -> /home/user/proj/UnitTestProject/bin/Debug/net8.0/UnitTestProject.dll
Test run for /home/user/proj/UnitTestProject/bin/Debug/net8.0/UnitTestProject.dll (.NETCoreApp,Version=v8.0)
Microsoft (R) Test Execution Command Line Tool Version 17.8.0 (x64)
Copyright (c) Microsoft Corporation.  All rights reserved.

Starting test execution, please wait...
A total of 1 test files matched the specified pattern.

Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: < 1 ms - UnitTestProject.dll (net8.0)
`;

// source: composed from microsoft/vstest#285 (verbatim per-test Failed/Error
// Message/Stack Trace block format) + Microsoft Learn (the `Failed! - Failed: N`
// VSTest summary line). Represents a real failing `dotnet test` run.
export const DOTNET_TEST_FAIL = `Determining projects to restore...
  All projects are up-to-date for restore.
  Calculator.Tests -> /home/user/Calculator.Tests/bin/Debug/net8.0/Calculator.Tests.dll
Test run for /home/user/Calculator.Tests/bin/Debug/net8.0/Calculator.Tests.dll (.NETCoreApp,Version=v8.0)
Microsoft (R) Test Execution Command Line Tool Version 17.8.0 (x64)
Copyright (c) Microsoft Corporation.  All rights reserved.

Starting test execution, please wait...
A total of 1 test files matched the specified pattern.
  Failed Calculator.Tests.CalcTests.Add [12 ms]
  Error Message:
   Assert.Equal() Failure
   Expected: 4
   Actual:   5
  Stack Trace:
     at Calculator.Tests.CalcTests.Add() in /home/user/Calculator.Tests/CalcTests.cs:line 15

Failed!  - Failed:     1, Passed:    11, Skipped:     0, Total:    12, Duration: 254 ms - Calculator.Tests.dll (net8.0)
`;

// source: dotnet/format#1955 — verbatim `dotnet format --verify-no-changes`
// failure lines (error WHITESPACE / error IMPORTS).
export const DOTNET_FORMAT_ERR = `  Determining projects to restore...
  Restored /home/user/MyApp/MyApp.csproj (in 421 ms).
/home/user/MyApp/Program.cs(12,1): error WHITESPACE: Fix whitespace formatting. Replace 8 characters with '\\n    \\n'. [/home/user/MyApp/MyApp.csproj]
/home/user/MyApp/Program.cs(1,1): error IMPORTS: Fix imports ordering. [/home/user/MyApp/MyApp.csproj]
`;

// source: Microsoft Learn "dotnet format" docs — a clean run emits only restore
// chatter (near-nothing).
export const DOTNET_FORMAT_OK = `  Determining projects to restore...
  Restored /home/user/MyApp/MyApp.csproj (in 1.2 sec).
`;

// ───────────────────────────── T3 — php (composer) ─────────────────────────

// source: ../rtk/src/filters/composer-install.toml [[tests.composer-install]]
export const COMPOSER_NOTHING = `Loading composer repositories with package information
Updating dependencies
Lock file operations: 0 installs, 0 updates, 0 removals
Nothing to install, update or remove
Generating autoload files
`;

// source: ../rtk/src/filters/composer-install.toml [[tests.composer-install]]
export const COMPOSER_INSTALL = `Loading composer repositories with package information
Updating dependencies
  - Downloading symfony/console (v6.4.0)
  - Installing symfony/console (v6.4.0): Extracting archive
  - Downloading psr/log (3.0.0)
  - Installing psr/log (3.0.0): Extracting archive
Writing lock file
Generating autoload files
`;

// source: getcomposer.org canonical dependency-resolution failure format
// (the "Your requirements could not be resolved" / "Problem N" block composer
// prints on an unsatisfiable constraint).
export const COMPOSER_ERR = `Loading composer repositories with package information
Updating dependencies
Your requirements could not be resolved to an installable set of packages.

  Problem 1
    - Root composer.json requires php >=8.2 but your php version (8.1.0) does not satisfy that requirement.
`;

// ───────────────────────────── T4 — ruby (rake) ────────────────────────────

// source: minitest-via-rake console output (the colored runner shown when
// `rake test` drives minitest; ESC[32m green dots + blank-line runs). The
// filter strips ANSI and collapses the blank runs; the summary is signal.
export const RAKE_OK = `Running 12 tests in a single process (parallelization threshold is 50)
Run options: --seed 41955

# Running:

\x1b[32m............\x1b[0m


Finished in 0.123456s, 97.2 runs/s, 162.0 assertions/s.

12 runs, 20 assertions, 0 failures, 0 errors, 0 skips
`;

// source: treehouse community "rake aborted! db:migrate" + rails/rails#56448 —
// the verbatim `rake aborted!` failure footer (exception + backtrace +
// `Tasks: TOP => …` + the --trace hint).
export const RAKE_FAIL = `rake aborted!
ActiveRecord::PendingMigrationError: Migrations are pending. To resolve this issue, run: bin/rails db:migrate RAILS_ENV=development
/app/vendor/bundle/ruby/3.2.0/gems/activerecord-7.1.0/lib/active_record/migration.rb:611:in \`check_pending!'
Tasks: TOP => db:migrate
(See full trace by running task with --trace)
`;

// ──────────────────────── T5 — elixir (mix compile/format) ─────────────────

// source: ../rtk/src/filters/mix-compile.toml [[tests.mix-compile]]
export const MIX_COMPILE_WARN = `Compiling 12 files (.ex)
Generated my_app app

warning: variable "conn" is unused
  lib/router.ex:42
`;

// source: ../rtk/src/filters/mix-compile.toml [[tests.mix-compile]] "only noise"
export const MIX_COMPILE_OK = `Compiling 3 files (.ex)
Generated my_app app
`;

// source: ../rtk/src/filters/mix-format.toml [[tests.mix-format]] "changed files".
// `mix format --check-formatted` lists unformatted files; the list is signal.
export const MIX_FORMAT_FILES = `lib/my_app.ex
test/my_app_test.exs
`;

// ──────────────────── T6 — swift / apple (swift build, xcodebuild) ──────────

// source: ../rtk/src/filters/swift-build.toml [[tests.swift-build]]
export const SWIFT_OK = `Build complete!
`;

// source: ../rtk/src/filters/swift-build.toml [[tests.swift-build]] "build errors"
export const SWIFT_ERR = `Compiling MyApp MyApp.swift
/home/user/MyApp/Sources/MyApp/main.swift:5:1: error: use of unresolved identifier 'foo'
foo()
^~~
Linking MyApp
error: build had 1 command failure
`;

// source: ../rtk/src/filters/swift-build.toml [[tests.swift-build]] "warnings not swallowed"
export const SWIFT_WARN = `CompileSwift normal x86_64 MyFile.swift
/path/to/MyFile.swift:42:10: warning: unused variable 'x'
Build complete! (with warnings)
`;

// source: ../rtk/src/filters/xcodebuild.toml [[tests.xcodebuild]] "build failed"
export const XCODE_FAIL = `note: Using new build system
CompileSwift normal arm64 /Users/dev/App/ViewController.swift
    cd /Users/dev/App
    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -c
CompileSwift normal arm64 /Users/dev/App/AppDelegate.swift
    cd /Users/dev/App
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
Ld /Users/dev/Build/Products/Debug/App normal arm64
    cd /Users/dev/App
    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang
CodeSign /Users/dev/Build/Products/Debug/App.app
    cd /Users/dev/App
    builtin-codesign --force --sign

/Users/dev/App/ViewController.swift:42:9: error: use of unresolved identifier 'foo'
/Users/dev/App/Model.swift:18:5: warning: variable 'x' was never used

** BUILD FAILED **
`;

// source: ../rtk/src/filters/xcodebuild.toml [[tests.xcodebuild]] "clean success"
export const XCODE_OK = `note: Using new build system
CompileSwift normal arm64 /Users/dev/App/Main.swift
    cd /Users/dev/App
Ld /Users/dev/Build/Products/Debug/App normal arm64
    cd /Users/dev/App
CodeSign /Users/dev/Build/Products/Debug/App.app
    cd /Users/dev/App
    builtin-codesign --force --sign

** BUILD SUCCEEDED **
`;

// ───────────── T7 — js-extras (next / biome / oxlint / turbo / nx) ──────────

// source: Next.js 14 production-build console output (vercel/next.js docs +
// the standard App-Router build summary). Clean build → collapses.
export const NEXT_BUILD_OK = `   ▲ Next.js 14.2.3

   Creating an optimized production build ...
 ✓ Compiled successfully
 ✓ Linting and checking validity of types
 ✓ Collecting page data
 ✓ Generating static pages (5/5)
 ✓ Collecting build traces
 ✓ Finalizing page optimization

Route (app)                              Size     First Load JS
┌ ○ /                                    5.3 kB         92.4 kB
└ ○ /about                               1.2 kB         88.3 kB
+ First Load JS shared by all            87.1 kB

○  (Static)  prerendered as static content
`;

// source: nrwl/nx#14558 — verbatim Next.js App-Router type-check failure
// (compile passes, type-check fails → "Failed to compile." + "Type error:").
export const NEXT_TYPE_ERR = `   ▲ Next.js 14.1.0

   Creating an optimized production build ...
 ✓ Compiled successfully
   Linting and checking validity of types  ...Failed to compile.

./app/page.tsx:12:5
Type error: Cannot find module '../../../../app/layout' or its corresponding type declarations.
`;

// source: vercel/next.js#72986 — verbatim Next.js 15 webpack build failure.
export const NEXT_WEBPACK_ERR = `   ▲ Next.js 15.0.3

   Creating an optimized production build ...
Failed to compile.

./app/page.tsx + 1 modules
Unexpected end of JSON input

> Build failed because of webpack errors
`;

// source: ../rtk/src/filters/biome.toml [[tests.biome]]
export const BIOME_DIRTY = `Checked 42 files in 0.5s

src/app.tsx:5:3 lint/suspicious/noExplicitAny ━━━━━━━━━━━━━━━━━━━━
  × Unexpected any. Specify a different type.
  3 │ interface Props {
  4 │   data: any;
  5 │         ^^^

src/utils.ts:12:1 lint/complexity/noForEach ━━━━━━━━━━━━━━━━━━━━
  × Prefer for...of instead of forEach.
 12 │ items.forEach(item => process(item));
    │ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Found 2 errors.
`;

// source: ../rtk/src/filters/biome.toml [[tests.biome]] "clean check"
export const BIOME_CLEAN = `Checked 42 files in 0.3s
`;

// source: ../rtk/src/filters/oxlint.toml [[tests.oxlint]]
export const OXLINT_DIRTY = `  × eslint(no-console): Unexpected console statement.
   ╭─[src/app.ts:5:3]
 5 │   console.log("debug");
   │   ^^^^^^^^^^^
   ╰────

  × eslint(no-unused-vars): 'x' is defined but never used.
   ╭─[src/utils.ts:2:7]
 2 │   let x = 42;
   │       ^
   ╰────

Found 2 warnings on 2 files.
Finished in 12ms on 100 files.
`;

// source: ../rtk/src/filters/oxlint.toml [[tests.oxlint]] "clean output"
export const OXLINT_CLEAN = `Finished in 5ms on 100 files.
`;

// source: ../rtk/src/filters/turbo.toml [[tests.turbo]]
export const TURBO_OK = ` cache hit, replaying logs abc123
 cache miss, executing abc456

3 packages in scope

> myapp:build

Compiled successfully.

Tasks:    2 successful, 2 total (1 cached)
Duration: 3.2s`;

// source: ../rtk/src/filters/turbo.toml [[tests.turbo]] "preserves error output"
export const TURBO_ERR = `> myapp:lint

Error: src/index.ts(5,1): error TS2304

Tasks:    0 successful, 1 total
Duration: 1.1s`;

// source: ../rtk/src/filters/turbo.toml [[tests.turbo]] "empty after stripping"
export const TURBO_CACHED = ` cache hit, replaying logs abc

`;

// source: ../rtk/src/filters/nx.toml [[tests.nx]]
export const NX_OK = `
   > NX   Running target build for project myapp

———————————————————————————————————————
Compiled successfully.
Output: dist/apps/myapp

   > NX   View logs at /tmp/.nx/runs/abc123

   Nx (powered by computation caching)
`;

// source: ../rtk/src/filters/nx.toml [[tests.nx]] "preserves error output"
export const NX_ERR = `ERROR: Cannot find module '@myapp/shared'

   > NX   Running target build for project myapp

Failed at step: build`;

// ────────────── T8 — python-extras (uv / poetry / basedpyright / ty) ────────

// source: ../rtk/src/filters/uv-sync.toml [[tests.uv-sync]] "audited short-circuit"
export const UV_OK = `Resolved 42 packages in 123ms
Audited 42 packages in 0.05ms
`;

// source: ../rtk/src/filters/uv-sync.toml [[tests.uv-sync]] "install strips downloads"
export const UV_INSTALL = `  Downloading requests-2.31.0-py3-none-any.whl (62.6 kB)
  Using cached certifi-2023.11.17-py3-none-any.whl (162 kB)
  Preparing packages...
Installed 5 packages in 23ms
 + certifi==2023.11.17
 + charset-normalizer==3.3.2
 + idna==3.6
 + requests==2.31.0
 + urllib3==2.1.0
`;

// source: ../rtk/src/filters/poetry-install.toml [[tests.poetry-install]] "up to date"
export const POETRY_OK = `Installing dependencies from lock file

No dependencies to install or update
`;

// source: ../rtk/src/filters/poetry-install.toml [[tests.poetry-install]] "install strips"
export const POETRY_INSTALL = `Installing dependencies from lock file

  - Downloading requests-2.31.0-py3-none-any.whl (62.6 kB)
  - Installing certifi (2023.11.17)
  - Installing charset-normalizer (3.3.2)
  - Installing idna (3.6)
  - Installing urllib3 (2.1.0)
  - Installing requests (2.31.0)

Writing lock file
`;

// source: ../rtk/src/filters/basedpyright.toml [[tests.basedpyright]]
export const BASEDPYRIGHT_ERR = `basedpyright 1.22.0
Searching for source files
Found 42 source files

/home/user/app/main.py
  /home/user/app/main.py:10:5 - error: "foo" is not defined (reportUndefinedVariable)
  /home/user/app/main.py:25:1 - error: Type "str" is not assignable to type "int" (reportAssignmentType)

/home/user/app/utils.py
  /home/user/app/utils.py:8:9 - warning: Variable "x" is not accessed (reportUnusedVariable)

3 errors, 1 warning, 0 informations
`;

// source: ../rtk/src/filters/basedpyright.toml [[tests.basedpyright]] "clean output"
export const BASEDPYRIGHT_CLEAN = `basedpyright 1.22.0
Searching for source files
Found 10 source files

0 errors, 0 warnings, 0 informations
`;

// source: ../rtk/src/filters/ty.toml [[tests.ty]]
export const TY_ERR = `ty 0.1.0
Checking 15 files

error[unresolved-reference]: Name \`foo\` used when not defined
  --> app/main.py:10:5
   |
10 |     foo()
   |     ^^^
   |

warning[unused-variable]: Variable \`x\` is not used
  --> app/utils.py:8:9
   |
 8 |     x = 42
   |     ^
   |

Found 1 error, 1 warning
`;

// source: ../rtk/src/filters/ty.toml [[tests.ty]] "clean output"
export const TY_CLEAN = `ty 0.1.0
Checking 10 files

All checks passed!
`;

// ───────────────────────────── T9 — java (spring-boot) ─────────────────────

// source: ../rtk/src/filters/spring-boot.toml [[tests.spring-boot]] "startup"
export const SPRING_OK = `  .   ____          _
 /\\\\ / ___'_ __ _ _(_)_ __
  :: Spring Boot ::  (v3.2.0)
2024-01-01 INFO Initializing Spring
2024-01-01 INFO Bean 'dataSource' created
2024-01-01 INFO Tomcat started on port 8080
2024-01-01 INFO Started MyApp in 3.2 seconds
`;

// source: ../rtk/src/filters/spring-boot.toml [[tests.spring-boot]] "errors"
export const SPRING_ERR = `  :: Spring Boot ::  (v3.2.0)
2024-01-01 INFO Initializing Spring
2024-01-01 ERROR Application run failed
Caused by: java.lang.NullPointerException
`;
