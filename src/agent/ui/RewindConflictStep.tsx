import * as path from 'path';
import * as React from 'react';
import { getCwd } from 'src/shared/fs/cwd.js';
import { plural } from 'src/shared/text/stringUtils.js';
import { Box, Text } from 'src/terminal/ink.js';
import { type OptionWithDescription, Select } from 'src/terminal/custom-select/select.js';

export type RewindConflictChoice = 'keep' | 'overwrite' | 'back';

/** How many conflicting files are listed by name before the rest are counted. */
const MAX_LISTED = 8;

/** A conflict path as the user knows it: relative to the cwd when it is inside it. */
export function conflictLabel(filePath: string, cwd: string = getCwd()): string {
  const rel = path.relative(cwd, filePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : filePath;
}

/** The step's heading and file lines, kept apart from the Select so tests read them as text. */
export function conflictLines(files: readonly string[], cwd?: string): string[] {
  const listed = files.slice(0, MAX_LISTED).map(f => `  ${conflictLabel(f, cwd)}`);
  const rest = files.length - listed.length;
  return [
    `${files.length} ${plural(files.length, 'file')} changed outside Claudin since its last edit:`,
    ...listed,
    ...(rest > 0 ? [`  … and ${rest} more`] : []),
  ];
}

const OPTIONS: OptionWithDescription<RewindConflictChoice>[] = [
  { value: 'keep', label: 'Keep my changes in these files (restore the rest)' },
  { value: 'overwrite', label: 'Overwrite them too' },
  { value: 'back', label: 'Back' },
];

type Props = {
  /** Absolute paths, from fileHistoryFindConflicts. */
  files: readonly string[];
  isDisabled?: boolean;
  onChoose: (choice: RewindConflictChoice) => void;
};

/**
 * The rewind's second step, shown only when restoring code would overwrite
 * files that changed since Claudin last wrote them. Keeping them is the
 * default; Esc goes back like "Back".
 */
export function RewindConflictStep({ files, isDisabled = false, onChoose }: Props): React.ReactNode {
  const [heading, ...fileLines] = conflictLines(files);
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text color="warning">{heading}</Text>
        {fileLines.map(line => (
          <Text key={line}>{line}</Text>
        ))}
      </Box>
      <Select
        isDisabled={isDisabled}
        options={OPTIONS}
        defaultFocusValue="keep"
        onChange={value => onChoose(value as RewindConflictChoice)}
        onCancel={() => onChoose('back')}
      />
    </Box>
  );
}
