/**
 * Where every subsystem currently living under `src/utils/` is going.
 *
 * Policy: conservative. A file moves only when it has an obvious home — an
 * existing directory that already owns the concept, or a new `src/services/<x>/`
 * whose name nobody would argue with. Anything ambiguous stays exactly where it
 * is, which is why `src/utils/` is expected to keep ~150 files rather than
 * shrink to the ~80 a maximalist split would leave.
 *
 * Two destinations are deliberately NOT the obvious-looking one:
 *  - `utils/hooks/` (Claude Code lifecycle hooks) → `services/lifecycleHooks/`,
 *    never `src/hooks/`, which holds React `use*` hooks.
 *  - the context/token cluster → `services/context/`, never `src/context/`,
 *    which holds React Context providers.
 *
 * One subsystem that clearly belongs in `services/` is NOT here: `utils/model/`.
 * Bun pre-applies module-scope `mock.module()` registrations for the whole test
 * run, so what every file sees is whichever registered LAST during the load
 * phase — and `src/utils/` is walked last. `utils/model/sonnet5.test.ts` and
 * `opus5.test.ts` pin `providers.js` to 'firstParty' there, which is what keeps
 * `effort.kimi.test.ts`'s 'openai' pin from reaching everyone else. Moving the
 * directory makes it load earlier and costs 13 unrelated failures across
 * withRetry, apiPreconnect, officialRegistry and the model tests. The suite's
 * dependence on load order is a real defect, but it is not this PR's to fix:
 * move `utils/model/` in a follow-up that gives `providers.js` a single
 * cooperative test owner.
 *
 * `apply.ts` reads this, moves with `git mv`, drags each test's `__snapshots__`
 * entry along, and rewrites the `src/…` specifier in every importer.
 */

/** A whole directory, moved with everything under it. */
export type DirMove = { readonly from: string; readonly to: string }

/** One file, moved into a destination directory (name unchanged). */
export type FileMove = { readonly files: readonly string[]; readonly to: string }

export type Group = {
  readonly name: string
  readonly dirs?: readonly DirMove[]
  readonly files?: readonly FileMove[]
}

