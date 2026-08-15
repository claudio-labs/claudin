// Test harness for src/agent/repl/REPL.tsx baseline snapshot tests.
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
//
// Each surface is registered ONCE, under the `src/…` specifier REPL.tsx imports.
// It used to be registered twice, the second time under a relative twin, from
// back when this file and its subjects lived in `src/screens/`. Those twins
// never resolved to anything (there was no `src/screens/hooks/`), and the reorg
// re-derived them into `../../../screens/…`, which named the retired catch-all
// while mocking nothing. Do not reintroduce a twin: Bun keys a module mock by
// the specifier STRING, so a second registration only matters when a real
// importer spells it that way.

import { mock } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import type { Tool } from 'src/tools/Tool.js'
import type { Props as REPLProps } from 'src/agent/repl/REPL.js'
import type { ThinkingConfig } from 'src/agent/context/thinking.js'

// --- mock factories ------------------------------------------------------

function noop(): void {
  /* empty */
}

function returnEmptyObject(): Record<string, never> {
  return {}
}

// The footer effort indicator resolves from CLAUDE_CODE_EFFORT_LEVEL →
// appState → settings.json. Left unpinned, snapshots capture the developer's
// personal `effortLevel` (e.g. "high") in isolation but the clean default
// ("medium") under the full suite, making them non-deterministic. Pin the env
// override so the rendered tree is stable regardless of ambient settings.
const REPL_SNAPSHOT_EFFORT = 'medium'
const REPL_SNAPSHOT_MODEL = 'claude-sonnet-4-6'
let savedEffortEnv: string | undefined
let effortEnvWasSet = false

// The footer status line renders seamless Powerline segments when
// hasNerdFontGlyphs() is true and a bracketed ASCII fallback (`[ ◐ medium ]…`)
// otherwise. That heuristic keys off TERM/TERM_PROGRAM, so the style flips
// between machines (a dev terminal like kitty/ghostty gets the glyph form the
// snapshots were recorded with, while a CI runner with a plain TERM gets the
// bracketed fallback). Force the glyph form so the status line matches the
// recorded snapshots regardless of the ambient terminal.
let savedNerdFontEnv: string | undefined
let nerdFontEnvWasSet = false

// The footer/banner render the working directory, home-relativized to `~/…`.
// Left unpinned this bakes the developer's real checkout path into the
// snapshots (`~/projects/claudin`), which then mismatches any other checkout
// location — e.g. CI runners at `~/work/claudin/claudin`. Pin it to a stable
// home-relative path so the rendered `~/projects/claudin` is identical on
// every machine regardless of where the repo actually lives.
const REPL_SNAPSHOT_CWD = join(homedir(), 'projects', 'claudin')
let savedOriginalCwd: string | undefined
let savedCwdState: string | undefined
let savedProcessCwd: (() => string) | undefined

// Snapshot the real hook module so teardown can restore it (mock.restore()
// does not revert mock.module()), preventing the pinned model from leaking.
const realUseMainLoopModel = { ...(await import('src/agent/hooks/useMainLoopModel.js')) }
// Same for the API-key hook stubbed in setupReplMocks below — without a restore
// its `status: 'valid'` stub leaks into useApiKeyVerification.test.tsx (which
// cache-busts a fresh import of the real hook and waits for 'missing'), hanging
// it until timeout. Plain snapshot so the live namespace can't re-mock it.
const realUseApiKeyVerification = {
  ...(await import('src/providers/hooks/useApiKeyVerification.js')),
}

