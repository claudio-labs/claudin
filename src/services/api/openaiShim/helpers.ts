/**
 * Neutral utility helpers shared across the openaiShim modules
 * (sleep + message id generator). No domain dependencies.
 */

export function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}
