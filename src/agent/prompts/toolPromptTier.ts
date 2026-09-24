import { getMainLoopModel } from 'src/providers/model/model.js'
import { getFamilyForLogging, type ModelFamily } from 'src/agent/prompts/familyAddendums/index.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

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

/**
 * Force a tier regardless of the active model's family:
 * `CLAUDIN_TOOL_PROMPT_TIER=lean|verbose`. Anything else is ignored silently —
 * a typo must not get a vote on which prompt ships.
 *
 * This exists for the A/B bench (`scripts/bench/ab/lean-tool-prompts-ab.ts`),
 * which has to hold the model fixed while the prompt shape varies. Without it
 * the only ways to compare tiers are to change models (confounding the prompt
 * with the model) or to build twice and compare two bundles — the mistake that
 * made the clip-pin A/B uncitable. Every other A/B in `scripts/bench/ab/` flips
 * one killswitch on ONE build; this is that killswitch for this lane.
 *
 * REACH: only where `feature('LEAN_TOOL_PROMPTS')` is on. The flag folds to a
 * literal at build time, so with it OFF every builder is hardcoded verbose:
 * `verbose` here is a no-op and `lean` cannot be reached at all.
 */
export function getForcedToolPromptTier(): 'lean' | 'verbose' | null {
  const raw = process.env.CLAUDIN_TOOL_PROMPT_TIER?.trim().toLowerCase()
  return raw === 'lean' || raw === 'verbose' ? raw : null
}

export function isLeanToolPromptFamily(): boolean {
  const forced = getForcedToolPromptTier()
  if (forced !== null) return forced === 'lean'
  return isLeanFamily(getFamilyForLogging(getMainLoopModel()))
}

/**
 * The rule both v2 switches below share, pure so a test can reach it without
 * the process-global model state (a dozen suites mock `model.js`, and one that
 * leaks makes `getMainLoopModel()` ignore an override): the env opt-in AND the
 * Anthropic family.
 */
export function isV2PromptSwitchOn(
  envValue: string | undefined,
  family: ModelFamily,
): boolean {
  return isEnvTruthy(envValue) && family === 'anthropic'
}

/**
 * The v2 tool descriptions (branch perf/prompts-v2): Read, Grep, Agent, Bash,
 * Build, Typecheck and RunTests at Claude Code 2.1.280's density, every
 * parameter and behavior still named (promptFeatureCoverage.test.ts), and
 * Monitor behind ToolSearch. apply_patch keeps its full text: its compact one
 * produced malformed patches in the session A/B. Anthropic family only; opt-in
 * (`CLAUDIN_COMPACT_TOOL_PROMPTS=1`) — the A/B of 2026-09-24 did not pass.
 *
 * Tool descriptions are cached once per session (toolSchemaCache.ts), so
 * like the tier above this is read when the first request is built.
 */
export function isCompactToolPromptsEnabled(): boolean {
  return isV2PromptSwitchOn(
    process.env.CLAUDIN_COMPACT_TOOL_PROMPTS,
    getFamilyForLogging(getMainLoopModel()),
  )
}

/**
 * The v2 startup reminders (`CLAUDIN_LEAN_REMINDERS=1`): the git protocol
 * attachment with every rule and both examples in fewer words, and one short
 * line per skill in the listing. Anthropic family only; opt-in until its
 * session A/B gate holds.
 */
export function isLeanRemindersEnabled(): boolean {
  return isV2PromptSwitchOn(
    process.env.CLAUDIN_LEAN_REMINDERS,
    getFamilyForLogging(getMainLoopModel()),
  )
}
