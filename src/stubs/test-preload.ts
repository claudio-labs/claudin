import { mock } from 'bun:test'

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

  class SandboxManager {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async runCommand(_cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
  }

  class SandboxViolationStore {
    getViolations(): unknown[] { return [] }
    clear(): void {}
  }

  return { SandboxRuntimeConfigSchema, SandboxManager, SandboxViolationStore }
})
