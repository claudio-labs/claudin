import type { ClientOptions } from '@anthropic-ai/sdk'


export function clearDumpState(_agentIdOrSessionId?: string): void {}

export function clearAllDumpState(): void {}


export function createDumpPromptsFetch(
  _agentIdOrSessionId: string,
): ClientOptions['fetch'] {
  return undefined
}
