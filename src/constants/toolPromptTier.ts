import { getMainLoopModel } from '../utils/model/model.js'
import { getFamilyForLogging, type ModelFamily } from './familyAddendums/index.js'

// Tool-prompt verbosity tier by model family. Capable families follow the
// system prompt's altitude principle ("Don't add features… beyond what was
// asked") on their own, so per-tool gold-plating guardrails (NEVER create
// *.md, NEVER write new files, emoji rules) are redundant for them and can be
// dropped to save tokens. Weaker families ignore the general principle and
// need the guardrails spelled out per-tool, so they keep the verbose form.
//
// Mirrors the pure/global split of familyAddendums/index.ts: `isLeanFamily`
// is pure (testable without global state) and `isLeanToolPromptFamily` reads
// the active model exactly like getFamilyAddendum does.
//
// `default` (unknown OpenAI-compatible models) is intentionally verbose: an
// unrecognized model is treated as weak and gets the guardrails. A capable but
// unrecognized model merely pays a few extra tokens — no behavioral risk.
//
// This Record is the exhaustiveness guard: it must list EVERY ModelFamily, so
// adding a family to the union in familyAddendums/index.ts fails compilation
// here until someone makes a conscious 'lean' | 'verbose' choice for it.
const FAMILY_TIER: Record<ModelFamily, 'lean' | 'verbose'> = {
  anthropic: 'lean',
  'openai-reasoning': 'lean',
  gemini: 'lean',
  codex: 'lean',
  glm: 'verbose',
  kimi: 'verbose',
  default: 'verbose',
}

export function isLeanFamily(family: ModelFamily): boolean {
  return FAMILY_TIER[family] === 'lean'
}

export function isLeanToolPromptFamily(): boolean {
  return isLeanFamily(getFamilyForLogging(getMainLoopModel()))
}