export const GROUPS: readonly Group[] = [
  {
    // Subsystems that already have a home of the same name elsewhere.
    name: 'merge-into-existing',
    dirs: [
      { from: 'src/utils/plugins', to: 'src/services/plugins' },
      { from: 'src/utils/dxt', to: 'src/services/plugins/dxt' },
      { from: 'src/utils/mcp', to: 'src/services/mcp' },
      { from: 'src/utils/github', to: 'src/services/github' },
      { from: 'src/utils/skills', to: 'src/skills' },
      { from: 'src/utils/task', to: 'src/tasks' },
      { from: 'src/utils/memory', to: 'src/memdir' },
      { from: 'src/utils/todo', to: 'src/tools/TodoWriteTool' },
      { from: 'src/utils/background', to: 'src/services/background' },
    ],
  },
  {
    // Subsystems that need a home of their own under services/.
    name: 'subsystems',
    dirs: [
      { from: 'src/utils/permissions', to: 'src/services/permissions' },
      { from: 'src/utils/settings', to: 'src/services/settings' },
      { from: 'src/utils/messages', to: 'src/services/messages' },
      { from: 'src/utils/attachments', to: 'src/services/attachments' },
      { from: 'src/utils/bash', to: 'src/services/bash' },
      { from: 'src/utils/shell', to: 'src/services/shell' },
      { from: 'src/utils/powershell', to: 'src/services/shell/powershell' },
      { from: 'src/utils/telemetry', to: 'src/services/telemetry' },
      { from: 'src/utils/sandbox', to: 'src/services/sandbox' },
      { from: 'src/utils/computerUse', to: 'src/services/computerUse' },
      { from: 'src/utils/secureStorage', to: 'src/services/secureStorage' },
      { from: 'src/utils/suggestions', to: 'src/services/suggestions' },
      { from: 'src/utils/teleport', to: 'src/services/teleport' },
      { from: 'src/utils/deepLink', to: 'src/services/deepLink' },
      { from: 'src/utils/filePersistence', to: 'src/services/filePersistence' },
      { from: 'src/utils/goal', to: 'src/services/goal' },
      { from: 'src/utils/ultraplan', to: 'src/services/ultraplan' },
      { from: 'src/utils/nativeInstaller', to: 'src/services/install' },
      { from: 'src/utils/processUserInput', to: 'src/services/input' },
      { from: 'src/utils/sessionStorage', to: 'src/services/session' },
      { from: 'src/utils/git', to: 'src/services/git' },
      // NOT src/hooks/ — that one holds React use* hooks.
      { from: 'src/utils/hooks', to: 'src/services/lifecycleHooks' },
      { from: 'src/utils/swarm', to: 'src/coordinator/swarm' },
    ],
  },
  {
    name: 'provider-and-credentials',
    files: [
      {
        to: 'src/services/api',
        files: [
          'api.ts',
          'apiPreconnect.ts',
          'betas.ts',
          'billing.ts',
          'extraUsage.ts',
          'providerDiscovery.ts',
          'providerModels.ts',
          'providerProfile.ts',
          'providerProfiles.ts',
          'providerRecommendation.ts',
          'providerSecrets.ts',
          'providerValidation.ts',
          'userAgent.ts',
          'xaiUserAgent.ts',
          'xaiCredentials.ts',
          'kimiCredentials.ts',
          'kimiDeviceHeaders.ts',
          'kimiUserAgent.ts',
          'geminiAuth.ts',
          'geminiCredentials.ts',
          'githubModelsCredentials.ts',
          'codexCredentials.ts',
          'aws.ts',
          'awsAuthStatusManager.ts',
          'mtls.ts',
          'caCerts.ts',
          'caCertsConfig.ts',
          'proxy.ts',
          'requestLogging.ts',
          'unaryLogging.ts',
          'modelCost.ts',
        ],
      },
      {
        to: 'src/services/auth',
        files: ['auth.ts', 'authPortable.ts', 'authFileDescriptor.ts'],
      },
    ],
  },
  {
    // Flat files that duplicate a subdirectory of the same name — the clearest
    // symptom of the drift, and the least arguable moves in the manifest.
    name: 'flat-duplicates',
    files: [
      { to: 'src/services/lifecycleHooks', files: ['hooks.ts', 'hookChains.ts'] },
      { to: 'src/services/attachments', files: ['attachments.ts'] },
      { to: 'src/services/messages', files: ['messages.ts', 'messagePredicates.ts'] },
      {
        to: 'src/services/mcp',
        files: [
          'mcpValidation.ts',
          'mcpOutputStorage.ts',
          'mcpWebSocketTransport.ts',
          'mcpInstructionsDelta.ts',
        ],
      },
    ],
  },
  {
    name: 'config-and-instructions',
    files: [
      {
        to: 'src/services/config',
        files: [
          'config.ts',
          'configConstants.ts',
          'privacyLevel.ts',
          'managedEnv.ts',
          'managedEnvConstants.ts',
          'gitSettings.ts',
          'claudinMigration.ts',
          'claudinStartupMigrations.ts',
        ],
      },
      {
        to: 'src/services/instructions',
        files: [
          'claudemd.ts',
          'claudeMdDelta.ts',
          'projectInstructions.ts',
          'markdownConfigLoader.ts',
          'ruleFrontmatter.ts',
          'rulesLint.ts',
        ],
      },
    ],
  },
  {
    name: 'session',
    files: [
      {
        to: 'src/services/session',
        files: [
          'sessionStorage.ts',
          'sessionStoragePortable.ts',
          'sessionRestore.ts',
          'sessionStart.ts',
          'sessionState.ts',
          'sessionActivity.ts',
          'sessionEnvironment.ts',
          'sessionEnvVars.ts',
          'sessionTitle.ts',
          'sessionUrl.ts',
          'sessionIngressAuth.ts',
          'sessionFileAccessHooks.ts',
          'listSessionsImpl.ts',
          'concurrentSessions.ts',
          'crossProjectResume.ts',
          'agenticSessionSearch.ts',
          'transcriptSearch.ts',
          'conversationRecovery.ts',
        ],
      },
    ],
  },
  {
    name: 'context-and-tokens',
    files: [
      {
        // NOT src/context/ — that one holds React Context providers.
        to: 'src/services/context',
        files: [
          'analyzeContext.ts',
          'contextAnalysis.ts',
          'context.ts',
          'contextSuggestions.ts',
          'multiTurnContext.ts',
          'conversationArc.ts',
          'tokens.ts',
          'tokenAnalytics.ts',
          'tokenBudget.ts',
          'tokensSaved.ts',
          'imageTokenEstimator.ts',
          'thinking.ts',
          'thinkingTokenExtractor.ts',
        ],
      },
    ],
  },
  {
    name: 'tool-plumbing',
    files: [
      {
        to: 'src/services/tools',
        files: [
          'toolResultStorage.ts',
          'toolResultSummarizer.ts',
          'toolPool.ts',
          'toolSchemaCache.ts',
          'toolSearch.ts',
          'toolErrors.ts',
          'toolInputPlaceholders.ts',
          'embeddedTools.ts',
          'collapseReadSearch.ts',
          'groupToolUses.ts',
          'jsonArrayCompress.ts',
          'streamlinedTransform.ts',
        ],
      },
    ],
  },
  {
    name: 'git-and-worktree',
    files: [
      {
        to: 'src/services/git',
        files: [
          'git.ts',
          'gitDiff.ts',
          'gitLog.ts',
          'gitStatusDelta.ts',
          'diff.ts',
          'diffStat.ts',
          'ghPrStatus.ts',
          'format-branch.ts',
          'commitAttribution.ts',
          'attribution.ts',
          'detectRepository.ts',
          'githubRepoPathMapping.ts',
          'worktree.ts',
          'worktreeModeEnabled.ts',
          'getWorktreePaths.ts',
          'getWorktreePathsPortable.ts',
        ],
      },
    ],
  },
  {
    name: 'agents-and-tasks',
    files: [
      {
        to: 'src/coordinator',
        files: [
          'forkedAgent.ts',
          'standaloneAgent.ts',
          'agentContext.ts',
          'agentId.ts',
          'agentSwarmsEnabled.ts',
          'teammate.ts',
          'teammateContext.ts',
          'teammateMailbox.ts',
          'inProcessTeammateHelpers.ts',
          'teamDiscovery.ts',
          'mailbox.ts',
          'directMemberMessage.ts',
          'activityManager.ts',
        ],
      },
      {
        to: 'src/tasks',
        files: [
          'tasks.ts',
          'planTasks.ts',
          'cron.ts',
          'cronScheduler.ts',
          'cronTasks.ts',
          'cronTasksLock.ts',
          'cronJitterConfig.ts',
        ],
      },
      { to: 'src/memdir', files: ['memoryFileDetection.ts', 'teamMemoryOps.ts'] },
    ],
  },
  {
    name: 'install-and-ide',
    files: [
      {
        to: 'src/services/install',
        files: [
          'autoUpdater.ts',
          'startupUpdateCheck.ts',
          'latestVersionCache.ts',
          'localInstaller.ts',
          'coalescedUpdater.ts',
          'bundledMode.ts',
          'releaseNotes.ts',
        ],
      },
      {
        to: 'src/services/ide',
        files: [
          'ide.ts',
          'idePathConversion.ts',
          'jetbrains.ts',
          'claudeDesktop.ts',
          'desktopDeepLink.ts',
          'iTermBackup.ts',
          'appleTerminalBackup.ts',
          'screenshotClipboard.ts',
        ],
      },
    ],
  },
  {
    name: 'tui-components',
    files: [
      {
        to: 'src/components',
        files: [
          'status.tsx',
          'statusNoticeDefinitions.tsx',
          'statusNoticeHelpers.ts',
          'staticRender.tsx',
          'preflightChecks.tsx',
          'exportRenderer.tsx',
          'autoRunIssue.tsx',
          'highlightMatch.tsx',
          'teleport.tsx',
        ],
      },
    ],
  },
  {
    // What is left really is a utility. Four folders, no barrels.
    name: 'primitives',
    files: [
      {
        to: 'src/utils/data',
        files: [
          'array.ts',
          'set.ts',
          'clamp.ts',
          'memoize.ts',
          'uuid.ts',
          'hash.ts',
          'crypto.ts',
          'json.ts',
          'jsonRead.ts',
          'yaml.ts',
          'xml.ts',
          'stableStringify.ts',
          'objectGroupBy.ts',
          'CircularBuffer.ts',
          'taggedId.ts',
          'fingerprint.ts',
          'semanticNumber.ts',
          'semanticBoolean.ts',
          'lazySchema.ts',
          'zodToJsonSchema.ts',
          'schemaSanitizer.ts',
          'sanitization.ts',
        ],
      },
      {
        to: 'src/utils/fs',
        files: [
          'path.ts',
          'cwd.ts',
          'xdg.ts',
          'systemDirectories.ts',
          'tempfile.ts',
          'lockfile.ts',
          'cachePaths.ts',
          'file.ts',
          'fileRead.ts',
          'fileReadCache.ts',
          'readFileInRange.ts',
          'readEditContext.ts',
          'fileStateCache.ts',
          'fileHistory.ts',
          'fsOperations.ts',
          'generatedFiles.ts',
          'glob.ts',
          'ripgrep.ts',
          'notebook.ts',
          'pdf.ts',
          'pdfUtils.ts',
          'sourceTreeDetect.ts',
          'textEncoding.ts',
          'windowsPaths.ts',
          'codeIndexing.ts',
          'detectCodeLang.ts',
        ],
      },
      {
        to: 'src/utils/proc',
        files: [
          'Shell.ts',
          'ShellCommand.ts',
          'shellConfig.ts',
          'process.ts',
          'genericProcessUtils.ts',
          'execFileNoThrow.ts',
          'execFileNoThrowPortable.ts',
          'execSyncWrapper.ts',
          'subprocessEnv.ts',
          'findExecutable.ts',
          'which.ts',
          'platform.ts',
          'tmuxSocket.ts',
          'gracefulShutdown.ts',
          'phantomLaunchGuard.ts',
          'promptShellExecution.ts',
        ],
      },
      {
        to: 'src/utils/text',
        files: [
          'truncate.ts',
          'format.ts',
          'formatBriefTimestamp.ts',
          'stringUtils.ts',
          'words.ts',
          'markdown.ts',
          'treeify.ts',
          'sliceAnsi.ts',
          'cliHighlight.ts',
          'textHighlighting.ts',
          'hyperlink.ts',
          'displayTags.ts',
          'intl.ts',
        ],
      },
    ],
  },
]
