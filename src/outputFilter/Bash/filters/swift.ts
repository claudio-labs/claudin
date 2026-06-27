// Swift / Apple toolchain filters — Phase 13 (rtk gap-fill).
//
//   - swift build : strip the `Compiling …` / `Linking …` lines; collapse a
//     clean `Build complete!` to a sentinel (unless a warning/error is present);
//     diagnostics pass through.
//   - xcodebuild  : strip the (very verbose) build-phase lines and their
//     indented command invocations; keep diagnostics, test results, and the
//     `** BUILD SUCCEEDED/FAILED **` summary. Capped at maxLines.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- swift build -----------------------------------------------------------

const SWIFT_BUILD_MATCH = /^swift\s+build\b/
const SWIFT_COMPILING = /^Compiling\s/
const SWIFT_LINKING = /^Linking\s/
const SWIFT_OK = /Build complete!/
// `Build complete! (with warnings)` and real errors must not collapse.
const SWIFT_HAS_PROBLEM = /\bwarning:|\berror:/

export const swiftBuild: FilterSpec = {
  name: 'swift-build',
  matchCommand: SWIFT_BUILD_MATCH,
  stripAnsi: true,
  matchOutput: [
    {
      pattern: SWIFT_OK,
      unless: SWIFT_HAS_PROBLEM,
      message: '✓ swift build: complete',
    },
  ],
  stripLinesMatching: [SWIFT_COMPILING, SWIFT_LINKING],
  collapseRuns: true,
  maxLines: 40,
}

// --- xcodebuild ------------------------------------------------------------

const XCODEBUILD_MATCH = /^xcodebuild\b/
// `-json` / `-resultBundlePath` produce structured artifacts — keep raw.
const XCODEBUILD_REJECT = /(?:^|\s)(?:-json\b|-resultBundlePath\b)/
// Build-phase task lines (each names a phase + path).
const XCODE_PHASE = /^(?:CompileC|CompileSwift|Ld|CreateBuildDirectory|MkDir|ProcessInfoPlistFile|CopySwiftLibs|CodeSign|RegisterWithLaunchServices|Validate|ProcessProductPackaging|Touch|LinkStoryboards|CompileStoryboard|CompileAssetCatalog|GenerateDSYMFile|PhaseScriptExecution|PBXCp|SetMode|SetOwnerAndGroup|Ditto|CpResource|CpHeader)\s/
const XCODE_SIGNING_IDENTITY = /^Signing Identity:/
const XCODE_NEW_BUILD_SYSTEM = /^note: Using new build system/
// Indented command invocations that follow each phase line.
const XCODE_INDENT_CD = /^\s+cd\s+\//
const XCODE_INDENT_EXPORT = /^\s+export\s/
const XCODE_INDENT_XCODE = /^\s+\/Applications\/Xcode/
const XCODE_INDENT_USRBIN = /^\s+\/usr\/bin\//
const XCODE_INDENT_BUILTIN = /^\s+builtin-/

export const xcodebuild: FilterSpec = {
  name: 'xcodebuild',
  matchCommand: XCODEBUILD_MATCH,
  matchCommandReject: XCODEBUILD_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    XCODE_PHASE,
    XCODE_SIGNING_IDENTITY,
    XCODE_NEW_BUILD_SYSTEM,
    XCODE_INDENT_CD,
    XCODE_INDENT_EXPORT,
    XCODE_INDENT_XCODE,
    XCODE_INDENT_USRBIN,
    XCODE_INDENT_BUILTIN,
  ],
  collapseRuns: true,
  maxLines: 60,
  onEmpty: 'xcodebuild: ok',
}
