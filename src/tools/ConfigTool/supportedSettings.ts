import { feature } from 'bun:bundle'
import {
  getRemoteControlAtStartup,
  SHOW_CACHE_STATS_MODES,
} from 'src/platform/config/config.js'
import {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
  TEAMMATE_MODES,
} from 'src/platform/config/configConstants.js'
import { getModelOptions } from 'src/providers/model/modelOptions.js'
import { validateModel } from 'src/providers/model/validateModel.js'
import { THEME_NAMES, THEME_SETTINGS } from 'src/terminal/theme/theme.js'

/** AppState keys that can be synced for immediate UI effect */
type SyncableAppStateKey =
  | 'verbose'
  | 'mainLoopModel'
  | 'thinkingEnabled'
  | 'collapseSubagentProgress'

type SettingConfig = {
  source: 'global' | 'settings'
  type: 'boolean' | 'string'
  description: string
  path?: string[]
  options?: readonly string[]
  getOptions?: () => string[]
  appStateKey?: SyncableAppStateKey
  /** Async validation called when writing/setting a value */
  validateOnWrite?: (v: unknown) => Promise<{ valid: boolean; error?: string }>
  /** Format value when reading/getting for display */
  formatOnRead?: (v: unknown) => unknown
}

export const SUPPORTED_SETTINGS: Record<string, SettingConfig> = {
  theme: {
    source: 'global',
    type: 'string',
    description: 'Color theme for the UI',
    options: feature('AUTO_THEME') ? THEME_SETTINGS : THEME_NAMES,
  },
  editorMode: {
    source: 'global',
    type: 'string',
    description: 'Key binding mode',
    options: EDITOR_MODES,
  },
  verbose: {
    source: 'global',
    type: 'boolean',
    description: 'Show detailed debug output',
    appStateKey: 'verbose',
  },
  preferredNotifChannel: {
    source: 'global',
    type: 'string',
    description: 'Preferred notification channel',
    options: NOTIFICATION_CHANNELS,
  },
  autoCompactEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Auto-compact when context is full',
  },
  collapseSubagentProgress: {
    source: 'global',
    type: 'boolean',
    description: 'Collapse subagent progress to a single line on the main thread',
    appStateKey: 'collapseSubagentProgress',
  },
  collapseFileWritesEnabled: {
    source: 'global',
    type: 'boolean',
    description:
      'Fold Write/Edit/apply_patch/Rename into the collapsed read/search row (diffs stay behind ctrl+o)',
  },
  summarizeSubagentResult: {
    source: 'global',
    type: 'boolean',
    description: 'Summarize a subagent result before returning it to the parent (slower, lossy)',
  },
  autoMemoryEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable auto-memory',
  },
  autoDreamEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable background memory consolidation',
  },
  fileCheckpointingEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Enable file checkpointing for code rewind',
  },
  showTurnDuration: {
    source: 'global',
    type: 'boolean',
    description:
      'Show turn duration message after responses (e.g., "Cooked for 1m 6s")',
  },
  showCacheStats: {
    source: 'global',
    type: 'string',
    description:
      'Show per-query cache hit/miss summary at end of turn (off | compact | full)',
    options: SHOW_CACHE_STATS_MODES,
  },
  terminalProgressBarEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Show OSC 9;4 progress indicator in supported terminals',
  },
  todoFeatureEnabled: {
    source: 'global',
    type: 'boolean',
    description: 'Enable todo/task tracking',
  },
  model: {
    source: 'settings',
    type: 'string',
    description: 'Override the default model',
    appStateKey: 'mainLoopModel',
    getOptions: () => {
      try {
        return getModelOptions()
          .filter(o => o.value !== null)
          .map(o => o.value as string)
      } catch {
        return ['sonnet', 'opus', 'haiku']
      }
    },
    validateOnWrite: v => validateModel(String(v)),
    formatOnRead: v => (v === null ? 'default' : v),
  },
  alwaysThinkingEnabled: {
    source: 'settings',
    type: 'boolean',
    description: 'Enable extended thinking (false to disable)',
    appStateKey: 'thinkingEnabled',
  },
  'permissions.defaultMode': {
    source: 'settings',
    type: 'string',
    description: 'Default permission mode for tool usage',
    options: feature('TRANSCRIPT_CLASSIFIER')
      ? ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto']
      : ['default', 'plan', 'acceptEdits', 'dontAsk'],
  },
  language: {
    source: 'settings',
    type: 'string',
    description:
      'Preferred language for Claude responses and voice dictation (e.g., "japanese", "spanish")',
  },
  teammateMode: {
    source: 'global',
    type: 'string',
    description:
      'How to spawn teammates: "tmux" for traditional tmux, "in-process" for same process, "auto" to choose automatically',
    options: TEAMMATE_MODES,
  },
  ...(feature('VOICE_MODE')
    ? {
        voiceEnabled: {
          source: 'settings' as const,
          type: 'boolean' as const,
          description: 'Enable voice dictation (hold-to-talk)',
        },
      }
    : {}),
  ...(feature('BRIDGE_MODE')
    ? {
        remoteControlAtStartup: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Enable Remote Control for all sessions (true | false | default)',
          formatOnRead: () => getRemoteControlAtStartup(),
        },
      }
    : {}),
  ...(feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? {
        taskCompleteNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Push to your mobile device when idle after Claude finishes (requires Remote Control)',
        },
        inputNeededNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Push to your mobile device when a permission prompt or question is waiting (requires Remote Control)',
        },
        agentPushNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Allow Claude to push to your mobile device when it deems it appropriate (requires Remote Control)',
        },
      }
    : {}),
}

export function isSupported(key: string): boolean {
  return key in SUPPORTED_SETTINGS
}

export function getConfig(key: string): SettingConfig | undefined {
  return SUPPORTED_SETTINGS[key]
}


export function getOptionsForSetting(key: string): string[] | undefined {
  const config = SUPPORTED_SETTINGS[key]
  if (!config) return undefined
  if (config.options) return [...config.options]
  if (config.getOptions) return config.getOptions()
  return undefined
}

export function getPath(key: string): string[] {
  const config = SUPPORTED_SETTINGS[key]
  return config?.path ?? key.split('.')
}
