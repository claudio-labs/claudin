import { c as _c } from "react-compiler-runtime";
import chalk from 'chalk';
import type { UUID } from 'crypto';
import figures from 'figures';
import * as React from 'react';
import { getOriginalCwd, getSessionId } from 'src/platform/bootstrap/state.js';
import type { CommandResultDisplay, ResumeEntrypoint } from 'src/commands/commands.js';
import { MessageResponse } from 'src/agent/ui/MessageResponse.js';
import { Spinner } from 'src/terminal/spinner/Spinner.js';
import { setClipboard } from 'src/terminal/ink/termio/osc.js';
import { Box, Text } from 'src/terminal/ink.js';
import type { LocalJSXCommandCall, LocalJSXCommandContext } from 'src/shared/types/command.js';
import type { LogOption } from 'src/shared/types/logs.js';
import { tokenCountFromLastAPIResponse } from 'src/agent/context/tokens.js';
import { listLiveSessions } from 'src/sessions/concurrentSessions.js';
import { checkCrossProjectResume } from 'src/sessions/crossProjectResume.js';
import { getInstanceSessionIds } from 'src/sessions/instanceSessions.js';
import { readSessionPresence } from 'src/sessions/sessionPresence.js';
import { describeRunningWork } from 'src/sessions/ui/sessionRows.js';
import { SessionsScreen, type SessionsScreenProps } from 'src/sessions/ui/SessionsScreen.js';
import { getWorktreePaths } from 'src/vcs/git/getWorktreePaths.js';
import { logError } from 'src/shared/log.js';
import { getCurrentSessionTitle, getLastSessionLog, getSessionIdFromLog, isCustomTitleEnabled, isLiteLog, loadAllProjectsMessageLogs, loadFullLog, loadSameRepoMessageLogs, searchSessionsByCustomTitle } from 'src/sessions/sessionStorage.js';
import { validateUuid } from 'src/shared/data/uuid.js';
type ResumeResult = {
  resultType: 'sessionNotFound';
  arg: string;
} | {
  resultType: 'multipleMatches';
  arg: string;
  count: number;
};

