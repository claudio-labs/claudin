import type {
  PermissionRuleSource,
  ToolPermissionRulesBySource,
} from 'src/shared/types/permissions.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import { clearSpeculativeChecks } from 'src/tools/BashTool/bashPermissions.js'

/**
 * Shared harness for the BashTool permission suites.
 *
 * Kept out of the test files themselves because three of them need the same
 * fake ToolUseContext, and because the `as never` below should exist exactly
 * once in the tree rather than once per file.
 */

/** Rule strings as they appear in settings.json, e.g. `Bash(git status:*)`. */
type RuleStrings = readonly string[]

export type PermissionRules = {
  allow?: RuleStrings
  deny?: RuleStrings
  ask?: RuleStrings
}

const RULE_SOURCE: PermissionRuleSource = 'localSettings'

function bySource(rules: RuleStrings | undefined): ToolPermissionRulesBySource {
  if (rules === undefined || rules.length === 0) return {}
  return { [RULE_SOURCE]: [...rules] }
}

/**
 * A ToolPermissionContext carrying the given rules. `mode` defaults to
 * 'default' — the only mode where the rule tables are actually consulted;
 * 'bypassPermissions' and 'auto' short-circuit ahead of them.
 */
export function makePermissionContext(
  rules: PermissionRules = {},
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: bySource(rules.allow),
    alwaysDenyRules: bySource(rules.deny),
    alwaysAskRules: bySource(rules.ask),
    ...overrides,
  }
}

/**
 * A ToolUseContext stub carrying `toolPermissionContext` through getAppState().
 *
 * ToolUseContext has ~25 required members (readFileState, setAppState, the
 * whole options bag) and bashToolHasPermission reads exactly two of them, so a
 * structurally complete fake would be noise. The cast is deliberate and lives
 * only here: if the permission path starts reading a third member, the test
 * fails with a clear TypeError rather than silently type-checking.
 */
export function makeToolUseContext(
  toolPermissionContext: ToolPermissionContext = makePermissionContext(),
  options: { isNonInteractiveSession?: boolean } = {},
): ToolUseContext {
  return {
    abortController: new AbortController(),
    options: {
      isNonInteractiveSession: options.isNonInteractiveSession ?? false,
    },
    getAppState() {
      return { toolPermissionContext }
    },
  } as never
}

type SandboxStatics = {
  isSandboxingEnabled: typeof SandboxManager.isSandboxingEnabled
  isAutoAllowBashIfSandboxedEnabled: typeof SandboxManager.isAutoAllowBashIfSandboxedEnabled
  areUnsandboxedCommandsAllowed: typeof SandboxManager.areUnsandboxedCommandsAllowed
  getExcludedCommands: typeof SandboxManager.getExcludedCommands
}

const SANDBOX_KEYS = [
  'isSandboxingEnabled',
  'isAutoAllowBashIfSandboxedEnabled',
  'areUnsandboxedCommandsAllowed',
  'getExcludedCommands',
] as const

let savedSandboxStatics: SandboxStatics | null = null

/**
 * Overwrite the four SandboxManager statics the permission path consults.
 * Call restoreSandbox() in afterEach — these are static members of a module
 * singleton, so a leak here reaches every later test file in the run.
 */
export function overrideSandbox(overrides: Partial<SandboxStatics>): void {
  if (savedSandboxStatics === null) {
    savedSandboxStatics = {
      isSandboxingEnabled: SandboxManager.isSandboxingEnabled,
      isAutoAllowBashIfSandboxedEnabled:
        SandboxManager.isAutoAllowBashIfSandboxedEnabled,
      areUnsandboxedCommandsAllowed:
        SandboxManager.areUnsandboxedCommandsAllowed,
      getExcludedCommands: SandboxManager.getExcludedCommands,
    }
  }
  Object.assign(SandboxManager, overrides)
}

export function restoreSandbox(): void {
  if (savedSandboxStatics === null) return
  for (const key of SANDBOX_KEYS) {
    Object.assign(SandboxManager, { [key]: savedSandboxStatics[key] })
  }
  savedSandboxStatics = null
}

/**
 * Full teardown for a permission test. `speculativeChecks` is a module-global
 * Map keyed by command text, so without the clear a resolved promise from one
 * test is served to the next one that happens to use the same command.
 */
export function resetPermissionState(): void {
  restoreSandbox()
  clearSpeculativeChecks()
}

/**
 * bashToolHasPermission reads MACRO.VERSION through createPermissionRequestMessage.
 * MACRO.* is inlined by the build and simply absent under `bun test`.
 */
export function stubMacroVersion(): void {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }
}