export function setupReplMocks(): void {
  savedEffortEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL
  effortEnvWasSet = true
  process.env.CLAUDE_CODE_EFFORT_LEVEL = REPL_SNAPSHOT_EFFORT

  savedNerdFontEnv = process.env.CLAUDIN_NERD_FONT
  nerdFontEnvWasSet = true
  process.env.CLAUDIN_NERD_FONT = '1'

  // Pin the working directory so the footer/banner render a machine-independent
  // `~/projects/claudin` (see REPL_SNAPSHOT_CWD above).
  savedOriginalCwd = getOriginalCwd()
  savedCwdState = getCwdState()
  setOriginalCwd(REPL_SNAPSHOT_CWD)
  setCwdState(REPL_SNAPSHOT_CWD)
  // The startup logo (StartupScreen.ts) reads process.cwd() directly rather
  // than the STATE cwd, so pinning STATE alone leaves the banner path
  // machine-dependent. Override process.cwd() too so every cwd source renders
  // the same home-relative path.
  savedProcessCwd = process.cwd
  process.cwd = () => REPL_SNAPSHOT_CWD

  // MACRO.* is a build-time replacement; in unit tests there's no bundler,
  // so REPL reads from globalThis.MACRO at runtime. Pin it UNCONDITIONALLY so
  // the banner version is deterministic — an earlier test in the same worker
  // may have already installed a different MACRO (e.g. DISPLAY_VERSION
  // '0.0.0-test'), which the prior `typeof VERSION === 'string'` guard would
  // have let leak through into these snapshots.
  const macro = (globalThis as Record<string, unknown>).MACRO as
    | Record<string, unknown>
    | undefined
  ;(globalThis as Record<string, unknown>).MACRO = {
    ...(macro ?? {}),
    VERSION: 'test-version',
    DISPLAY_VERSION: 'test-version',
    BUILD_TIME: 'test-build-time',
  }

  // The banner model comes from useMainLoopModel() → active profile / config,
  // which resolves to the developer's personal model in isolation but the
  // clean default under the full suite. Pin it so snapshots are stable.
  mock.module('src/agent/hooks/useMainLoopModel.js', () => ({
    useMainLoopModel: () => REPL_SNAPSHOT_MODEL,
  }))

  // Side-effecting service: starts an interval that keeps the OS awake.
  mock.module('src/platform/preventSleep.js', () => ({
    startPreventSleep: noop,
    stopPreventSleep: noop,
  }))

  // Bridge to the REPL transport (websocket/IPC). Returns a handle object
  // in real code; we just need the hook to be a no-op for mount.
  mock.module('src/platform/bridge/useReplBridge.js', () => ({
    useReplBridge: () => ({ sendBridgeResult: noop }),
    BRIDGE_FAILURE_DISMISS_MS: 10_000,
  }))

  // Mailbox bridge — polls the on-disk mailbox for cross-session messages.
  mock.module('src/platform/bridge/useMailboxBridge.js', () => ({
    useMailboxBridge: noop,
  }))

  // Remote session — opens a CCR session when --remote is set.
  mock.module('src/sessions/hooks/useRemoteSession.js', () => ({
    useRemoteSession: () => ({ state: 'idle', error: null }),
  }))

  // Direct connect — connects to a claudin server.
  mock.module('src/providers/hooks/useDirectConnect.js', () => ({
    useDirectConnect: () => ({ state: 'idle', error: null }),
  }))

  // SSH session.
  mock.module('src/sessions/hooks/useSSHSession.js', () => ({
    useSSHSession: () => ({ state: 'idle', error: null }),
  }))

  // Swarm initialization — spawns worker processes and creates files.
  mock.module('src/agent/coordinator/hooks/useSwarmInitialization.js', () => ({
    useSwarmInitialization: noop,
  }))

  // Scheduled tasks — owns a cron scheduler instance.
  mock.module('src/agent/hooks/useScheduledTasks.js', () => ({
    useScheduledTasks: noop,
  }))

  // Feedback surveys — read/write survey state on disk.
  mock.module(
    'src/platform/feedback/useFeedbackSurvey.js',
    () => ({
      useFeedbackSurvey: () => ({ state: 'closed' }),
    }),
  )
  mock.module(
    'src/platform/feedback/useMemorySurvey.js',
    () => ({
      useMemorySurvey: () => ({ state: 'closed' }),
    }),
  )
  mock.module(
    'src/platform/feedback/usePostCompactSurvey.js',
    () => ({
      usePostCompactSurvey: () => ({ state: 'closed' }),
    }),
  )

  // IDE integration — opens a websocket to the IDE plugin.
  mock.module('src/platform/ide/useIDEIntegration.js', () => ({
    useIDEIntegration: () => ({
      ideInstallationStatus: null,
      mcpClientState: { type: 'idle' },
    }),
  }))

  // File history snapshot init — writes to ~/.claudin.
  mock.module('src/sessions/hooks/useFileHistorySnapshotInit.js', () => ({
    useFileHistorySnapshotInit: noop,
  }))

  // Inbox poller — interval that reads the inbox dir.
  mock.module('src/terminal/voice/useInboxPoller.js', () => ({
    useInboxPoller: noop,
  }))

  // Background housekeeping — interval that GCs caches.
  mock.module('src/platform/backgroundHousekeeping.js', () => ({
    startBackgroundHousekeeping: () => () => undefined,
  }))

  // Notifier — intentionally NOT module-mocked. Every hook that actually
  // *calls* sendNotification (useAwaySummary, useInstallMessages, the
  // notifs/* bundle, etc.) is already stubbed to a no-op above, so the real
  // notifier is never invoked during a snapshot mount. Mocking the whole
  // notifier.js module here used to leak: mock.module() persists across files
  // (teardown's mock.restore() does not undo it), and the stub then poisoned
  // notifier.platform.test.ts, which imports the real ./notifier.js as its SUT.

  // Session start hooks — runs user-defined commands.
  mock.module('src/sessions/sessionStart.js', () => ({
    processSessionStartHooks: async () => [],
  }))

  // Plugin startup checks — disk I/O.
  mock.module('src/plugins/performStartupChecks.js', () => ({
    performStartupChecks: async () => undefined,
  }))

  // Notification hook bundle — many of these are tiny but they all read
  // settings; mock to bare returns to avoid noise.
  const noopHook = (): unknown => undefined
  mock.module(
    'src/platform/notifications/useInstallMessages.js',
    () => ({ useInstallMessages: noopHook }),
  )
  mock.module(
    'src/agent/hooks/useAwaySummary.js',
    () => ({ useAwaySummary: noopHook }),
  )
  mock.module(
    'src/platform/useOfficialMarketplaceNotification.js',
    () => ({ useOfficialMarketplaceNotification: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useSettingsErrors.js',
    () => ({ useSettingsErrors: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useMcpConnectivityStatus.js',
    () => ({ useMcpConnectivityStatus: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useAutoModeUnavailableNotification.js',
    () => ({ useAutoModeUnavailableNotification: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useLspInitializationNotification.js',
    () => ({ useLspInitializationNotification: noopHook }),
  )
  mock.module(
    'src/platform/useClaudeCodeHintRecommendation.js',
    () => ({
      useClaudeCodeHintRecommendation: () => ({
        recommendation: null,
        clearRecommendation: noop,
      }),
    }),
  )
  mock.module(
    'src/platform/notifications/usePluginInstallationStatus.js',
    () => ({ usePluginInstallationStatus: noopHook }),
  )
  mock.module(
    'src/platform/notifications/usePluginAutoupdateNotification.js',
    () => ({ usePluginAutoupdateNotification: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useRateLimitWarningNotification.js',
    () => ({ useRateLimitWarningNotification: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useDeprecationWarningNotification.js',
    () => ({ useDeprecationWarningNotification: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useNpmDeprecationNotification.js',
    () => ({ useNpmDeprecationNotification: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useIDEStatusIndicator.js',
    () => ({ useIDEStatusIndicator: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useModelMigrationNotifications.js',
    () => ({ useModelMigrationNotifications: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useCanSwitchToExistingSubscription.js',
    () => ({ useCanSwitchToExistingSubscription: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useTeammateShutdownNotification.js',
    () => ({ useTeammateLifecycleNotification: noopHook }),
  )
  mock.module(
    'src/platform/notifications/useFastModeNotification.js',
    () => ({ useFastModeNotification: noopHook }),
  )
  // useFrustrationDetection is NOT mocked: the module behind it never reached
  // this fork, so REPL.tsx declares a hardcoded `state: 'closed'` dummy inline
  // (see the .d.ts stub comment there). There is nothing to intercept.

  // StatusNotices throws "Configure Anthropic profile" because no provider
  // is configured under a test env. Ink turns the throw into a full-screen
  // error overlay, which would swallow the entire REPL tree in our
  // snapshots and defeat their purpose. Stub to render nothing.
  mock.module('src/platform/status/StatusNotices.js', () => ({
    StatusNotices: () => null,
  }))

  // API key verification fires a network request on mount.
  mock.module('src/providers/hooks/useApiKeyVerification.js', () => ({
    useApiKeyVerification: () => ({
      status: 'valid',
      reverify: returnEmptyObject,
    }),
  }))
}

export function teardownReplMocks(): void {
  mock.restore()
  // mock.restore() does not revert mock.module(); restore the pinned hook.
  mock.module('src/agent/hooks/useMainLoopModel.js', () => realUseMainLoopModel)
  mock.module('src/providers/hooks/useApiKeyVerification.js', () => realUseApiKeyVerification)
  if (effortEnvWasSet) {
    if (savedEffortEnv === undefined) {
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    } else {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = savedEffortEnv
    }
    effortEnvWasSet = false
  }
  if (nerdFontEnvWasSet) {
    if (savedNerdFontEnv === undefined) {
      delete process.env.CLAUDIN_NERD_FONT
    } else {
      process.env.CLAUDIN_NERD_FONT = savedNerdFontEnv
    }
    nerdFontEnvWasSet = false
  }
  if (savedOriginalCwd !== undefined) {
    setOriginalCwd(savedOriginalCwd)
    savedOriginalCwd = undefined
  }
  if (savedCwdState !== undefined) {
    setCwdState(savedCwdState)
    savedCwdState = undefined
  }
  if (savedProcessCwd !== undefined) {
    process.cwd = savedProcessCwd
    savedProcessCwd = undefined
  }
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
