/**
 * Hardcoded Copilot model registry.
 *
 * Source of truth: GET https://api.githubcopilot.com/models for an active
 * Copilot account. This list mirrors the chat-completion-relevant entries
 * (excluding embeddings, internal routers like accounts/msft/routers/*,
 * preview fine-tunes such as raptor-mini-tertiary / oswe-vscode-*, and
 * dated GPT-4o snapshots that prefix-resolve to the bare gpt-4o entry).
 *
 * Numeric values (context, output) are aligned with
 * `openaiContextWindows.ts` — the consistency test in
 * `copilotModels.consistency.test.ts` enforces both directions.
 */

export type CopilotModel = {
  id: string
  name: string
  family: string
  attachment: boolean
  reasoning: boolean
  tool_call: boolean
  temperature: boolean
  knowledge: string
  release_date: string
  last_updated: string
  modalities: {
    input: string[]
    output: string[]
  }
  open_weights: boolean
  cost: {
    input: number
    output: number
    cache_read?: number
  }
  limit: {
    context: number
    input?: number
    output: number
  }
}

export const COPILOT_MODELS: Record<string, CopilotModel> = {
  'gpt-5.5': {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    family: 'gpt',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    knowledge: '2025-05',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    modalities: { input: ['text'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 400000, output: 128000 },
  },
  'gpt-5.4': {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    family: 'gpt',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    knowledge: '2025-05',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    modalities: { input: ['text'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 400000, output: 128000 },
  },
  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2-Codex',
    family: 'gpt-codex',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    knowledge: '2025-05',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    modalities: { input: ['text'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 400000, output: 128000 },
  },
  'gpt-5-mini': {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    family: 'gpt-mini',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    knowledge: '2025-05',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    modalities: { input: ['text'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 264000, output: 64000 },
  },
  'gpt-4o': {
    id: 'gpt-4o',
    name: 'GPT-4o',
    family: 'gpt',
    attachment: true,
    reasoning: false,
    tool_call: true,
    temperature: true,
    knowledge: '2023-10',
    release_date: '2024-05-01',
    last_updated: '2024-08-06',
    modalities: { input: ['text', 'image'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 128000, output: 16384 },
  },
  'gpt-4.1': {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    family: 'gpt',
    attachment: false,
    reasoning: false,
    tool_call: true,
    temperature: true,
    knowledge: '2024-06',
    release_date: '2024-06-01',
    last_updated: '2024-06-01',
    modalities: { input: ['text'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 128000, output: 16384 },
  },
  'claude-opus-4.7': {
    id: 'claude-opus-4.7',
    name: 'Claude Opus 4.7',
    family: 'claude-opus',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    knowledge: '2026-01',
    release_date: '2026-04-01',
    last_updated: '2026-04-01',
    modalities: { input: ['text', 'image'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 200000, output: 32000 },
  },
  'claude-sonnet-4.6': {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    family: 'claude-sonnet',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    knowledge: '2025-05',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    modalities: { input: ['text', 'image'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 200000, output: 32000 },
  },
  'claude-haiku-4.5': {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    family: 'claude-haiku',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    knowledge: '2025-05',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    modalities: { input: ['text', 'image'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 144000, output: 32768 },
  },
  'gemini-3.1-pro-preview': {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview',
    family: 'gemini-pro',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    knowledge: '2025-05',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 200000, output: 64000 },
  },
  'grok-code-fast-1': {
    id: 'grok-code-fast-1',
    name: 'Grok Code Fast 1',
    family: 'grok',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    knowledge: '2025-05',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    modalities: { input: ['text'], output: ['text'] },
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: { context: 256000, output: 64000 },
  },
}

export const COPILOT_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(COPILOT_MODELS).map(model => [model.id, model.name]),
)


export function getAllCopilotModels(): CopilotModel[] {
  return Object.values(COPILOT_MODELS)
}
