// Barrel of every module the default-action handler needs.
//
// We import these as a single dynamic chunk from src/main.tsx so that the
// `--help`, `--version`, and every subcommand path (which never enters the
// default action) doesn't pay the cost of evaluating them. Each of these
// modules transitively pulls heavy graphs (interactiveHelpers → React/Ink,
// runMcpAndPerms → mcp services, runDefaultActionDispatch → REPL surface,
// etc.), so collapsing them into one barrel lets us defer the *whole* graph
// with a single `await import('./main/defaultActionDeps.js')`.
//
// Phase C of cold-start plan.

export { parseActionOptions } from './action/parseOptions.js'
export type { ActionOptions } from './action/parseOptions.js'
export { runMcpAndPerms } from './action/mcpAndPerms.js'
export { runActionAgentSetup, runActionPostSetup, runActionSetup } from './action/setupAgent.js'
export { runTrustAndOnboarding } from './action/trustAndOnboarding.js'
export { runInteractiveStartupBlock, runMcpHooksAndTelemetry, runPostHeadlessGuards } from './action/startupSequence.js'
export { runDefaultActionDispatch } from './defaultAction/dispatch.js'
