import { ONE_SHOT_BUILTIN_AGENT_TYPES } from 'src/tools/AgentTool/constants.js'

/**
 * Whether a spawn is eligible for the *implicit* auto-background toggle
 * (`autoBackgroundAgentsEnabled`, opt-in) and for the independent
 * `getAutoBackgroundMs()` timer that backgrounds a foreground spawn after 120s.
 *
 * Explicit opt-ins (`run_in_background: true`, `background: true` in an agent
 * definition, coordinator/proactive re-entry) bypass this and are handled by
 * their own terms in AgentTool's `shouldRunAsync`.
 *
 * Two spawns must stay inline because the parent consumes the report in the
 * same turn:
 * - `run_in_background: false` — an explicit request for inline. Before this
 *   guard the toggle silently overrode it, so the parameter had no `false`
 *   meaning at all.
 * - One-shot built-ins (Explore, Plan, WebResearcher, WebResearcherManager) —
 *   they exist to hand a report back mid-turn. Backgrounded, the parent gets
 *   `async_launched`, abandons the work it planned around the report, and only
 *   sees the findings in the next turn's `<task-notification>` — after it has
 *   already answered. Forks (agentType `fork`) are not one-shot and still
 *   follow the toggle.
 */
export function allowsImplicitAutoBackground(
  runInBackground: boolean | undefined,
  agentType: string,
): boolean {
  return (
    runInBackground !== false && !ONE_SHOT_BUILTIN_AGENT_TYPES.has(agentType)
  )
}
