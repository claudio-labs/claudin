// Real captured command output for the dotnet filters (build / test / format).
//
// NOT synthetic. Each const is verbatim output of the named tool, with a
// `// source:` pointer so the origin is auditable:
//   - rtk  → ../rtk/src/filters/<cmd>.toml `[[tests.X]]` (real captures the
//            rtk project shipped) or ../rtk/src/cmds/<lang>/<cmd>.rs.
//   - web  → CI logs / GitHub issues / docs (URL in the comment).
//
// Convention per command: an `*_OK` (success / up-to-date — exercises the
// short-circuit) and an `*_ERR` (failure / diagnostics — proves the
// `unless: HAS_ERROR` guard preserves the failure).
//
// NOT a `.test` file — pure data.

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
