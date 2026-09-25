import { feature } from 'bun:bundle'
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'
import { CLAUDE_CODE_GUIDE_AGENT } from 'src/tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import {
  EXPLORE_AGENT,
  EXPLORE_AGENT_TYPE,
} from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'
import { WEB_RESEARCHER_AGENT } from 'src/tools/AgentTool/built-in/webResearcherAgent.js'
import { WEB_RESEARCHER_MANAGER_AGENT } from 'src/tools/AgentTool/built-in/webResearcherManagerAgent.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'

export function isPlanAgentEnabled(): boolean {
  if (feature('BUILTIN_PLAN_AGENT')) {
    // 3P default: true — Bedrock/Vertex keep the agent enabled (matches
    // pre-experiment external behavior). A/B test treatment sets false to
    // measure impact of removal.
    return getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_stoat', true)
  }
  return false
}

/**
 * The read-only search agent is registered unless CLAUDIN_EXPLORE_AGENT is 0
 * (or false/no/off). On by default since 2026-09-25, the user's call after the
 * delegation A/B (`scripts/bench/ab/delegation-steer-ab.ts`, arms baseline /
 * explore / placebo, N=5): main-thread tool calls −29% (separated), CLI cost
 * −9% (overlap), wall time +30%. It had been removed on 2026-08-18 in favor of
 * a fresh `Code` + `readOnly` agent — the history is in
 * .claudin/memory/team/decisions/explore-agent-removed.md.
 *
 * A runtime env, not a `feature()` flag, so an A/B arm can turn it off in the
 * same build and a test can render every prompt that names the agent with the
 * gate in either state. It must not change while the process lives: the Agent
 * tool description (cached prefix) names the agent when it is registered.
 */
export function isExploreAgentEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_EXPLORE_AGENT)
}

/**
 * Whether the built-in Explore agent is in this process's registry — the gate
 * above AND whatever getBuiltInAgents() applies on top (the SDK blank slate,
 * coordinator mode). A prompt that names the agent without holding the agent
 * list asks this, so it can never advertise an agent that is not there: the
 * removal on 2026-08-18 found eight prompts doing exactly that.
 */
export function isExploreAgentRegistered(): boolean {
  return getBuiltInAgents().some(a => a.agentType === EXPLORE_AGENT_TYPE)
}

export function getBuiltInAgents(): AgentDefinition[] {
  // Allow disabling all built-in agents via env var (useful for SDK users who want a blank slate)
  // Only applies in noninteractive mode (SDK/API usage)
  if (
    isEnvTruthy(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return []
  }

  // Use lazy require inside the function body to avoid circular dependency
  // issues at module init time. The coordinatorMode module depends on tools
  // which depend on AgentTool which imports this file.
  if (feature('COORDINATOR_MODE')) {
    if (isEnvTruthy(process.env.CLAUDIN_COORDINATOR_MODE)) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { getCoordinatorAgents } =
        require('src/agent/coordinator/workerAgent.js') as typeof import('src/agent/coordinator/workerAgent.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      return getCoordinatorAgents()
    }
  }

  const agents: AgentDefinition[] = [GENERAL_PURPOSE_AGENT]

  if (isPlanAgentEnabled()) {
    agents.push(PLAN_AGENT)
  }

  if (isExploreAgentEnabled()) {
    agents.push(EXPLORE_AGENT)
  }

  // Multi-page web research subagent — isolated context so the parent does not
  // accumulate raw HTML. See docs/tech/web-researcher/README.md.
  agents.push(WEB_RESEARCHER_AGENT)

  // Deep-research orchestrator — fans out WebResearcher workers across angles,
  // verifies claims, and synthesizes a cited report. Sync built-in agent that
  // spawns WebResearcher sub-agents (see resolveAgentTools orchestrator path).
  agents.push(WEB_RESEARCHER_MANAGER_AGENT)

  // Include Code Guide agent for non-SDK entrypoints
  const isNonSdkEntrypoint =
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-ts' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-py' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-cli'

  if (isNonSdkEntrypoint) {
    agents.push(CLAUDE_CODE_GUIDE_AGENT)
  }

  return agents
}
