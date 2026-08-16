// Modules that `scripts/build/build.ts` resolves to an inline stub instead of a real
// package, plus the non-code assets it inlines as strings. None of them are
// installed, so without these declarations every import site is a TS2307 that
// no `bun install` can fix — permanent noise that buries the errors worth
// reading.
//
// Two conventions here, both deliberate:
//
//  - Every export is `any`. That is not a shortcut: `build.ts` redirects these
//    to the `native-stub` namespace, whose payload is `new Proxy(noop, handler)`
//    — a value that answers every property access with a no-op. `any` is what a
//    proxy-of-everything is.
//  - The exports are named EXPLICITLY rather than declared shorthand
//    (`declare module 'x'`), because a shorthand declaration makes every import
//    a value, and the type-position imports below then fail with TS2709. Naming
//    them also means a newly-added import errors until someone consciously adds
//    it here, which is the point — this list should not silently absorb things.
//
// Keep the list in sync with the stub tables in `scripts/build/build.ts`.

// ---------------------------------------------------------------------------
// Text assets
//
// `build.ts` (the `/\.(md|txt)$/` onResolve) inlines a matching file's contents
// as the default export, and stubs a missing one to ''. Either way the module's
// only export is a string.
// ---------------------------------------------------------------------------

declare module '*.md' {
  const contents: string
  export default contents
}

declare module '*.txt' {
  const contents: string
  export default contents
}

// ---------------------------------------------------------------------------
// Computer use (Anthropic-internal, `@ant/*`)
//
// Listed in the `missingModules` set in `scripts/build/build.ts`. The feature is off
// in the open build.
// ---------------------------------------------------------------------------

declare module '@ant/computer-use-mcp' {
  export type ComputerExecutor = any
  export type ComputerUseSessionContext = any
  export type CuCallToolResult = any
  export type CuPermissionRequest = any
  export type CuPermissionResponse = any
  export type DisplayGeometry = any
  export type FrontmostApp = any
  export type InstalledApp = any
  export type ResolvePrepareCaptureResult = any
  export type RunningApp = any
  export type ScreenshotDims = any
  export type ScreenshotResult = any
  export const API_RESIZE_PARAMS: any
  export const DEFAULT_GRANT_FLAGS: any
  export const bindSessionContext: any
  export const buildComputerUseTools: any
  export const createComputerUseMcpServer: any
  export const targetImageSize: any
}

declare module '@ant/computer-use-mcp/types' {
  export type ComputerUseHostAdapter = any
  export type CoordinateMode = any
  export type CuPermissionRequest = any
  export type CuPermissionResponse = any
  export type CuSubGates = any
  export type Logger = any
  export const DEFAULT_GRANT_FLAGS: any
}

declare module '@ant/computer-use-mcp/sentinelApps' {
  export const getSentinelCategory: any
}

declare module '@ant/computer-use-input' {
  export type ComputerUseInput = any
  export type ComputerUseInputAPI = any
}

declare module '@ant/computer-use-swift' {
  export type ComputerUseAPI = any
}

// ---------------------------------------------------------------------------
// Native addons and other packages `build.ts` redirects to `native-stub`
// ---------------------------------------------------------------------------

declare module 'audio-capture-napi'
declare module 'image-processor-napi'
declare module 'url-handler-napi'

declare module '@anthropic-ai/mcpb' {
  export type McpbManifest = any
  export type McpbUserConfigurationOption = any
}

declare module 'asciichart' {
  export const plot: any
}

declare module 'plist'
declare module 'cacache'

// `src/stubs/` holds hand-written shims for the next two, but only so that
// `bun test` can resolve the import when it runs source directly — they are
// minimal, not faithful models of the real packages. Pointing tsc at them via
// tsconfig `paths` was tried and rejected: it manufactures ~40 errors about
// fields the shim declines to describe, in modules that
// `scripts/build/no-telemetry-plugin.ts` and the native-stub plugin replace wholesale
// before they ship. (Those errors are real gaps in the shims, worth fixing on
// their own terms — they are just not typecheck findings.)

declare module '@growthbook/growthbook' {
  export const GrowthBook: any
}

declare module '@anthropic-ai/sandbox-runtime' {
  export type FsReadRestrictionConfig = any
  export type FsWriteRestrictionConfig = any
  export type IgnoreViolationsConfig = any
  export type NetworkHostPattern = any
  export type NetworkRestrictionConfig = any
  export type SandboxAskCallback = any
  export type SandboxDependencyCheck = any
  export type SandboxRuntimeConfig = any
  export type SandboxViolationEvent = any
  export const SandboxManager: any
  export const SandboxRuntimeConfigSchema: any
  export const SandboxViolationStore: any
}

// ---------------------------------------------------------------------------
// Optional runtime peers
//
// Imported dynamically and only on a path the user has opted into, so they are
// deliberately absent from `package.json` rather than missing by accident.
// ---------------------------------------------------------------------------

/** Loaded by `utils/model/bedrock.ts` only when the active provider is Bedrock. */
declare module '@aws-sdk/client-bedrock'
/** Loaded by `utils/aws.ts` only when resolving AWS credentials. */
declare module '@aws-sdk/client-sts'
/** Loaded by `services/tokenEstimation.ts` only for Bedrock token counting. */
declare module '@aws-sdk/client-bedrock-runtime' {
  export type CountTokensCommandInput = any
  export const CountTokensCommand: any
}

// ---------------------------------------------------------------------------
// OpenTelemetry exporters
//
// Kept `external` by `build.ts` rather than stubbed (too many named exports),
// and every call site is behind the telemetry stubs that
// `scripts/build/no-telemetry-plugin.ts` installs, so nothing reaches them in the
// open build.
// ---------------------------------------------------------------------------

declare module '@opentelemetry/exporter-trace-otlp-http'
declare module '@opentelemetry/exporter-trace-otlp-proto'
declare module '@opentelemetry/exporter-logs-otlp-http'
declare module '@opentelemetry/exporter-logs-otlp-proto'
declare module '@opentelemetry/exporter-metrics-otlp-http'
declare module '@opentelemetry/exporter-metrics-otlp-proto'
declare module '@opentelemetry/exporter-prometheus'
