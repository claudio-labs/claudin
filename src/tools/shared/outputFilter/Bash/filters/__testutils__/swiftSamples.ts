// Real captured command output for the swift filters (swift build / xcodebuild).
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
