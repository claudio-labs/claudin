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
import { getMemoryDir, getMemoryDirs } from 'src/memory/memdir/memoryDirs.js';
import { ENTRYPOINT_NAME, MEMORY_SCOPE_SPECS, type MemoryScope } from 'src/memory/memdir/memoryScopes.js';
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
import { parseMemorySubcommand, runMemorySort, runMemoryTidy } from 'src/commands/memory/tidy.js';
type DirCounts = Record<MemoryScope, number>;

/**
 * Scans the memory dirs for the `· N` on the browse rows. Cheap enough to
 * await before the dialog renders — a readdir per dir, no file reads — and
 * re-run on the way back from a browser, where a delete may have changed it.
 */
async function readDirCounts(): Promise<DirCounts> {
  const counts: DirCounts = {
    global: 0,
    private: 0,
    team: 0
  };
  // The team dir files memories in its category subdirectories; the private
  // dir's only subdirectory is the team one, counted on its own row.
  await Promise.all(getMemoryDirs().map(async dir => {
    counts[dir.scope] = await countMemoryFiles(dir.root, {
      recursive: dir.scope === 'team'
    });
  }));
  return counts;
}

/** The target `/memory global`, `/memory private` and `/memory team` open directly. */
function subcommandBrowseTarget(scope: MemoryScope): BrowseTarget | null {
  const dir = getMemoryDir(scope);
  return dir === null ? null : {
    dir: dir.root,
    title: MEMORY_SCOPE_SPECS[scope].title,
    scope
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
      {browsing !== null ? <MemoryDirBrowser dir={browsing.dir} title={browsing.title} indexPath={join(browsing.dir, ENTRYPOINT_NAME)} scope={browsing.scope} onBack={handleBack} /> : <Box flexDirection="column">
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
  if (subcommand === 'sort') {
    return runMemorySort(onDone);
  }
  // Clear + prime before rendering — Suspense handles the unprimed case,
  // but awaiting here avoids a fallback flash on initial open.
  clearMemoryFileCaches();
  const [, dirCounts] = await Promise.all([getMemoryFiles(), readDirCounts()]);
  const initialBrowse = subcommand === null ? null : subcommandBrowseTarget(subcommand);
  return <MemoryCommand onDone={onDone} initialCounts={dirCounts} initialBrowse={initialBrowse} />;
};
