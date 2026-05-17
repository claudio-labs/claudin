import { mock } from 'bun:test'

mock.module('bun:bundle', () => {
  return { feature: (_flag: string) => false }
})

mock.module('@growthbook/growthbook', () => {
  class GrowthBook {
    setAttributes(_attrs: Record<string, unknown>): void {}
    setAttributeOverrides(_attrs: Record<string, unknown>): void {}
    async loadFeatures(_opts?: unknown): Promise<void> {}
    getFeatureValue<T>(_key: string, defaultValue: T): T { return defaultValue }
    isOn(_key: string): boolean { return false }
    isOff(_key: string): boolean { return true }
    getFeatures(): Record<string, unknown> { return {} }
    destroy(): void {}
  }
  return { GrowthBook }
})

mock.module('@anthropic-ai/sandbox-runtime', () => {
  const SandboxRuntimeConfigSchema = { parse: () => ({}) }

  class SandboxViolationStore {
    getViolations(): unknown[] { return [] }
    clear(): void {}
  }

  class SandboxManager {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async runCommand(_cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    static isSupportedPlatform(): boolean { return false }
    static checkDependencies(_opts?: unknown): { errors: string[]; warnings: string[] } {
      return { errors: ['sandbox-runtime not available in open build'], warnings: [] }
    }
    static getFsReadConfig(): Record<string, unknown> { return {} }
    static getFsWriteConfig(): Record<string, unknown> { return {} }
    static getNetworkRestrictionConfig(): Record<string, unknown> { return {} }
    static getIgnoreViolations(): Record<string, unknown> { return {} }
    static getAllowUnixSockets(): boolean { return false }
    static getAllowLocalBinding(): boolean { return false }
    static getEnableWeakerNestedSandbox(): boolean { return false }
    static getProxyPort(): number | undefined { return undefined }
    static getSocksProxyPort(): number | undefined { return undefined }
    static getLinuxHttpSocketPath(): string | undefined { return undefined }
    static getLinuxSocksSocketPath(): string | undefined { return undefined }
    static async waitForNetworkInitialization(): Promise<void> {}
    static getSandboxViolationStore(): SandboxViolationStore { return new SandboxViolationStore() }
    static annotateStderrWithSandboxFailures(stderr: string): string { return stderr }
    static cleanupAfterCommand(): void {}
    static wrapWithSandbox(command: string, _args?: unknown): { command: string; args: string[] } {
      return { command, args: [] }
    }
    static async initialize(_config?: unknown, _cb?: unknown): Promise<void> {}
    static updateConfig(_config: unknown): void {}
    static reset(): void {}
  }

  return { SandboxRuntimeConfigSchema, SandboxManager, SandboxViolationStore }
})
