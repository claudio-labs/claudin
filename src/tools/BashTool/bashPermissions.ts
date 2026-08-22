/**
 * Bash permission checking — barrel over ./bashPermissions/.
 *
 * The ~20 call sites across the codebase keep importing from here; new code
 * should prefer importing directly from the relevant submodule.
 *
 * Splitting layout:
 *   wrappers.ts     — SAFE_ENV_VARS, stripSafeWrappers, stripAllLeadingEnvVars,
 *                     BINARY_HIJACK_VARS
 *   prefixes.ts     — getSimpleCommandPrefix, getFirstWordPrefix,
 *                     extractPrefixBeforeHeredoc
 *   suggestions.ts  — suggestionForExactCommand/ForPrefix plus the three
 *                     pass-throughs to src/permissions/shellRuleMatching.js
 *   ruleMatching.ts — the allow/deny/ask rule tables and the two checks on them
 *   speculative.ts  — the allow classifier: speculativeChecks and its consumers
 *                     (the only mutable module state in this cluster)
 *   gates.ts        — the individual gates decide.ts runs a command through,
 *                     plus the normalized cd/git detectors
 *   decide.ts       — bashToolHasPermission, the 15-phase pipeline
 */

export {
  BINARY_HIJACK_VARS,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from 'src/tools/BashTool/bashPermissions/wrappers.js'
export {
  extractPrefixBeforeHeredoc,
  getFirstWordPrefix,
  getSimpleCommandPrefix,
} from 'src/tools/BashTool/bashPermissions/prefixes.js'
export {
  bashPermissionRule,
  matchWildcardPattern,
  permissionRuleExtractPrefix,
  suggestionForExactCommand,
  suggestionForPrefix,
} from 'src/tools/BashTool/bashPermissions/suggestions.js'
export {
  bashToolCheckExactMatchPermission,
  bashToolCheckPermission,
  matchingRulesForInput,
} from 'src/tools/BashTool/bashPermissions/ruleMatching.js'
export {
  checkCommandAndSuggestRules,
  checkEarlyExitDeny,
  checkSandboxAutoAllow,
  checkSemanticsDeny,
  commandHasAnyCd,
  filterCdCwdSubcommands,
  isNormalizedCdCommand,
  isNormalizedGitCommand,
} from 'src/tools/BashTool/bashPermissions/gates.js'
export {
  awaitClassifierAutoApproval,
  buildPendingClassifierCheck,
  clearSpeculativeChecks,
  consumeSpeculativeClassifierCheck,
  executeAsyncClassifierCheck,
  logClassifierResultForAnts,
  peekSpeculativeClassifierCheck,
  startSpeculativeClassifierCheck,
} from 'src/tools/BashTool/bashPermissions/speculative.js'
export {
  bashToolHasPermission,
  MAX_SUBCOMMANDS_FOR_SECURITY_CHECK,
  MAX_SUGGESTED_RULES_FOR_COMPOUND,
} from 'src/tools/BashTool/bashPermissions/decide.js'
