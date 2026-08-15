// Barrel of every module the default-action handler needs.
//
// We import these as a single dynamic chunk from src/platform/main.tsx so that the
// `--help`, `--version`, and every subcommand path (which never enters the
// default action) doesn't pay the cost of evaluating them. Each of these
// modules transitively pulls heavy graphs (interactiveHelpers → React/Ink,
// runMcpAndPerms → mcp services, runDefaultActionDispatch → REPL surface,
// etc.), so collapsing them into one barrel lets us defer the *whole* graph
// with a single `await import('./main/defaultActionDeps.js')`.
//
// Phase C of cold-start plan.

export { parseActionOptions } from 'src/platform/main/action/parseOptions.js'
export type { ActionOptions } from 'src/platform/main/action/parseOptions.js'
export { runMcpAndPerms } from 'src/platform/main/action/mcpAndPerms.js'
export { runActionAgentSetup, runActionPostSetup, runActionSetup } from 'src/platform/main/action/setupAgent.js'
export { runTrustAndOnboarding } from 'src/platform/main/action/trustAndOnboarding.js'
export { runInteractiveStartupBlock, runMcpHooksAndTelemetry, runPostHeadlessGuards } from 'src/platform/main/action/startupSequence.js'
export { runDefaultActionDispatch } from 'src/platform/main/defaultAction/dispatch.js'
