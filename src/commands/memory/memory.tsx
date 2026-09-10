import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import * as React from 'react';
import { useCallback, useState } from 'react';
import type { CommandResultDisplay } from 'src/commands/commands.js';
import { Dialog } from 'src/terminal/design-system/Dialog.js';
import { MemoryDirBrowser } from 'src/memory/ui/MemoryDirBrowser.js';
import { MemoryFileSelector } from 'src/memory/ui/MemoryFileSelector.js';
import { getRelativeMemoryPath } from 'src/memory/ui/MemoryUpdateNotification.js';
import { Box, Link, Text } from 'src/terminal/ink.js';
import type { LocalJSXCommandCall } from 'src/shared/types/command.js';
import { clearMemoryFileCaches, getMemoryFiles } from 'src/memory/instructions/claudemd.js';
import { ENTRYPOINT_NAME } from 'src/memory/memdir/memdir.js';
import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memory/memdir/paths.js';
import {
  countMemoryFiles,
  parseBrowseValue,
  TIDY_VALUE,
  type BrowseTarget
} from 'src/memory/ui/memoryDirRows.js';
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js';
import { getErrnoCode } from 'src/shared/errors.js';
import { logError } from 'src/shared/log.js';
import { editFileInEditor } from 'src/terminal/input/promptEditor.js';
import { parseMemorySubcommand, runMemoryTidy } from 'src/commands/memory/tidy.js';
import { resolveTidyTeamRoot } from 'src/commands/memory/tidyTeam.js';
type DirCounts = {
  private: number;
  team: number;
};

/**
 * Scans both memory dirs for the `· N` on the browse rows. Cheap enough to
 * await before the dialog renders — a readdir per dir, no file reads — and
 * re-run on the way back from a browser, where a delete may have changed it.
 */
async function readDirCounts(): Promise<DirCounts> {
  if (!isAutoMemoryEnabled()) {
    return {
      private: 0,
      team: 0
    };
  }
  const teamRoot = resolveTidyTeamRoot();
  const [privateCount, teamCount] = await Promise.all([countMemoryFiles(getAutoMemPath()), teamRoot === null ? Promise.resolve(0) : countMemoryFiles(teamRoot)]);
  return {
    private: privateCount,
    team: teamCount
  };
}

/** The target `/memory private` and `/memory team` open directly. */
function subcommandBrowseTarget(subcommand: 'private' | 'team'): BrowseTarget | null {
  if (!isAutoMemoryEnabled()) {
    return null;
  }
  if (subcommand === 'team') {
    const dir = resolveTidyTeamRoot();
    return dir === null ? null : {
      dir,
      title: 'Team memory',
      isTeamDir: true
    };
  }
  return {
    dir: getAutoMemPath(),
    title: 'Private memory',
    isTeamDir: false
  };
}
function MemoryCommand({
  onDone,
  initialCounts,
  initialBrowse
}: {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  initialCounts: DirCounts;
  initialBrowse: BrowseTarget | null;
}): React.ReactNode {
  const [dirCounts, setDirCounts] = useState(initialCounts);
  const [browsing, setBrowsing] = useState<BrowseTarget | null>(initialBrowse);
  const handleSelectMemoryFile = async (memoryPath: string) => {
    try {
      // Create claude directory if it doesn't exist (idempotent with recursive)
      if (memoryPath.includes(getClaudinConfigHomeDir())) {
        await mkdir(getClaudinConfigHomeDir(), {
          recursive: true
        });
      }

      // Create file if it doesn't exist (wx flag fails if file exists,
      // which we catch to preserve existing content)
      try {
        await writeFile(memoryPath, '', {
          encoding: 'utf8',
          flag: 'wx'
        });
      } catch (e: unknown) {
        if (getErrnoCode(e) !== 'EEXIST') {
          throw e;
        }
      }
      await editFileInEditor(memoryPath);

      // Determine which environment variable controls the editor
      let editorSource = 'default';
      let editorValue = '';
      if (process.env.VISUAL) {
        editorSource = '$VISUAL';
        editorValue = process.env.VISUAL;
      } else if (process.env.EDITOR) {
        editorSource = '$EDITOR';
        editorValue = process.env.EDITOR;
      }
      const editorInfo = editorSource !== 'default' ? `Using ${editorSource}="${editorValue}".` : '';
      const editorHint = editorInfo ? `> ${editorInfo} To change editor, set $EDITOR or $VISUAL environment variable.` : `> To use a different editor, set the $EDITOR or $VISUAL environment variable.`;
      onDone(`Opened memory file at ${getRelativeMemoryPath(memoryPath)}\n\n${editorHint}`, {
        display: 'system'
      });
    } catch (error) {
      logError(error);
      onDone(`Error opening memory file: ${error}`);
    }
  };
  const handleSelect = useCallback((value: string) => {
    if (value === TIDY_VALUE) {
      runMemoryTidy(onDone);
      return;
    }
    const target = parseBrowseValue(value);
    if (target !== null) {
      setBrowsing(target);
      return;
    }
    void handleSelectMemoryFile(value);
    // handleSelectMemoryFile closes over onDone only, and is redefined every
    // render like the original — the dep list stays on onDone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDone]);
  const handleBack = useCallback(() => {
    setBrowsing(null);
    // A delete inside the browser moves the count the main list is showing.
    void readDirCounts().then(setDirCounts, logError);
  }, []);
  const handleCancel = () => {
    onDone('Cancelled memory editing', {
      display: 'system'
    });
  };
  // While browsing, the Dialog's own Esc is disarmed so the Select's cancel can
  // mean "back" instead of "close" — and its guide is hidden with it, since the
  // browser prints its own and two conflicting hints is worse than none.
  return <Dialog title="Memory" onCancel={handleCancel} color="remember" isCancelActive={browsing === null} hideInputGuide={browsing !== null}>
      {browsing !== null ? <MemoryDirBrowser dir={browsing.dir} title={browsing.title} indexPath={join(browsing.dir, ENTRYPOINT_NAME)} isTeamDir={browsing.isTeamDir} onBack={handleBack} /> : <Box flexDirection="column">
          <React.Suspense fallback={null}>
            <MemoryFileSelector onSelect={handleSelect} onCancel={handleCancel} dirCounts={dirCounts} />
          </React.Suspense>

          <Box marginTop={1}>
            <Text dimColor>
              Learn more: <Link url="https://code.claude.com/docs/en/memory" />
            </Text>
          </Box>
        </Box>}
    </Dialog>;
}
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const subcommand = parseMemorySubcommand(args);
  if (subcommand === 'tidy') {
    return runMemoryTidy(onDone);
  }
  // Clear + prime before rendering — Suspense handles the unprimed case,
  // but awaiting here avoids a fallback flash on initial open.
  clearMemoryFileCaches();
  const [, dirCounts] = await Promise.all([getMemoryFiles(), readDirCounts()]);
  const initialBrowse = subcommand === null ? null : subcommandBrowseTarget(subcommand);
  return <MemoryCommand onDone={onDone} initialCounts={dirCounts} initialBrowse={initialBrowse} />;
};
