// Resume branch — `claudin --resume`, `--from-pr`, `--teleport`, `--remote`.
// Handles resume flow from file, session ID, interactive selector, plus
// remote/teleport (CCR) session creation. Extracted from src/main.tsx
// (ROADMAP 11g Fase 5b).

import chalk from 'chalk';
import { getRemoteSessionUrl } from 'src/constants/product.js';
import { getOriginalCwd, setIsRemoteMode, setOriginalCwd, setTeleportedSessionInfo, switchSession } from 'src/bootstrap/state.js';
import { filterCommandsForRemoteMode } from 'src/commands.js';
import { launchResumeChooser, launchTeleportRepoMismatchDialog, launchTeleportResumeWrapper } from 'src/terminal/dialogLaunchers.js';
import type { Root } from 'src/terminal/ink.js';
import { exitWithError, renderAndRun } from 'src/terminal/interactiveHelpers.js';
import { createRemoteSessionConfig } from 'src/remote/RemoteSessionManager.js';
import { launchRepl } from 'src/replLauncher.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import { logEvent } from 'src/services/analytics/index.js';
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js';
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js';
import { asSessionId } from 'src/types/ids.js';
import type { LogOption } from 'src/types/logs.js';
import type { Message as MessageType } from 'src/types/message.js';
import { count } from 'src/shared/data/array.js';
import { loadConversationForResume } from 'src/services/session/conversationRecovery.js';
import { errorMessage, TeleportOperationError, toError } from 'src/shared/errors.js';
import { getBranch } from 'src/services/git/git.js';
import { getWorktreePaths } from 'src/services/git/getWorktreePaths.js';
import { filterExistingPaths, getKnownPathsForRepo } from 'src/services/git/githubRepoPathMapping.js';
import { gracefulShutdown } from 'src/shared/proc/gracefulShutdown.js';
import { logForDebugging } from 'src/shared/debug.js';
import { logError } from 'src/shared/log.js';
import { createSystemMessage, createUserMessage } from 'src/services/messages/messages.js';
import { type ProcessedResume, processResumedConversation } from 'src/services/session/sessionRestore.js';
import { getSessionIdFromLog, searchSessionsByCustomTitle } from 'src/services/session/sessionStorage.js';
import { setCwd } from 'src/shared/proc/Shell.js';
import { fetchSession, prepareApiRequest } from 'src/services/teleport/api.js';
import { checkOutTeleportedSessionBranch, processMessagesForTeleportResume, teleportToRemoteWithErrorHandling, validateGitState, validateSessionRepository } from 'src/components/teleport.js';
import { validateUuid } from 'src/shared/data/uuid.js';
import { isPolicyAllowed, waitForPolicyLimitsToLoad } from 'src/services/policyLimits/index.js';
import { maybeActivateBrief, maybeActivateProactive } from 'src/main/lifecycle.js';
import type { BootContext } from 'src/main/bootContext.js';
import type { Props as REPLProps } from 'src/screens/REPL.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import type { FpsMetrics } from 'src/terminal/render/fpsTracker.js';
import type { StatsStore } from 'src/terminal/contexts/stats.js';

export type ResumeBranchDeps = {
  root: Root;
  ctx: BootContext;
  options: {
    resume?: string | boolean | null;
    fromPr?: string | boolean;
    forkSession?: boolean;
  };
  teleport: string | boolean | undefined;
  remote: string | null;
  debug: boolean;
  debugToStderr: boolean;
  commands: Parameters<typeof filterCommandsForRemoteMode>[0];
  ide: unknown;
  /** Mutable handle for mainThreadAgentDefinition, mutated when a resumed
   * session restores its own agent definition. */
  mainThreadAgentDefinitionRef: { current: unknown };
  thinkingConfig: unknown;
  sessionConfig: Record<string, unknown>;
  resumeContext: Parameters<typeof processResumedConversation>[2];
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore | undefined;
  initialState: AppState;
};

