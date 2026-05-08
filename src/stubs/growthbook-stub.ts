// Stub for @growthbook/growthbook — replaced at build time by no-telemetry-plugin
// This stub exists so bun test can resolve the import when running source directly.

export class GrowthBook {
  setAttributes(_attrs: Record<string, unknown>): void {}
  setAttributeOverrides(_attrs: Record<string, unknown>): void {}
  async loadFeatures(_opts?: unknown): Promise<void> {}
  getFeatureValue<T>(_key: string, defaultValue: T): T { return defaultValue }
  isOn(_key: string): boolean { return false }
  isOff(_key: string): boolean { return true }
  getFeatures(): Record<string, unknown> { return {} }
  destroy(): void {}
}
