// Stub for @anthropic-ai/sandbox-runtime — replaced at build time by native-stub plugin
// This stub exists so bun test can resolve the import when running source directly.

export const SandboxRuntimeConfigSchema = { parse: () => ({}) }

const noop = () => {}
const asyncNoop = async () => {}

export class SandboxManager {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async runCommand(_cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  // Static API used by src/services/sandbox/sandbox-adapter.ts. Defaults make
  // isSandboxingEnabled() return false in the open build/test environment.
  static isSupportedPlatform(): boolean {
    return false
  }
  static checkDependencies(_opts?: unknown): { errors: string[]; warnings: string[] } {
    return { errors: ['sandbox-runtime not available in open build'], warnings: [] }
  }
  static getFsReadConfig(): Record<string, unknown> {
    return {}
  }
  static getFsWriteConfig(): Record<string, unknown> {
    return {}
  }
  static getNetworkRestrictionConfig(): Record<string, unknown> {
    return {}
  }
  static getIgnoreViolations(): Record<string, unknown> {
    return {}
  }
  static getAllowUnixSockets(): boolean {
    return false
  }
  static getAllowLocalBinding(): boolean {
    return false
  }
  static getEnableWeakerNestedSandbox(): boolean {
    return false
  }
  static getProxyPort(): number | undefined {
    return undefined
  }
  static getSocksProxyPort(): number | undefined {
    return undefined
  }
  static getLinuxHttpSocketPath(): string | undefined {
    return undefined
  }
  static getLinuxSocksSocketPath(): string | undefined {
    return undefined
  }
  static async waitForNetworkInitialization(): Promise<void> {}
  static getSandboxViolationStore(): SandboxViolationStore {
    return new SandboxViolationStore()
  }
  static annotateStderrWithSandboxFailures(stderr: string): string {
    return stderr
  }
  static cleanupAfterCommand(): void {}
  static wrapWithSandbox(
    command: string,
    _args?: unknown,
  ): { command: string; args: string[] } {
    return { command, args: [] }
  }
  static async initialize(_config?: unknown, _cb?: unknown): Promise<void> {}
  static updateConfig(_config: unknown): void {}
  static reset(): void {}
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
export type SandboxDependencyCheck = { errors: string[]; warnings: string[] }
export type SandboxRuntimeConfig = Record<string, unknown>
export type SandboxViolationEvent = Record<string, unknown>
