/**
 * Config defaults and the two key lists — the factory for a fresh
 * GlobalConfig, the ProjectConfig default, and the `claudin config set`
 * allow-lists with their predicates.
 *
 * DEFAULT_PROJECT_CONFIG and createDefaultGlobalConfig are exported for the
 * sibling modules only; the barrel deliberately does not re-export them,
 * because config.ts never did.
 */
import type {
  GlobalConfig,
  GlobalConfigKey,
  ProjectConfig,
  ProjectConfigKey,
} from 'src/platform/config/config/types.js'

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

/**
 * Factory for a fresh default GlobalConfig. Used instead of deep-cloning a
 * shared constant — the nested containers (arrays, records) are all empty, so
 * a factory gives fresh refs at zero clone cost.
 */
export function createDefaultGlobalConfig(): GlobalConfig {
  const config: GlobalConfig = {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: 'dark',
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    collapseSubagentProgress: true,
    summarizeSubagentResult: false,
    thinkingHistoryRedactionEnabled: true,
    narrationHistoryRedactionEnabled: true,
    toolResultSummarizerEnabled: true,
    showTurnDuration: true,
    showCacheStats: 'compact',
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    cachedStatsigGates: {},
    cachedDynamicConfigs: {},
    cachedGrowthBookFeatures: {},
    respectGitignore: true,
    copyFullResponse: false,
    providerProfiles: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
    knowledgeGraphEnabled: true,
    inlineImagesMode: 'auto',
    autoBackgroundAgentsEnabled: false,
    workflowsDefaultBackground: false,
  }
  return config
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'thinkingHistoryRedactionEnabled',
  'narrationHistoryRedactionEnabled',
  'toolResultSummarizerEnabled',
  'showTurnDuration',
  'showCacheStats',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'copyFullResponse',
  'copyOnSelect',
  'flickerFreeMode',
  'renderFrameRate',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'prStatusHosts',
  'remoteControlAtStartup',
  'remoteDialogSeen',
  'knowledgeGraphEnabled',
  'bashOutputFilterEnabled',
  'bashOutputFilterRewriteEnabled',
  'bashOutputFilterUserEnabled',
  'bashOutputFilterCapEnabled',
  'autoBackgroundAgentsEnabled',
  'repeatedFailureHintEnabled',
  'workflowsDefaultBackground',
  'oauthBrowser',
  'inlineImagesMode',
] as const

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}
