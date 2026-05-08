// Stub for @anthropic-ai/sandbox-runtime — replaced at build time by native-stub plugin
// This stub exists so bun test can resolve the import when running source directly.

export const SandboxRuntimeConfigSchema = { parse: () => ({}) }

export class SandboxManager {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async runCommand(_cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

export class SandboxViolationStore {
  getViolations(): unknown[] { return [] }
  clear(): void {}
}

// Type-only exports (runtime values needed to satisfy import resolution)
export type FsReadRestrictionConfig = Record<string, unknown>
export type FsWriteRestrictionConfig = Record<string, unknown>
export type IgnoreViolationsConfig = Record<string, unknown>
export type NetworkHostPattern = string
export type NetworkRestrictionConfig = Record<string, unknown>
export type SandboxAskCallback = () => Promise<boolean>
export type SandboxDependencyCheck = Record<string, unknown>
export type SandboxRuntimeConfig = Record<string, unknown>
export type SandboxViolationEvent = Record<string, unknown>
