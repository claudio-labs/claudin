/**
 * The move manifest for the screaming-architecture reorg.
 *
 * Goal: the top level of `src/` names the PRODUCT (agent loop, providers, tools,
 * commands, version control, memory, permissions, sessions, MCP, skills, plugins,
 * platform, terminal) instead of the framework layers it used to name
 * (`services/`, `components/`, `utils/`, `hooks/`). Nothing here changes
 * behavior — every entry is a `git mv` plus the import rewrite `apply.ts` does.
 *
 * Order matters, twice over:
 *
 *  1. Groups run in the order they appear, one commit each, so `bisect-leak.ts`
 *     has something to bisect when an UNRELATED test breaks. Bun applies
 *     module-scope `mock.module()` for the whole run and the winner is whoever
 *     registered last during the load phase — which is directory-walk order. Any
 *     move reorders that walk, so an unrelated failure is the expected failure
 *     mode here, not a surprise.
 *
 *  2. Within a group `dirs` are collected before `files`, and the first claim on
 *     a source path wins (`apply.ts` dedups). That is what lets a split work:
 *     put the FileMoves that carve pieces out of a directory in an EARLIER group
 *     than the DirMove that sweeps up the remainder — see `constants-split`
 *     before `constants-rest`.
 *
 * `model-and-effort` is deliberately LAST and deliberately droppable. Moving
 * `src/utils/model/` makes it load earlier than it does today, and the previous
 * reorg measured that at 13 unrelated failures across withRetry, apiPreconnect,
 * officialRegistry and the model tests: `utils/model/{sonnet5,opus5}.test.ts` pin
 * `providers.js` to 'firstParty' late in the walk, which is what contains
 * `effort.kimi.test.ts`'s 'openai' pin. `utils/effort.*` is the other half of
 * that pair, so the two move together or not at all. If the pin cannot be given
 * a single cooperative owner cheaply, drop this group and leave `src/utils/`
 * alive with those 52 files.
 *
 * `apply.ts` reads this, moves with `git mv`, drags each test's `__snapshots__`
 * entry along, and rewrites the `src/…` specifier in every importer.
 */

/** A whole directory, moved with everything under it. */
export type DirMove = { readonly from: string; readonly to: string }

/** Named files lifted out of one directory into a destination (names unchanged). */
export type FileMove = {
  readonly from: string
  readonly files: readonly string[]
  readonly to: string
}

export type Group = {
  readonly name: string
  readonly dirs?: readonly DirMove[]
  readonly files?: readonly FileMove[]
}

