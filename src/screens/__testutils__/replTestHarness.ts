// Test harness for src/screens/REPL.tsx baseline snapshot tests.
//
// Mounting <REPL> for real triggers a long fan-out of side-effects: prevent-
// sleep timers, mailbox bridge polling, swarm initialization, scheduled-task
// cron, surveys, IDE connection, etc. Each of those touches I/O, network,
// timers or process globals and will keep the test alive past the snapshot.
//
// `setupReplMocks()` replaces every such surface with a no-op via
// `mock.module(...)` so `renderToString(<REPL />)` only exercises the React
// tree. Call `teardownReplMocks()` from `afterAll` to restore — without
// explicit restore, mocks leak across test files (see team memory:
// bun-test-global-config-isolation).
//
// Iterating: when a test discovers a new mount-side-effect, add a mock here
// and document it inline so the next agent knows which surface it covered.

import { mock } from 'bun:test'
import type { Tool } from '../../Tool.js'
import type { Props as REPLProps } from '../REPL.js'
import type { ThinkingConfig } from '../../utils/thinking.js'

// --- mock factories ------------------------------------------------------

function noop(): void {
  /* empty */
}

function returnEmptyObject(): Record<string, never> {
  return {}
}

export function setupReplMocks(): void {
  // MACRO.* is a build-time replacement; in unit tests there's no bundler,
  // so REPL reads from globalThis.MACRO at runtime. Mirror what
  // StartupBanner.test.tsx does.
  const macro = (globalThis as Record<string, unknown>).MACRO as
    | Record<string, unknown>
    | undefined
  if (!macro || typeof macro.VERSION !== 'string') {
    ;(globalThis as Record<string, unknown>).MACRO = {
      VERSION: 'test-version',
      DISPLAY_VERSION: 'test-version',
      BUILD_TIME: 'test-build-time',
      ...(macro ?? {}),
    }
  }

  // Side-effecting service: starts an interval that keeps the OS awake.
  mock.module('src/services/preventSleep.js', () => ({
    startPreventSleep: noop,
    stopPreventSleep: noop,
  }))
  // Relative path twin (REPL.tsx imports as `../services/preventSleep.js`).
  mock.module('../services/preventSleep.js', () => ({
    startPreventSleep: noop,
    stopPreventSleep: noop,
  }))

  // Bridge to the REPL transport (websocket/IPC). Returns a handle object
  // in real code; we just need the hook to be a no-op for mount.
  mock.module('src/hooks/useReplBridge.js', () => ({
    useReplBridge: () => ({ sendBridgeResult: noop }),
    BRIDGE_FAILURE_DISMISS_MS: 10_000,
  }))
  mock.module('../hooks/useReplBridge.js', () => ({
    useReplBridge: () => ({ sendBridgeResult: noop }),
    BRIDGE_FAILURE_DISMISS_MS: 10_000,
  }))

  // Mailbox bridge — polls the on-disk mailbox for cross-session messages.
  mock.module('src/hooks/useMailboxBridge.js', () => ({
    useMailboxBridge: noop,
  }))
  mock.module('../hooks/useMailboxBridge.js', () => ({
    useMailboxBridge: noop,
  }))

  // Remote session — opens a CCR session when --remote is set.
  mock.module('src/hooks/useRemoteSession.js', () => ({
    useRemoteSession: () => ({ state: 'idle', error: null }),
  }))
  mock.module('../hooks/useRemoteSession.js', () => ({
    useRemoteSession: () => ({ state: 'idle', error: null }),
  }))

  // Direct connect — connects to a claudin server.
  mock.module('src/hooks/useDirectConnect.js', () => ({
    useDirectConnect: () => ({ state: 'idle', error: null }),
  }))
  mock.module('../hooks/useDirectConnect.js', () => ({
    useDirectConnect: () => ({ state: 'idle', error: null }),
  }))

  // SSH session.
  mock.module('src/hooks/useSSHSession.js', () => ({
    useSSHSession: () => ({ state: 'idle', error: null }),
  }))
  mock.module('../hooks/useSSHSession.js', () => ({
    useSSHSession: () => ({ state: 'idle', error: null }),
  }))

  // Swarm initialization — spawns worker processes and creates files.
  mock.module('src/hooks/useSwarmInitialization.js', () => ({
    useSwarmInitialization: noop,
  }))
  mock.module('../hooks/useSwarmInitialization.js', () => ({
    useSwarmInitialization: noop,
  }))

  // Scheduled tasks — owns a cron scheduler instance.
  mock.module('src/hooks/useScheduledTasks.js', () => ({
    useScheduledTasks: noop,
  }))
  mock.module('../hooks/useScheduledTasks.js', () => ({
    useScheduledTasks: noop,
  }))

  // Feedback surveys — read/write survey state on disk.
  mock.module(
    'src/components/FeedbackSurvey/useFeedbackSurvey.js',
    () => ({
      useFeedbackSurvey: () => ({ state: 'closed' }),
    }),
  )
  mock.module(
    'src/components/FeedbackSurvey/useMemorySurvey.js',
    () => ({
      useMemorySurvey: () => ({ state: 'closed' }),
    }),
  )
  mock.module(
    'src/components/FeedbackSurvey/usePostCompactSurvey.js',
    () => ({
      usePostCompactSurvey: () => ({ state: 'closed' }),
    }),
  )

  // IDE integration — opens a websocket to the IDE plugin.
  mock.module('src/hooks/useIDEIntegration.js', () => ({
    useIDEIntegration: () => ({
      ideInstallationStatus: null,
      mcpClientState: { type: 'idle' },
    }),
  }))
  mock.module('../hooks/useIDEIntegration.js', () => ({
    useIDEIntegration: () => ({
      ideInstallationStatus: null,
      mcpClientState: { type: 'idle' },
    }),
  }))

  // File history snapshot init — writes to ~/.claudin.
  mock.module('src/hooks/useFileHistorySnapshotInit.js', () => ({
    useFileHistorySnapshotInit: noop,
  }))
  mock.module('../hooks/useFileHistorySnapshotInit.js', () => ({
    useFileHistorySnapshotInit: noop,
  }))

  // Inbox poller — interval that reads the inbox dir.
  mock.module('src/hooks/useInboxPoller.js', () => ({
    useInboxPoller: noop,
  }))
  mock.module('../hooks/useInboxPoller.js', () => ({
    useInboxPoller: noop,
  }))

  // Background housekeeping — interval that GCs caches.
  mock.module('src/utils/backgroundHousekeeping.js', () => ({
    startBackgroundHousekeeping: () => () => undefined,
  }))
  mock.module('../utils/backgroundHousekeeping.js', () => ({
    startBackgroundHousekeeping: () => () => undefined,
  }))

  // Notifier — sends OS notifications.
  mock.module('src/services/notifier.js', () => ({
    sendNotification: noop,
  }))
  mock.module('../services/notifier.js', () => ({
    sendNotification: noop,
  }))

  // Session start hooks — runs user-defined commands.
  mock.module('src/utils/sessionStart.js', () => ({
    processSessionStartHooks: async () => [],
  }))
  mock.module('../utils/sessionStart.js', () => ({
    processSessionStartHooks: async () => [],
  }))

  // Plugin startup checks — disk I/O.
  mock.module('src/utils/plugins/performStartupChecks.js', () => ({
    performStartupChecks: async () => undefined,
  }))

  // Notification hook bundle — many of these are tiny but they all read
  // settings; mock to bare returns to avoid noise.
  const noopHook = (): unknown => undefined
  const closedSurvey = (): { state: string } => ({ state: 'closed' })
  mock.module(
    'src/hooks/notifs/useInstallMessages.js',
    () => ({ useInstallMessages: noopHook }),
  )
  mock.module(
    'src/hooks/useAwaySummary.js',
    () => ({ useAwaySummary: noopHook }),
  )
  mock.module(
    'src/hooks/useOfficialMarketplaceNotification.js',
    () => ({ useOfficialMarketplaceNotification: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useSettingsErrors.js',
    () => ({ useSettingsErrors: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useMcpConnectivityStatus.js',
    () => ({ useMcpConnectivityStatus: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useAutoModeUnavailableNotification.js',
    () => ({ useAutoModeUnavailableNotification: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useLspInitializationNotification.js',
    () => ({ useLspInitializationNotification: noopHook }),
  )
  mock.module(
    'src/hooks/useClaudeCodeHintRecommendation.js',
    () => ({
      useClaudeCodeHintRecommendation: () => ({
        recommendation: null,
        clearRecommendation: noop,
      }),
    }),
  )
  mock.module(
    'src/hooks/notifs/usePluginInstallationStatus.js',
    () => ({ usePluginInstallationStatus: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/usePluginAutoupdateNotification.js',
    () => ({ usePluginAutoupdateNotification: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useRateLimitWarningNotification.js',
    () => ({ useRateLimitWarningNotification: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useDeprecationWarningNotification.js',
    () => ({ useDeprecationWarningNotification: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useNpmDeprecationNotification.js',
    () => ({ useNpmDeprecationNotification: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useIDEStatusIndicator.js',
    () => ({ useIDEStatusIndicator: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useModelMigrationNotifications.js',
    () => ({ useModelMigrationNotifications: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useCanSwitchToExistingSubscription.js',
    () => ({ useCanSwitchToExistingSubscription: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useTeammateShutdownNotification.js',
    () => ({ useTeammateLifecycleNotification: noopHook }),
  )
  mock.module(
    'src/hooks/notifs/useFastModeNotification.js',
    () => ({ useFastModeNotification: noopHook }),
  )
  mock.module(
    'src/hooks/useFrustrationDetection.js',
    () => ({
      useFrustrationDetection: closedSurvey,
    }),
  )

  // StatusNotices throws "Configure Anthropic profile" because no provider
  // is configured under a test env. Ink turns the throw into a full-screen
  // error overlay, which would swallow the entire REPL tree in our
  // snapshots and defeat their purpose. Stub to render nothing.
  mock.module('src/components/StatusNotices.js', () => ({
    StatusNotices: () => null,
  }))
  mock.module('../components/StatusNotices.js', () => ({
    StatusNotices: () => null,
  }))

  // API key verification fires a network request on mount.
  mock.module('src/hooks/useApiKeyVerification.js', () => ({
    useApiKeyVerification: () => ({
      status: 'valid',
      reverify: returnEmptyObject,
    }),
  }))
  mock.module('../hooks/useApiKeyVerification.js', () => ({
    useApiKeyVerification: () => ({
      status: 'valid',
      reverify: returnEmptyObject,
    }),
  }))
}

export function teardownReplMocks(): void {
  mock.restore()
}

// --- prop factory --------------------------------------------------------

const DEFAULT_THINKING_CONFIG: ThinkingConfig = { type: 'disabled' }

const STUB_TOOL: Tool = {
  name: 'StubTool',
  description: async () => 'stub',
  prompt: async () => 'stub',
  inputSchema: {
    safeParse: () => ({ success: true, data: {} }),
  } as unknown as Tool['inputSchema'],
  isReadOnly: () => true,
  isEnabled: async () => true,
  needsPermissions: () => false,
  renderToolUseMessage: () => '',
  renderResultForAssistant: (data: unknown) => String(data ?? ''),
  // The rest of Tool's optional surface is left undefined on purpose —
  // baseline snapshot tests don't exercise execution paths.
} as unknown as Tool

export function mockReplProps(overrides: Partial<REPLProps> = {}): REPLProps {
  const base: REPLProps = {
    commands: [],
    debug: false,
    initialTools: [STUB_TOOL],
    thinkingConfig: DEFAULT_THINKING_CONFIG,
  }
  return { ...base, ...overrides }
}