export async function runResumeBranch(deps: ResumeBranchDeps): Promise<void> {
  const {
    root, ctx, options, teleport, remote,
    debug, debugToStderr, commands, ide,
    mainThreadAgentDefinitionRef, thinkingConfig,
    sessionConfig, resumeContext,
    getFpsMetrics, stats, initialState,
  } = deps;

  const { clearSessionCaches } = await import('src/commands/clear/caches.js');
  clearSessionCaches();
  let messages: MessageType[] | null = null;
  let processedResume: ProcessedResume | undefined = undefined;
  let maybeSessionId = validateUuid(options.resume);
  let searchTerm: string | undefined = undefined;
  // Store full LogOption when found by custom title (for cross-worktree resume)
  let matchedLog: LogOption | null = null;
  // PR filter for --from-pr flag
  let filterByPr: boolean | number | string | undefined = undefined;

  if (options.fromPr) {
    if (options.fromPr === true) {
      filterByPr = true;
    } else if (typeof options.fromPr === 'string') {
      filterByPr = options.fromPr;
    }
  }

  // If resume value is not a UUID, try exact match by custom title first
  if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
    const trimmedValue = options.resume.trim();
    if (trimmedValue) {
      const matches = await searchSessionsByCustomTitle(trimmedValue, { exact: true });
      if (matches.length === 1) {
        matchedLog = matches[0]!;
        maybeSessionId = getSessionIdFromLog(matchedLog) ?? null;
      } else {
        searchTerm = trimmedValue;
      }
    }
  }

  // --remote and --teleport both create/resume Claude Code Web (CCR) sessions.
  if (remote !== null || teleport) {
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_sessions')) {
      return await exitWithError(root, "Error: Remote sessions are disabled by your organization's policy.", () => gracefulShutdown(1));
    }
  }
  if (remote !== null) {
    const hasInitialPrompt = remote.length > 0;
    const isRemoteTuiEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_remote_backend', false);
    if (!isRemoteTuiEnabled && !hasInitialPrompt) {
      return await exitWithError(root, 'Error: --remote requires a description.\nUsage: claude --remote "your task description"', () => gracefulShutdown(1));
    }
    logEvent('tengu_remote_create_session', {
      has_initial_prompt: String(hasInitialPrompt) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });

    const currentBranch = await getBranch();
    const createdSession = await teleportToRemoteWithErrorHandling(root, hasInitialPrompt ? remote : null, new AbortController().signal, currentBranch || undefined);
    if (!createdSession) {
      logEvent('tengu_remote_create_session_error', {
        error: 'unable_to_create_session' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      return await exitWithError(root, 'Error: Unable to create remote session', () => gracefulShutdown(1));
    }
    logEvent('tengu_remote_create_session_success', {
      session_id: createdSession.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });

    if (!isRemoteTuiEnabled) {
      process.stdout.write(`Created remote session: ${createdSession.title}\n`);
      process.stdout.write(`View: ${getRemoteSessionUrl(createdSession.id)}?m=0\n`);
      process.stdout.write(`Resume with: claude --teleport ${createdSession.id}\n`);
      await gracefulShutdown(0);
      process.exit(0);
    }

    // New behavior: start local TUI with CCR engine
    setIsRemoteMode(true);
    switchSession(asSessionId(createdSession.id));

    let apiCreds: { accessToken: string; orgUUID: string };
    try {
      apiCreds = await prepareApiRequest();
    } catch (error) {
      logError(toError(error));
      return await exitWithError(root, `Error: ${errorMessage(error) || 'Failed to authenticate'}`, () => gracefulShutdown(1));
    }

    const { getClaudeAIOAuthTokens: getTokensForRemote } = await import('src/services/auth/auth.js');
    const getAccessTokenForRemote = (): string => getTokensForRemote()?.accessToken ?? apiCreds.accessToken;
    const remoteSessionConfig = createRemoteSessionConfig(createdSession.id, getAccessTokenForRemote, apiCreds.orgUUID, hasInitialPrompt);

    const remoteSessionUrl = `${getRemoteSessionUrl(createdSession.id)}?m=0`;
    const remoteInfoMessage = createSystemMessage(`/remote-control is active. Code in CLI or at ${remoteSessionUrl}`, 'info');

    const initialUserMessage = hasInitialPrompt ? createUserMessage({ content: remote }) : null;

    const remoteInitialState = {
      ...initialState,
      remoteSessionUrl,
    };

    const remoteCommands = filterCommandsForRemoteMode(commands);
    await launchRepl(root, {
      getFpsMetrics,
      stats,
      initialState: remoteInitialState,
    }, {
      debug: debug || debugToStderr,
      commands: remoteCommands,
      initialTools: [],
      initialMessages: initialUserMessage ? [remoteInfoMessage, initialUserMessage] : [remoteInfoMessage],
      mcpClients: [],
      autoConnectIdeFlag: ide as REPLProps['autoConnectIdeFlag'],
      mainThreadAgentDefinition: mainThreadAgentDefinitionRef.current as REPLProps['mainThreadAgentDefinition'],
      disableSlashCommands: ctx.disableSlashCommands,
      remoteSessionConfig,
      thinkingConfig: thinkingConfig as REPLProps['thinkingConfig'],
    }, renderAndRun);
    return;
  } else if (teleport) {
    if (teleport === true || teleport === '') {
      logEvent('tengu_teleport_interactive_mode', {});
      logForDebugging('selectAndResumeTeleportTask: Starting teleport flow...');
      const teleportResult = await launchTeleportResumeWrapper(root);
      if (!teleportResult) {
        await gracefulShutdown(0);
        process.exit(0);
      }
      const { branchError } = await checkOutTeleportedSessionBranch(teleportResult.branch);
      messages = processMessagesForTeleportResume(teleportResult.log, branchError);
    } else if (typeof teleport === 'string') {
      logEvent('tengu_teleport_resume_session', {
        mode: 'direct' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      try {
        const sessionData = await fetchSession(teleport);
        const repoValidation = await validateSessionRepository(sessionData);

        if (repoValidation.status === 'mismatch' || repoValidation.status === 'not_in_repo') {
          const sessionRepo = repoValidation.sessionRepo;
          if (sessionRepo) {
            const knownPaths = getKnownPathsForRepo(sessionRepo);
            const existingPaths = await filterExistingPaths(knownPaths);
            if (existingPaths.length > 0) {
              const selectedPath = await launchTeleportRepoMismatchDialog(root, {
                targetRepo: sessionRepo,
                initialPaths: existingPaths,
              });
              if (selectedPath) {
                process.chdir(selectedPath);
                setCwd(selectedPath);
                setOriginalCwd(selectedPath);
              } else {
                await gracefulShutdown(0);
              }
            } else {
              throw new TeleportOperationError(`You must run claude --teleport ${teleport} from a checkout of ${sessionRepo}.`, chalk.red(`You must run claude --teleport ${teleport} from a checkout of ${chalk.bold(sessionRepo)}.\n`));
            }
          }
        } else if (repoValidation.status === 'error') {
          throw new TeleportOperationError(repoValidation.errorMessage || 'Failed to validate session', chalk.red(`Error: ${repoValidation.errorMessage || 'Failed to validate session'}\n`));
        }
        await validateGitState();

        const { teleportWithProgress } = await import('src/components/TeleportProgress.js');
        const result = await teleportWithProgress(root, teleport);
        setTeleportedSessionInfo({ sessionId: teleport });
        messages = result.messages;
      } catch (error) {
        if (error instanceof TeleportOperationError) {
          process.stderr.write(error.formattedMessage + '\n');
        } else {
          logError(error);
          process.stderr.write(chalk.red(`Error: ${errorMessage(error)}\n`));
        }
        await gracefulShutdown(1);
      }
    }
  }

  // If not loaded as a file, try as session ID
  if (maybeSessionId) {
    const sessionId = maybeSessionId;
    try {
      const resumeStart = performance.now();
      const result = await loadConversationForResume(matchedLog ?? sessionId, undefined);
      if (!result) {
        logEvent('tengu_session_resumed', {
          entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          success: false,
        });
        return await exitWithError(root, `No conversation found with session ID: ${sessionId}`);
      }
      const fullPath = matchedLog?.fullPath ?? result.fullPath;
      processedResume = await processResumedConversation(result, {
        forkSession: !!options.forkSession,
        sessionIdOverride: sessionId,
        transcriptPath: fullPath,
      }, resumeContext);
      if (processedResume.restoredAgentDef) {
        mainThreadAgentDefinitionRef.current = processedResume.restoredAgentDef;
      }
      logEvent('tengu_session_resumed', {
        entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: true,
        resume_duration_ms: Math.round(performance.now() - resumeStart),
      });
    } catch (error) {
      logEvent('tengu_session_resumed', {
        entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: false,
      });
      logError(error);
      await exitWithError(root, errorMessage(error));
    }
  }

  // Await file downloads before rendering REPL (files must be available)
  if (ctx.fileDownloadPromise) {
    try {
      const results = await ctx.fileDownloadPromise;
      const failedCount = count(results, r => !r.success);
      if (failedCount > 0) {
        process.stderr.write(chalk.yellow(`Warning: ${failedCount}/${results.length} file(s) failed to download.\n`));
      }
    } catch (error) {
      return await exitWithError(root, `Error downloading files: ${errorMessage(error)}`);
    }
  }

  // If we have a processed resume or teleport messages, render the REPL
  const resumeData = processedResume ?? (Array.isArray(messages) ? {
    messages,
    fileHistorySnapshots: undefined,
    agentName: undefined,
    agentColor: undefined as AgentColorName | undefined,
    restoredAgentDef: mainThreadAgentDefinitionRef.current,
    initialState,
    contentReplacements: undefined,
  } : undefined);
  if (resumeData) {
    maybeActivateProactive(options);
    maybeActivateBrief(options);
    await launchRepl(root, {
      getFpsMetrics,
      stats,
      initialState: resumeData.initialState,
    }, {
      ...sessionConfig,
      mainThreadAgentDefinition: (resumeData.restoredAgentDef ?? mainThreadAgentDefinitionRef.current) as AgentDefinition | undefined,
      initialMessages: resumeData.messages,
      initialFileHistorySnapshots: resumeData.fileHistorySnapshots,
      initialContentReplacements: resumeData.contentReplacements,
      initialAgentName: resumeData.agentName,
      initialAgentColor: resumeData.agentColor,
    } as Parameters<typeof launchRepl>[2], renderAndRun);
  } else {
    // Show interactive selector (includes same-repo worktrees)
    await launchResumeChooser(root, {
      getFpsMetrics,
      stats: stats as StatsStore,
      initialState,
    }, getWorktreePaths(getOriginalCwd()), {
      ...sessionConfig,
      initialSearchQuery: searchTerm,
      forkSession: options.forkSession,
      filterByPr,
    } as Parameters<typeof launchResumeChooser>[3]);
  }
}
