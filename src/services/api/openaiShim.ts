/**
 * OpenAI-compatible API shim for Claude Code.
 *
 * Translates Anthropic SDK calls (anthropic.beta.messages.create) into
 * OpenAI-compatible chat completion requests and streams back events
 * in the Anthropic streaming format so the rest of the codebase is unaware.
 *
 * Supports: OpenAI, Azure OpenAI, Ollama, LM Studio, OpenRouter,
 * Together, Groq, Fireworks, DeepSeek, Mistral, and any OpenAI-compatible API.
 *
 * Environment variables:
 *   CLAUDE_CODE_USE_OPENAI=1          — enable this provider
 *   OPENAI_API_KEY=sk-...             — API key (optional for local models)
 *   OPENAI_BASE_URL=http://...        — base URL (default: https://api.openai.com/v1)
 *   OPENAI_MODEL=gpt-4o              — default model override
 *   CODEX_API_KEY / ~/.codex/auth.json — Codex auth for codexplan/codexspark
 *
 * GitHub Copilot API (api.githubcopilot.com), OpenAI-compatible:
 *   CLAUDE_CODE_USE_GITHUB=1         — enable GitHub inference (no need for USE_OPENAI)
 *   GITHUB_TOKEN or GH_TOKEN         — Copilot API token (mapped to Bearer auth)
 *   OPENAI_MODEL                     — optional; use github:copilot or openai/gpt-4.1 style IDs
 */

// Barrel module for the OpenAI-compatible provider shim.
//
// The historical monolith (2275 lines) was split into focused submodules
// under ./openaiShim/. This file preserves the public surface so the
// callers across the codebase continue to import from
// 'src/services/api/openaiShim'.
//
// New code should prefer importing directly from the relevant submodule.
//
// Splitting layout:
//   constants.ts        — host sets, retry/header constants, sensitive query keys
//   types.ts            — OpenAIMessage/Tool/StreamChunk, SecretValueSource
//   helpers.ts          — sleepMs, makeMessageId (neutral utilities)
//   headers.ts          — filterAnthropicHeaders, formatRetryAfterHint
//   providerModes.ts    — isGithubModelsMode/isMistralMode/isGeminiMode/
//                         hasGeminiApiHost/isMoonshotCompatibleBaseUrl/
//                         isDeepSeekBaseUrl/normalizeDeepSeekReasoningEffort
//   urlRedaction.ts     — shouldRedactUrlQueryParam, redactUrlForDiagnostics
//   messageConverter.ts — convertSystemPrompt/convertToolResultContent/
//                         convertContentBlocks/convertMessages
//   toolConverter.ts    — normalizeSchemaForOpenAI, convertTools
//   streamParser.ts     — openaiStreamToAnthropic, OpenAIShimStream,
//                         convertChunkUsage, repairPossiblyTruncatedObjectJson
//   messagesClient.ts   — OpenAIShimMessages, OpenAIShimBeta,
//                         createOpenAIShimClient

export { convertTools } from './openaiShim/toolConverter.js'
export { createOpenAIShimClient } from './openaiShim/messagesClient.js'