function resumeHelpMessage(result: ResumeResult): string {
  switch (result.resultType) {
    case 'sessionNotFound':
      return `Session ${chalk.bold(result.arg)} was not found.`;
    case 'multipleMatches':
      return `Found ${result.count} sessions matching ${chalk.bold(result.arg)}. Please use /resume to pick a specific session.`;
  }
}
function ResumeError(t0: { message: string; args: string; onDone: () => void }) {
  const $ = _c(10);
  const {
    message,
    args,
    onDone
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onDone) {
    t1 = () => {
      const timer = setTimeout(onDone, 0);
      return () => clearTimeout(timer);
    };
    t2 = [onDone];
    $[0] = onDone;
    $[1] = t1;
    $[2] = t2;
  } else {
    t1 = $[1];
    t2 = $[2];
  }
  React.useEffect(t1, t2);
  let t3;
  if ($[3] !== args) {
    t3 = <Text dimColor={true}>{figures.pointer} /resume {args}</Text>;
    $[3] = args;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  let t4;
  if ($[5] !== message) {
    t4 = <MessageResponse><Text>{message}</Text></MessageResponse>;
    $[5] = message;
    $[6] = t4;
  } else {
    t4 = $[6];
  }
  let t5;
  if ($[7] !== t3 || $[8] !== t4) {
    t5 = <Box flexDirection="column">{t3}{t4}</Box>;
    $[7] = t3;
    $[8] = t4;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  return t5;
}
function ResumeCommand({
  onDone,
  onResume,
  readCurrent,
  getRunningWork
}: {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onResume: (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => Promise<void>;
  readCurrent: NonNullable<SessionsScreenProps['readCurrent']>;
  getRunningWork: () => string | undefined;
}): React.ReactNode {
  const [logs, setLogs] = React.useState<LogOption[]>([]);
  const [worktreePaths, setWorktreePaths] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [resuming, setResuming] = React.useState(false);
  const [showAllProjects, setShowAllProjects] = React.useState(false);
  const [instanceSessionIds] = React.useState(getInstanceSessionIds);
  const loadLogs = React.useCallback(async (allProjects: boolean, paths: string[]) => {
    setLoading(true);
    try {
      const allLogs = allProjects ? await loadAllProjectsMessageLogs() : await loadSameRepoMessageLogs(paths);
      setLogs(allLogs.filter(l => !l.isSidechain));
    } catch (_err) {
      logError(_err);
      onDone('Failed to load conversations');
    } finally {
      setLoading(false);
    }
  }, [onDone]);
  React.useEffect(() => {
    async function init() {
      const paths_0 = await getWorktreePaths(getOriginalCwd());
      setWorktreePaths(paths_0);
      void loadLogs(false, paths_0);
    }
    void init();
  }, [loadLogs]);
  const handleToggleAllProjects = React.useCallback(() => {
    const newValue = !showAllProjects;
    setShowAllProjects(newValue);
    void loadLogs(newValue, worktreePaths);
  }, [showAllProjects, loadLogs, worktreePaths]);
  async function handleSelect(log: LogOption) {
    const sessionId = validateUuid(getSessionIdFromLog(log));
    if (!sessionId) {
      onDone('Failed to resume conversation');
      return;
    }

    // Load full messages for lite logs
    const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;

    // Check if this conversation is from a different directory
    const crossProjectCheck = checkCrossProjectResume(fullLog, showAllProjects, worktreePaths);
    if (crossProjectCheck.isCrossProject) {
      if (crossProjectCheck.isSameRepoWorktree) {
        // Same repo worktree - can resume directly
        setResuming(true);
        void onResume(sessionId, fullLog, 'slash_command_picker');
        return;
      }

      // Different project - show command instead of resuming
      const raw = await setClipboard(crossProjectCheck.command);
      if (raw) process.stdout.write(raw);

      // Format the output message
      const message = ['', 'This conversation is from a different directory.', '', 'To resume, run:', `  ${crossProjectCheck.command}`, '', '(Command copied to clipboard)', ''].join('\n');
      onDone(message, {
        display: 'user'
      });
      return;
    }

    // Same directory - proceed with resume
    setResuming(true);
    void onResume(sessionId, fullLog, 'slash_command_picker');
  }
  // Closing leaves nothing in the transcript: ← opens this list for a look
  // as often as for a switch, and each look would otherwise log a line.
  function handleCancel() {
    onDone(undefined, {
      display: 'skip'
    });
  }
  // The first load shows a spinner; a reload (Ctrl+A) keeps the table up.
  if (loading && logs.length === 0) {
    return <Box>
        <Spinner />
        <Text> Loading conversations…</Text>
      </Box>;
  }
  if (resuming) {
    return <Box>
        <Spinner />
        <Text> Resuming conversation…</Text>
      </Box>;
  }
  return <SessionsScreen logs={logs} loading={loading} currentSessionId={getSessionId()} readCurrent={readCurrent} instanceSessionIds={instanceSessionIds} getRunningWork={getRunningWork} onSelect={log => void handleSelect(log)} onCancel={handleCancel} onLogsChanged={() => void loadLogs(showAllProjects, worktreePaths)} showAllProjects={showAllProjects} onToggleAllProjects={handleToggleAllProjects} />;
}

/** What switching away from this conversation would stop right now. */
function runningWork(context: LocalJSXCommandContext): string | undefined {
  const presence = readSessionPresence(context.getAppState().tasks);
  return describeRunningWork({
    busy: presence.turnActive,
    runningAgents: presence.runningAgents
  });
}

/** Why `sessionId` cannot be resumed from `/resume <arg>`, if it cannot. */
async function resumeBlocker(sessionId: string, context: LocalJSXCommandContext): Promise<string | undefined> {
  const holder = (await listLiveSessions()).find(s => s.sessionId === sessionId);
  if (holder) {
    return `That session is open in another claudin (pid ${holder.pid}, ${holder.cwd}). Quit it there to continue here.`;
  }
  const work = runningWork(context);
  if (work) {
    return `Switching stops ${work} in this session. Run /resume and pick it to confirm.`;
  }
  return undefined;
}
export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const onResume = async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) => {
    try {
      await context.resume?.(sessionId, log, entrypoint);
      onDone(undefined, {
        display: 'skip'
      });
    } catch (error) {
      logError(error as Error);
      onDone(`Failed to resume: ${(error as Error).message}`);
    }
  };
  const arg = args?.trim();

  // No argument provided - show picker
  if (!arg) {
    const contextTokens = tokenCountFromLastAPIResponse(context.messages);
    const readCurrent = () => ({
      ...readSessionPresence(context.getAppState().tasks),
      title: getCurrentSessionTitle(getSessionId()),
      contextTokens: contextTokens > 0 ? contextTokens : undefined
    });
    return <ResumeCommand key={Date.now()} onDone={onDone} onResume={onResume} readCurrent={readCurrent} getRunningWork={() => runningWork(context)} />;
  }

  // Load logs to search (includes same-repo worktrees)
  const worktreePaths = await getWorktreePaths(getOriginalCwd());
  const logs = await loadSameRepoMessageLogs(worktreePaths);
  if (logs.length === 0) {
    const message = 'No conversations found to resume.';
    return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
  }
  // The picker asks before switching; a direct /resume <arg> explains instead.
  const resumeUnlessBlocked = async (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint): Promise<React.ReactNode> => {
    const blocker = await resumeBlocker(sessionId, context);
    if (blocker) {
      return <ResumeError message={blocker} args={arg} onDone={() => onDone(blocker)} />;
    }
    void onResume(sessionId, log, entrypoint);
    return null;
  };

  // First, check if arg is a valid UUID
  const maybeSessionId = validateUuid(arg);
  if (maybeSessionId) {
    const matchingLogs = logs.filter(l => getSessionIdFromLog(l) === maybeSessionId).sort((a, b) => b.modified.getTime() - a.modified.getTime());
    if (matchingLogs.length > 0) {
      const log = matchingLogs[0]!;
      const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;
      return resumeUnlessBlocked(maybeSessionId, fullLog, 'slash_command_session_id');
    }

    // Enriched logs didn't find it — try direct file lookup. This handles
    // sessions filtered out by enrichLogs (e.g., first message >16KB makes
    // firstPrompt extraction fail, causing the session to be dropped).
    const directLog = await getLastSessionLog(maybeSessionId);
    if (directLog) {
      return resumeUnlessBlocked(maybeSessionId, directLog, 'slash_command_session_id');
    }
  }

  // Next, try exact custom title match (only if feature is enabled)
  if (isCustomTitleEnabled()) {
    const titleMatches = await searchSessionsByCustomTitle(arg, {
      exact: true
    });
    if (titleMatches.length === 1) {
      const log = titleMatches[0]!;
      const sessionId = getSessionIdFromLog(log);
      if (sessionId) {
        const fullLog = isLiteLog(log) ? await loadFullLog(log) : log;
        return resumeUnlessBlocked(sessionId, fullLog, 'slash_command_title');
      }
    }

    // Multiple matches - show error
    if (titleMatches.length > 1) {
      const message = resumeHelpMessage({
        resultType: 'multipleMatches',
        arg,
        count: titleMatches.length
      });
      return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
    }
  }

  // No match found - show error
  const message = resumeHelpMessage({
    resultType: 'sessionNotFound',
    arg
  });
  return <ResumeError message={message} args={arg} onDone={() => onDone(message)} />;
};
