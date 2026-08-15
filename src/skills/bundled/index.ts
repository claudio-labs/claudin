import { feature } from 'bun:bundle'
import { registerBatchSkill } from 'src/skills/bundled/batch.js'
import { registerCodeReviewSkill } from 'src/skills/bundled/code-review.js'
import { registerCreateSkill } from 'src/skills/bundled/create.js'
import { registerDebugSkill } from 'src/skills/bundled/debug.js'
import { registerFewerPermissionPromptsSkill } from 'src/skills/bundled/fewerPermissionPrompts.js'
import { registerKeybindingsSkill } from 'src/skills/bundled/keybindings.js'
import { registerLoopSkill } from 'src/skills/bundled/loop.js'
import { registerRefreshRulesSkill } from 'src/skills/bundled/refreshRules.js'
import { registerRunSkill } from 'src/skills/bundled/run.js'
import { registerSimplifySkill } from 'src/skills/bundled/simplify.js'
import { registerUpdateConfigSkill } from 'src/skills/bundled/updateConfig.js'
import { registerVerifySkill } from 'src/skills/bundled/verify.js'

/**
 * Initialize all bundled skills.
 * Called at startup to register skills that ship with the CLI.
 *
 * To add a new bundled skill:
 * 1. Create a new file in src/skills/bundled/ (e.g., myskill.ts)
 * 2. Export a register function that calls registerBundledSkill()
 * 3. Import and call that function here
 */
export function initBundledSkills(): void {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerDebugSkill()
  registerCodeReviewSkill()
  registerBatchSkill()
  // Ported from the upstream built-in skills. All provider-agnostic
  // (pure agent-loop behavior), so they register unconditionally.
  registerSimplifySkill()
  registerVerifySkill()
  registerRunSkill()
  registerFewerPermissionPromptsSkill()
  // Claudin-native: teaches the model to create/refine skills, rules, and
  // agents in the .claudin structure (project + global).
  registerCreateSkill()
  // Claudin-native: keeps .claudin/rules/ honest — reports the rule defects
  // that are invisible at runtime and proposes corrections from session history.
  registerRefreshRulesSkill()
  if (feature('KAIROS') || feature('KAIROS_DREAM')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerDreamSkill } = require('./dream.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerDreamSkill()
  }
  if (feature('REVIEW_ARTIFACT')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerHunterSkill } = require('./hunter.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerHunterSkill()
  }
  // /loop's isEnabled delegates to isKairosCronEnabled() — registered
  // unconditionally so the static import is bundled; visibility is gated
  // at runtime by the isEnabled callback.
  registerLoopSkill()
  if (feature('AGENT_TRIGGERS_REMOTE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      registerScheduleRemoteAgentsSkill,
    } = require('src/skills/bundled/scheduleRemoteAgents.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerScheduleRemoteAgentsSkill()
  }
  if (feature('BUILDING_CLAUDE_APPS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerClaudeApiSkill } = require('src/skills/bundled/claudeApi.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerClaudeApiSkill()
  }
  if (feature('RUN_SKILL_GENERATOR')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerRunSkillGeneratorSkill } = require('./runSkillGenerator.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerRunSkillGeneratorSkill()
  }
}