export const GROUPS: readonly Group[] = [
  {
    // Pure primitives with no domain. First on purpose: everything imports these,
    // so a broken rewrite shows up immediately instead of ten groups later.
    name: 'shared',
    dirs: [
      { from: 'src/utils/fs', to: 'src/shared/fs' },
      { from: 'src/utils/proc', to: 'src/shared/proc' },
      { from: 'src/utils/text', to: 'src/shared/text' },
      { from: 'src/utils/data', to: 'src/shared/data' },
      { from: 'src/schemas', to: 'src/shared/schemas' },
    ],
    files: [
      {
        from: 'src/utils',
        to: 'src/shared',
        files: [
          'abortController.ts',
          'combinedAbortSignal.ts',
          'signal.ts',
          'sleep.ts',
          'timeouts.ts',
          'sequential.ts',
          'generators.ts',
          'withResolvers.ts',
          'stream.ts',
          'bufferedWriter.ts',
          'semver.ts',
          'errors.ts',
          'log.ts',
          'debug.ts',
          'debugFilter.ts',
          'diagLogs.ts',
          'sinks.ts',
          'errorLogSink.ts',
          'env.ts',
          'envDynamic.ts',
          'envUtils.ts',
          'envValidation.ts',
          'http.ts',
          'browser.ts',
          'editor.ts',
          'cleanup.ts',
          'cleanupRegistry.ts',
          'frontmatterParser.ts',
          'urlRedaction.ts',
          'user.ts',
          'completionCache.ts',
          'queueProcessor.ts',
          'warningHandler.ts',
          'controlMessageCompat.ts',
          'peerAddress.ts',
        ],
      },
    ],
  },

  {
    // Everything about drawing on a tty: the forked renderer, the generic
    // widgets, the React plumbing that only exists to host them.
    name: 'terminal',
    dirs: [
      { from: 'src/ink', to: 'src/terminal/ink' },
      { from: 'src/state', to: 'src/terminal/state' },
      { from: 'src/context', to: 'src/terminal/contexts' },
      { from: 'src/keybindings', to: 'src/terminal/keybindings' },
      { from: 'src/vim', to: 'src/terminal/vim' },
      { from: 'src/buddy', to: 'src/terminal/buddy' },
      { from: 'src/moreright', to: 'src/terminal/moreright' },
      { from: 'src/voice', to: 'src/terminal/voice' },
      { from: 'src/components/design-system', to: 'src/terminal/design-system' },
      { from: 'src/components/CustomSelect', to: 'src/terminal/custom-select' },
      { from: 'src/components/Spinner', to: 'src/terminal/spinner' },
      { from: 'src/components/wizard', to: 'src/terminal/wizard' },
      { from: 'src/components/ui', to: 'src/terminal/ui' },
      { from: 'src/components/explorer', to: 'src/terminal/explorer' },
      { from: 'src/components/PromptInput', to: 'src/terminal/prompt-input' },
      { from: 'src/components/LogoV2', to: 'src/terminal/logo' },
      { from: 'src/components/HighlightedCode', to: 'src/terminal/highlighted-code' },
      { from: 'src/services/suggestions', to: 'src/terminal/suggestions' },
      { from: 'src/services/PromptSuggestion', to: 'src/terminal/prompt-suggestion' },
      { from: 'src/services/tips', to: 'src/terminal/tips' },
    ],
    files: [
      // Split-brain: the loose file joins the directory of the same name.
      { from: 'src/components', to: 'src/terminal/spinner', files: ['Spinner.tsx'] },
      {
        from: 'src/components',
        to: 'src/terminal/highlighted-code',
        files: ['HighlightedCode.tsx'],
      },
      {
        from: 'src/components',
        to: 'src/terminal/text-input',
        files: ['TextInput.tsx', 'BaseTextInput.tsx', 'VimTextInput.tsx'],
      },
      {
        from: 'src/components',
        to: 'src/terminal/markdown',
        files: ['Markdown.tsx', 'MarkdownTable.tsx', 'markdownTokenCache.ts'],
      },
      {
        from: 'src/components',
        to: 'src/terminal/image',
        files: ['InlineImage.tsx', 'ClickableImageRef.tsx'],
      },
      {
        from: 'src/components',
        to: 'src/terminal/render',
        files: ['staticRender.tsx', 'OffscreenFreeze.tsx'],
      },
      {
        from: 'src/components',
        to: 'src/terminal',
        files: [
          'highlightMatch.tsx',
          'SearchBox.tsx',
          'TagTabs.tsx',
          'FilePathLink.tsx',
          'FullscreenLayout.tsx',
          'CtrlOToExpand.tsx',
          'PressEnterToContinue.tsx',
          'ConfigurableShortcutHint.tsx',
          'ScrollKeybindingHandler.tsx',
          'VirtualMessageList.tsx',
          'FastIcon.tsx',
          'GlobalSearchDialog.tsx',
          'QuickOpenDialog.tsx',
        ],
      },
      {
        from: 'src/hooks',
        to: 'src/terminal/hooks',
        files: [
          'useTextInput.ts',
          'useVimInput.ts',
          'useInputBuffer.ts',
          'useArrowKeyHistory.tsx',
          'useTypeahead.tsx',
          'useSearchInput.ts',
          'useVirtualScroll.ts',
          'useTerminalSize.ts',
          'useBlink.ts',
          'useElapsedTime.ts',
          'useTimeout.ts',
          'useMinDisplayTime.ts',
          'useRampedNumber.ts',
          'useDoublePress.ts',
          'useAfterFirstRender.ts',
          'useEffectEventCompat.ts',
          'useCopyOnSelect.ts',
          'usePasteHandler.ts',
          'useClipboardImageHint.ts',
          'useGlobalKeybindings.tsx',
          'useCommandKeybindings.tsx',
          'useExitOnCtrlCD.ts',
          'useExitOnCtrlCDWithKeybindings.ts',
        ],
      },
      {
        // Not hooks despite living in src/hooks/ — the suggestion lane.
        from: 'src/hooks',
        to: 'src/terminal/prompt-suggestion',
        files: [
          'promptSuggestionGhost.ts',
          'usePromptSuggestion.ts',
          'unifiedSuggestions.ts',
          'fileSuggestions.ts',
          'renderPlaceholder.ts',
        ],
      },
      {
        from: 'src/hooks',
        to: 'src/terminal/voice',
        files: [
          'useVoice.ts',
          'useVoiceEnabled.ts',
          'useVoiceIntegration.tsx',
          'useInboxPoller.ts',
        ],
      },
      {
        from: 'src/services',
        to: 'src/terminal/voice',
        files: ['voice.ts', 'voiceKeyterms.ts', 'voiceStreamSTT.ts'],
      },
      {
        from: 'src/utils',
        to: 'src/terminal/theme',
        files: ['theme.ts', 'systemTheme.ts', 'systemThemeWatcher.d.ts'],
      },
      {
        from: 'src/utils',
        to: 'src/terminal/image',
        files: [
          'imagePaste.ts',
          'imageResizer.ts',
          'imageStore.ts',
          'imageValidation.ts',
          'kittyImageProtocol.ts',
          'ansiToPng.ts',
          'ansiToSvg.ts',
          'asciicast.ts',
        ],
      },
      {
        from: 'src/utils',
        to: 'src/terminal/input',
        files: [
          'keyboardShortcuts.ts',
          'modifiers.ts',
          'promptEditor.ts',
          'earlyInput.ts',
          'pasteStore.ts',
          'dragDropPaths.ts',
          'Cursor.ts',
        ],
      },
      {
        // `src/terminal/render/ink.ts` (colour → TextProps) lands beside the render helpers;
        // the render ENTRY is `src/terminal/ink.ts`, which goes to `src/terminal/ink.ts`.
        from: 'src/utils',
        to: 'src/terminal/render',
        files: [
          'renderCadence.ts',
          'renderOptions.ts',
          'fpsTracker.ts',
          'heatmap.ts',
          'horizontalScroll.ts',
          'fullscreen.ts',
          'streamJsonStdoutGuard.ts',
          'ink.ts',
        ],
      },
      {
        from: 'src/utils',
        to: 'src/terminal',
        files: [
          'terminal.ts',
          'terminalFont.ts',
          'terminalPanel.ts',
          'fileIcons.ts',
          'logoV2Utils.ts',
          'toolJSXStore.ts',
          'setToolJSXReducer.ts',
          'claudinUiSurfaces.test.ts',
        ],
      },
      {
        from: 'src',
        to: 'src/terminal',
        files: ['ink.ts', 'interactiveHelpers.tsx', 'dialogLaunchers.tsx'],
      },
    ],
  },

  {
    // The host: process entry, config, OS integration, transports. Not the agent
    // and not the UI — the machinery both stand on.
    name: 'platform',
    dirs: [
      { from: 'src/entrypoints', to: 'src/platform/entrypoints' },
      { from: 'src/main', to: 'src/platform/main' },
      { from: 'src/cli', to: 'src/platform/headless' },
      { from: 'src/bootstrap', to: 'src/platform/bootstrap' },
      { from: 'src/migrations', to: 'src/platform/migrations' },
      { from: 'src/bridge', to: 'src/platform/bridge' },
      { from: 'src/remote', to: 'src/platform/remote' },
      { from: 'src/server', to: 'src/platform/server' },
      { from: 'src/ssh', to: 'src/platform/ssh' },
      { from: 'src/daemon', to: 'src/platform/daemon' },
      { from: 'src/upstreamproxy', to: 'src/platform/upstreamproxy' },
      { from: 'src/self-hosted-runner', to: 'src/platform/self-hosted-runner' },
      { from: 'src/environment-runner', to: 'src/platform/environment-runner' },
      { from: 'src/jobs', to: 'src/platform/jobs' },
      { from: 'src/proactive', to: 'src/platform/proactive' },
      { from: 'src/services/lifecycleHooks', to: 'src/platform/lifecycleHooks' },
      { from: 'src/services/bash', to: 'src/platform/bash' },
      { from: 'src/services/shell', to: 'src/platform/shell' },
      { from: 'src/services/settings', to: 'src/platform/settings' },
      { from: 'src/services/install', to: 'src/platform/install' },
      { from: 'src/services/config', to: 'src/platform/config' },
      { from: 'src/services/lsp', to: 'src/platform/lsp' },
      { from: 'src/services/ide', to: 'src/platform/ide' },
      { from: 'src/services/telemetry', to: 'src/platform/telemetry' },
      { from: 'src/services/secureStorage', to: 'src/platform/secureStorage' },
      { from: 'src/services/analytics', to: 'src/platform/analytics' },
      { from: 'src/services/deepLink', to: 'src/platform/deepLink' },
      { from: 'src/services/teleport', to: 'src/platform/teleport' },
      { from: 'src/services/github', to: 'src/platform/github' },
      { from: 'src/services/filePersistence', to: 'src/platform/filePersistence' },
      { from: 'src/services/computerUse', to: 'src/platform/computerUse' },
      { from: 'src/services/sandbox', to: 'src/platform/sandbox' },
      { from: 'src/services/policyLimits', to: 'src/platform/policyLimits' },
      { from: 'src/services/remoteManagedSettings', to: 'src/platform/remoteManagedSettings' },
      { from: 'src/services/settingsSync', to: 'src/platform/settingsSync' },
      { from: 'src/services/usageContribution', to: 'src/platform/usageContribution' },
      { from: 'src/services/wiki', to: 'src/platform/wiki' },
      { from: 'src/services/MagicDocs', to: 'src/platform/MagicDocs' },
      { from: 'src/components/Settings', to: 'src/platform/settings/ui' },
      {
        from: 'src/components/ManagedSettingsSecurityDialog',
        to: 'src/platform/settings/security-dialog',
      },
      { from: 'src/components/FeedbackSurvey', to: 'src/platform/feedback' },
      { from: 'src/components/HelpV2', to: 'src/platform/help' },
      { from: 'src/components/teams', to: 'src/platform/teams' },
      // `ui/`, not `privacy/` directly: the providers group lands
      // `src/services/api/grove.ts` (the qualification/settings logic) in
      // `src/platform/privacy/`, and `Grove.tsx` beside it gives one directory
      // two files whose names differ only in case. Bun's resolver collapses
      // them, so `import … from './Grove.js'` silently resolves to `grove.ts`
      // and the build fails on the dialog's missing exports.
      { from: 'src/components/grove', to: 'src/platform/privacy/ui' },
      { from: 'src/components/Passes', to: 'src/platform/billing' },
      { from: 'src/components/DesktopUpsell', to: 'src/platform/billing/desktop-upsell' },
      { from: 'src/components/ClaudeCodeHint', to: 'src/platform/hints' },
      { from: 'src/components/hooks', to: 'src/platform/lifecycleHooks/ui' },
      { from: 'src/hooks/notifs', to: 'src/platform/notifications' },
    ],
    files: [
      {
        from: 'src/services',
        to: 'src/platform/notifications',
        files: ['notifier.ts', 'notifierHelpers.ts'],
      },
      {
        from: 'src/services',
        to: 'src/platform',
        files: ['diagnosticTracking.ts', 'preventSleep.ts'],
      },
      { from: 'src/screens', to: 'src/platform/doctor', files: ['Doctor.tsx'] },
      {
        from: 'src/components',
        to: 'src/platform',
        files: [
          'Onboarding.tsx',
          'StartupBanner.tsx',
          'StartupScreen.ts',
          'preflightChecks.tsx',
          'ThemePicker.tsx',
          'LanguagePicker.tsx',
          'OutputStylePicker.tsx',
          'MigrationBanner.tsx',
          'MigrationDialog.tsx',
          'InvalidConfigDialog.tsx',
          'InvalidSettingsDialog.tsx',
          'ClaudeMdExternalIncludesDialog.tsx',
          'KeybindingWarnings.tsx',
          'ValidationErrorsList.tsx',
          'ErrorBoundary.tsx',
          'SentryErrorBoundary.ts',
          'DiagnosticsDisplay.tsx',
          'LogSelector.tsx',
          'Feedback.tsx',
          'ExitFlow.tsx',
          'DevChannelsDialog.tsx',
          'ChannelDowngradeDialog.tsx',
          'IdleReturnDialog.tsx',
          'ExportDialog.tsx',
          'exportRenderer.tsx',
        ],
      },
      {
        from: 'src/components',
        to: 'src/platform/status',
        files: [
          'status.tsx',
          'StatusLine.tsx',
          'StatusNotices.tsx',
          'statusNoticeDefinitions.tsx',
          'statusNoticeHelpers.ts',
          'PrBadge.tsx',
        ],
      },
      {
        from: 'src/components',
        to: 'src/platform/teleport',
        files: [
          'teleport.tsx',
          'TeleportError.tsx',
          'TeleportProgress.tsx',
          'TeleportRepoMismatchDialog.tsx',
          'TeleportResumeWrapper.tsx',
          'TeleportStash.tsx',
        ],
      },
      {
        from: 'src/components',
        to: 'src/platform/ide',
        files: [
          'IdeAutoConnectDialog.tsx',
          'IdeOnboardingDialog.tsx',
          'IdeStatusIndicator.tsx',
          'ShowInIDEPrompt.tsx',
        ],
      },
      { from: 'src/components', to: 'src/platform/bridge', files: ['BridgeDialog.tsx'] },
      {
        from: 'src/components',
        to: 'src/platform/remote',
        files: ['RemoteCallout.tsx', 'RemoteEnvironmentDialog.tsx', 'DesktopHandoff.tsx'],
      },
      {
        from: 'src/hooks',
        to: 'src/platform',
        files: [
          'useSettings.ts',
          'useSettingsChange.ts',
          'useDynamicConfig.ts',
          'useSkillsChange.ts',
          'useManagePlugins.ts',
          'useOfficialMarketplaceNotification.tsx',
          'usePluginRecommendationBase.tsx',
          'useClaudeCodeHintRecommendation.tsx',
          'useIssueFlagBanner.ts',
        ],
      },
      {
        from: 'src/hooks',
        to: 'src/platform/ide',
        files: [
          'useIDEIntegration.tsx',
          'useIdeAtMentioned.ts',
          'useIdeConnectionStatus.ts',
          'useIdeLogging.ts',
          'useIdeSelection.ts',
        ],
      },
      {
        from: 'src/hooks',
        to: 'src/platform/notifications',
        files: ['useNotifyAfterTimeout.ts'],
      },
      {
        from: 'src/hooks',
        to: 'src/platform/bridge',
        files: ['useReplBridge.tsx', 'useMailboxBridge.ts'],
      },
      {
        from: 'src/utils',
        to: 'src/platform',
        files: [
          'cliArgs.ts',
          'startupProfiler.ts',
          'headlessProfiler.ts',
          'profilerBase.ts',
          'heapDumpService.ts',
          'slowOperations.ts',
          'idleTimeout.ts',
          'backgroundHousekeeping.ts',
          'stats.ts',
          'statsCache.ts',
          'telemetryAttributes.ts',
          'fileOperationAnalytics.ts',
          'claudeCodeHints.ts',
          'claudinPaths.test.ts',
          'claudinInstallSurfaces.test.ts',
        ],
      },
      {
        from: 'src/utils',
        to: 'src/platform/doctor',
        files: ['advisor.ts', 'doctorContextWarnings.ts', 'doctorDiagnostic.ts'],
      },
      {
        // Ambient declarations for subsystems this fork never received. They
        // move to whoever imports them, so the stub stays next to its caller.
        from: 'src/utils',
        to: 'src/platform',
        files: ['udsClient.d.ts', 'udsMessaging.d.ts'],
      },
      {
        from: 'src',
        to: 'src/platform',
        files: [
          'main.tsx',
          'setup.ts',
          'projectOnboardingState.ts',
          'projectOnboardingSteps.ts',
        ],
      },
    ],
  },

  {
    // The loop itself: drive the model, dispatch tools, account for context.
    name: 'agent-core',
    dirs: [
      { from: 'src/services/tools', to: 'src/agent/tools' },
      { from: 'src/services/messages', to: 'src/agent/messages' },
      { from: 'src/services/attachments', to: 'src/agent/attachments' },
      { from: 'src/services/compact', to: 'src/agent/compact' },
      { from: 'src/services/context', to: 'src/agent/context' },
      { from: 'src/services/autoFix', to: 'src/agent/autoFix' },
      { from: 'src/services/cache', to: 'src/agent/cache' },
      { from: 'src/services/input', to: 'src/agent/input' },
      { from: 'src/services/contextCollapse', to: 'src/agent/contextCollapse' },
      { from: 'src/services/background', to: 'src/agent/background' },
      { from: 'src/services/goal', to: 'src/agent/goal' },
      { from: 'src/services/ultraplan', to: 'src/agent/ultraplan' },
      { from: 'src/services/AgentSummary', to: 'src/agent/summary' },
      { from: 'src/services/toolUseSummary', to: 'src/agent/toolUseSummary' },
      { from: 'src/query', to: 'src/agent/query' },
      { from: 'src/outputStyles', to: 'src/agent/outputStyles' },
    ],
    files: [
      {
        from: 'src/services',
        to: 'src/agent',
        files: ['planDossier.ts', 'awaySummary.ts'],
      },
      {
        from: 'src/services',
        to: 'src/shared',
        files: ['tokenEstimation.ts', 'tokenModelCompression.test.ts'],
      },
      {
        from: 'src',
        to: 'src/agent',
        files: [
          'QueryEngine.ts',
          'query.ts',
          'Task.ts',
          'tasks.ts',
          'history.ts',
          'context.ts',
          'cost-tracker.ts',
          'costHook.ts',
        ],
      },
      {
        from: 'src/utils',
        to: 'src/agent',
        files: [
          'QueryGuard.ts',
          'queryContext.ts',
          'queryHelpers.ts',
          'queryProfiler.ts',
          'systemPrompt.ts',
          'systemPromptType.ts',
          'sideQuery.ts',
          'sideQuestion.ts',
          'messageQueueManager.ts',
          'sdkEventQueue.ts',
          'streamingOptimizer.ts',
          'continuationNudge.ts',
          'loopSentinels.ts',
          'todoReminderDelta.ts',
          'handlePromptSubmit.ts',
          'promptCategory.ts',
          'userPromptKeywords.ts',
          'deferredToolsDelta.test.ts',
          'staticDedup.integration.test.ts',
          'cacheBoundsInvariants.test.ts',
          'toolResultCodeOutline.test.ts',
          'toolResultJsonCompression.cacheSafety.test.ts',
          'serializationStability.test.ts',
          'thinkingTokens.test.ts',
        ],
      },
      {
        from: 'src/utils',
        to: 'src/agent/plans',
        files: ['plans.ts', 'planModeV2.ts'],
      },
      {
        from: 'src/utils',
        to: 'src/agent',
        files: ['attributionHooks.d.ts', 'taskSummary.d.ts'],
      },
    ],
  },

  {
    // The loop's shell and its screen: REPL, coordinator, task runtimes, UI.
    name: 'agent-shell',
    dirs: [
      { from: 'src/screens/repl', to: 'src/agent/repl' },
      { from: 'src/screens/__testutils__', to: 'src/agent/repl/__testutils__' },
      { from: 'src/coordinator', to: 'src/agent/coordinator' },
      { from: 'src/tasks', to: 'src/agent/tasks' },
      { from: 'src/components/messages', to: 'src/agent/ui/messages' },
      { from: 'src/components/agents', to: 'src/agent/ui/agents' },
      { from: 'src/components/tasks', to: 'src/agent/ui/tasks' },
      { from: 'src/components/workflows', to: 'src/agent/ui/workflows' },
    ],
    files: [
      {
        from: 'src/screens',
        to: 'src/agent/repl',
        files: ['REPL.tsx', 'replInputSuppression.ts', 'replStartupGates.ts'],
      },
      { from: 'src', to: 'src/agent/repl', files: ['replLauncher.tsx'] },
      {
        from: 'src/components',
        to: 'src/agent/ui',
        files: [
          'App.tsx',
          'Message.tsx',
          'Messages.tsx',
          'MessageRow.tsx',
          'MessageModel.tsx',
          'MessageResponse.tsx',
          'MessageSelector.tsx',
          'MessageTimestamp.tsx',
          'messageActions.tsx',
          'InterruptedByUser.tsx',
          'ToolUseLoader.tsx',
          'ThinkingToggle.tsx',
          'CompactSummary.tsx',
          'ContextVisualization.tsx',
          'ContextSuggestions.tsx',
          'TokenWarning.tsx',
          'CoordinatorAgentStatus.tsx',
          'TeammateViewHeader.tsx',
          'TaskListV2.tsx',
          'ResumeTask.tsx',
          'GoalStatusIndicator.tsx',
          'AgentProgressLine.tsx',
          'Stats.tsx',
          'autoRunIssue.tsx',
          'WorkflowMultiselectDialog.tsx',
          'FallbackToolUseErrorMessage.tsx',
          'FallbackToolUseRejectedMessage.tsx',
        ],
      },
      {
        from: 'src/hooks',
        to: 'src/agent/hooks',
        files: [
          'useAssistantHistory.ts',
          'useAwaySummary.ts',
          'useCancelRequest.ts',
          'useCommandQueue.ts',
          'useQueueProcessor.ts',
          'useStreamingTextStore.ts',
          'useMergedTools.ts',
          'useMergedCommands.ts',
          'useMainLoopModel.ts',
          'useDeferredHookMessages.ts',
          'useLogMessages.ts',
          'useTasksV2.ts',
          'useTaskListWatcher.ts',
          'useScheduledTasks.ts',
          'useBackgroundTaskNavigation.ts',
        ],
      },
      {
        from: 'src/hooks',
        to: 'src/agent/coordinator/hooks',
        files: [
          'useSwarmInitialization.ts',
          'useSwarmPermissionPoller.ts',
          'useTeammateViewAutoExit.ts',
        ],
      },
    ],
  },

  {
    // Every model vendor: presets, credentials, wire shims, transport, usage.
    // `services/api` is split seven ways — it was the largest leaf concern in the
    // tree at 164 files and moving it whole would just rename the pile.
    name: 'providers',
    dirs: [
      { from: 'src/services/api/claude', to: 'src/providers/shims/claude' },
      { from: 'src/services/api/openaiShim', to: 'src/providers/shims/openaiShim' },
      { from: 'src/services/api/minimaxUsage', to: 'src/providers/usage/minimaxUsage' },
      { from: 'src/services/api/__fixtures__', to: 'src/providers/usage/__fixtures__' },
      { from: 'src/services/oauth', to: 'src/providers/oauth' },
      { from: 'src/services/auth', to: 'src/providers/auth' },
    ],
    files: [
      {
        from: 'src/services/api',
        to: 'src/providers/presets',
        files: [
          'activeProvider.ts',
          'providerConfig.ts',
          'providerDiscovery.ts',
          'providerModels.ts',
          'providerProfile.ts',
          'providerProfiles.ts',
          'providerRecommendation.ts',
          'providerSecrets.ts',
          'providerValidation.ts',
        ],
      },
      {
        from: 'src/services/api',
        to: 'src/providers/oauth',
        files: [
          'aws.ts',
          'awsAuthStatusManager.ts',
          'codexCredentials.ts',
          'codexOAuth.ts',
          'codexOAuthShared.ts',
          'copilotHeaders.ts',
          'geminiAuth.ts',
          'geminiCredentials.ts',
          'githubModelsCredentials.ts',
          'kimiCredentials.ts',
          'kimiDeviceHeaders.ts',
          'kimiOAuth.ts',
          'kimiOAuthShared.ts',
          'kimiUserAgent.ts',
          'xaiCredentials.ts',
          'xaiOAuth.ts',
          'xaiOAuthShared.ts',
          'xaiUserAgent.ts',
        ],
      },
      {
        from: 'src/services/api',
        to: 'src/providers/shims',
        files: [
          'claude.ts',
          'codexShim.ts',
          'openaiShim.ts',
          'openaiErrorClassification.ts',
          'openaiSchemaSanitizer.ts',
          'thinkTagSanitizer.ts',
          'toolArgumentNormalization.ts',
          'strictSchemaComposition.test.ts',
          'staticDedup.shim.integration.test.ts',
        ],
      },
      {
        from: 'src/services/api',
        to: 'src/providers/transport',
        files: [
          'adminRequests.ts',
          'api.ts',
          'apiPreconnect.ts',
          'betas.ts',
          'bootstrap.ts',
          'caCerts.ts',
          'caCertsConfig.ts',
          'client.ts',
          'clientCache.ts',
          'dumpPrompts.ts',
          'errorUtils.ts',
          'errors.ts',
          'fetchWithProxyRetry.ts',
          'filesApi.ts',
          'h2Fallback.ts',
          'logging.ts',
          'mtls.ts',
          'pickFetch.ts',
          'proxy.ts',
          'requestLogging.ts',
          'sessionIngress.ts',
          'unaryLogging.ts',
          'userAgent.ts',
          'withRetry.ts',
        ],
      },
      {
        from: 'src/services/api',
        to: 'src/providers/usage',
        files: [
          'billing.ts',
          'codexUsage.ts',
          'emptyUsage.ts',
          'extraUsage.ts',
          'firstTokenDate.ts',
          'metricsOptOut.ts',
          'minimaxUsage.ts',
          'modelCost.ts',
          'overageCreditGrant.ts',
          'referral.ts',
          'ultrareviewQuota.ts',
          'usage.ts',
        ],
      },
      {
        from: 'src/services/api',
        to: 'src/providers/cache',
        files: [
          'cacheMetrics.ts',
          'cacheStatsTracker.ts',
          'promptCacheBreakDetection.ts',
          'cache1hTtl.test.ts',
          'cacheMetricsIntegration.test.ts',
          'stableStub.benchmark.test.ts',
        ],
      },
      {
        from: 'src/services/api',
        to: 'src/providers/routing',
        files: ['smartModelRouting.ts'],
      },
      { from: 'src/services/api', to: 'src/platform/privacy', files: ['grove.ts'] },
      {
        from: 'src/services',
        to: 'src/providers',
        files: [
          'claudeAiLimits.ts',
          'claudeAiLimitsHook.ts',
          'mockRateLimits.ts',
          'rateLimitMessages.ts',
          'rateLimitMocking.ts',
          'vcr.ts',
        ],
      },
      {
        from: 'src/components',
        to: 'src/providers/ui',
        files: [
          'ProviderManager.tsx',
          'ProviderModelIndicator.tsx',
          'ModelPicker.tsx',
          'EffortPicker.tsx',
          'EffortPicker.layout.ts',
          'EffortCallout.tsx',
          'EffortIndicator.ts',
          'ConsoleOAuthFlow.tsx',
          'ApproveApiKey.tsx',
          'AwsAuthStatusBox.tsx',
          'SessionTokensIndicator.tsx',
          'useCodexOAuthFlow.ts',
          'useKimiOAuthFlow.ts',
          'useXaiOAuthFlow.ts',
        ],
      },
      {
        from: 'src/hooks',
        to: 'src/providers/hooks',
        files: ['useApiKeyVerification.ts', 'useDirectConnect.ts'],
      },
      { from: 'src/utils', to: 'src/providers', files: ['fastMode.ts'] },
    ],
  },

  {
    // Version control as one concern: the git wrapper, the diff reviewer's UI and
    // data hooks. `/diff` used to reach across eleven top-level directories.
    name: 'vcs',
    dirs: [
      { from: 'src/services/git', to: 'src/vcs/git' },
      { from: 'src/components/diff', to: 'src/vcs/diff/ui' },
      { from: 'src/components/StructuredDiff', to: 'src/vcs/diff/structured' },
    ],
    files: [
      {
        from: 'src/components',
        to: 'src/vcs/diff/structured',
        files: ['StructuredDiff.tsx', 'StructuredDiffList.tsx'],
      },
      {
        from: 'src/hooks',
        to: 'src/vcs/diff/hooks',
        files: [
          'useDiffData.ts',
          'useDiffInIDE.ts',
          'useGitDiffStat.ts',
          'useSessionDiffStat.ts',
          'useTurnDiffs.ts',
          'useWorkspaceDiff.ts',
          'useCommitFiles.ts',
        ],
      },
      {
        from: 'src/hooks',
        to: 'src/vcs/hooks',
        files: [
          'useGitLog.ts',
          'useGitStashes.ts',
          'usePrStatus.ts',
          'useCwdBranchSegment.ts',
        ],
      },
      { from: 'src/utils', to: 'src/vcs', files: ['gitDiffStatSummary.test.ts'] },
      { from: 'src/utils', to: 'src/vcs/git', files: ['postCommitAttribution.d.ts'] },
    ],
  },

  {
    // Auto-memory, end to end. `src/memdir/` was already the only vertical slice
    // in the tree; this gives it the extraction, session and team halves.
    name: 'memory',
    dirs: [
      { from: 'src/memdir', to: 'src/memory/memdir' },
      { from: 'src/services/extractMemories', to: 'src/memory/extract' },
      { from: 'src/services/SessionMemory', to: 'src/memory/session' },
      { from: 'src/services/teamMemorySync', to: 'src/memory/teamSync' },
      { from: 'src/services/autoDream', to: 'src/memory/autoDream' },
      { from: 'src/services/instructions', to: 'src/memory/instructions' },
      { from: 'src/components/memory', to: 'src/memory/ui' },
    ],
  },

  {
    // Permissions lived in five places. This is all of them but the per-tool
    // rule files, which stay with their tool.
    name: 'permissions',
    dirs: [
      { from: 'src/services/permissions', to: 'src/permissions' },
      { from: 'src/components/permissions', to: 'src/permissions/ui' },
      { from: 'src/components/sandbox', to: 'src/permissions/ui/sandbox' },
      { from: 'src/components/TrustDialog', to: 'src/permissions/ui/trust' },
      { from: 'src/hooks/toolPermission', to: 'src/permissions/toolPermission' },
    ],
    files: [
      {
        from: 'src/components',
        to: 'src/permissions/ui',
        files: [
          'BypassPermissionsModeDialog.tsx',
          'AutoModeOptInDialog.tsx',
          'SandboxViolationExpandedView.tsx',
          'CostThresholdDialog.tsx',
          'WorktreeExitDialog.tsx',
        ],
      },
      { from: 'src/hooks', to: 'src/permissions', files: ['useCanUseTool.tsx'] },
      {
        from: 'src/utils',
        to: 'src/permissions',
        files: [
          'autoModeDenials.ts',
          'classifierApprovals.ts',
          'classifierApprovalsHook.ts',
        ],
      },
    ],
  },

  {
    name: 'sessions',
    dirs: [
      { from: 'src/services/session', to: 'src/sessions' },
      { from: 'src/services/sessionTranscript', to: 'src/sessions/transcript' },
      { from: 'src/assistant', to: 'src/sessions/assistant' },
    ],
    files: [
      { from: 'src/screens', to: 'src/sessions/ui', files: ['ResumeConversation.tsx'] },
      {
        from: 'src/components',
        to: 'src/sessions/ui',
        files: [
          'SessionPreview.tsx',
          'SessionBackgroundHint.tsx',
          'HistorySearchDialog.tsx',
        ],
      },
      {
        from: 'src/hooks',
        to: 'src/sessions/hooks',
        files: [
          'useHistorySearch.ts',
          'useSessionBackgrounding.ts',
          'useRemoteSession.ts',
          'useSSHSession.ts',
          'useFileHistorySnapshotInit.ts',
          'useTeleportResume.tsx',
        ],
      },
    ],
  },

  {
    name: 'mcp-skills-plugins',
    dirs: [
      { from: 'src/services/mcp', to: 'src/mcp' },
      { from: 'src/components/mcp', to: 'src/mcp/ui' },
      { from: 'src/services/skillSearch', to: 'src/skills/search' },
      { from: 'src/components/skills', to: 'src/skills/ui' },
      { from: 'src/services/plugins', to: 'src/plugins' },
    ],
    files: [
      { from: 'src/services', to: 'src/mcp', files: ['mcpServerApproval.tsx'] },
      {
        from: 'src/components',
        to: 'src/mcp/ui',
        files: [
          'MCPServerApprovalDialog.tsx',
          'MCPServerDesktopImportDialog.tsx',
          'MCPServerDialogCopy.tsx',
          'MCPServerMultiselectDialog.tsx',
        ],
      },
      { from: 'src/hooks', to: 'src/mcp/hooks', files: ['useMergedClients.ts'] },
    ],
  },

  {
    // `tools/` and `commands/` already scream; they only take back what belongs
    // to them. `outputFilter/` has exactly one consumer, BashTool.
    name: 'tools-and-commands',
    dirs: [
      { from: 'src/outputFilter', to: 'src/tools/shared/outputFilter' },
      { from: 'src/components/shell', to: 'src/tools/BashTool/ui' },
    ],
    files: [
      { from: 'src', to: 'src/tools', files: ['Tool.ts', 'tools.ts'] },
      { from: 'src', to: 'src/commands', files: ['commands.ts'] },
      {
        from: 'src/components',
        to: 'src/tools/BashTool/ui',
        files: ['BashModeProgress.tsx'],
      },
      {
        from: 'src/components',
        to: 'src/tools/FileEditTool/ui',
        files: [
          'FileEditToolDiff.tsx',
          'FileEditToolUpdatedMessage.tsx',
          'FileEditToolUseRejectedMessage.tsx',
        ],
      },
      {
        from: 'src/components',
        to: 'src/tools/NotebookEditTool/ui',
        files: ['NotebookEditToolUseRejectedMessage.tsx'],
      },
      {
        from: 'src/utils',
        to: 'src/tools/shared',
        files: [
          'collapseBackgroundBashNotifications.ts',
          'collapseHookSummaries.ts',
          'collapseTeammateShutdowns.ts',
        ],
      },
      {
        from: 'src/utils',
        to: 'src/commands',
        files: [
          'argumentSubstitution.ts',
          'slashCommandParsing.ts',
          'exampleCommands.ts',
          'commandLifecycle.ts',
          'immediateCommand.ts',
        ],
      },
    ],
  },

  {
    // Carve the prompt cluster out of `constants/` BEFORE the sweep below claims
    // the directory — first claim wins, and groups run in order.
    name: 'constants-split',
    dirs: [
      { from: 'src/constants/familyAddendums', to: 'src/agent/prompts/familyAddendums' },
    ],
    files: [
      {
        from: 'src/constants',
        to: 'src/agent/prompts',
        files: [
          'prompts.ts',
          'system.ts',
          'systemPromptSections.ts',
          'steeringToggles.ts',
          'toolPromptTier.ts',
          'promptIdentity.test.ts',
          'promptSectionStaleness.test.ts',
          'querySource.ts',
          'cyberRiskInstruction.ts',
          'spinnerVerbs.ts',
          'turnCompletionVerbs.ts',
          'messages.ts',
        ],
      },
      {
        from: 'src/constants',
        to: 'src/tools/constants',
        files: ['tools.ts', 'toolLimits.ts'],
      },
    ],
  },

  {
    // The remainder of `constants/` plus `types/`, which is cross-cutting by
    // nature and stays one directory.
    name: 'constants-rest',
    dirs: [
      { from: 'src/constants', to: 'src/shared/constants' },
      { from: 'src/types', to: 'src/shared/types' },
    ],
  },

  {
    // LAST and droppable — see the header. Moving these makes them load earlier,
    // which is the direction that cost 13 unrelated failures last time.
    name: 'model-and-effort',
    dirs: [{ from: 'src/utils/model', to: 'src/providers/model' }],
    files: [{ from: 'src/utils', to: 'src/providers/effort', files: ['effort.ts'] }],
  },
]
