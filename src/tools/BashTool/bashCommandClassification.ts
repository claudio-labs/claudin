import { splitCommand_DEPRECATED, splitCommandWithOperators } from 'src/platform/bash/commands.js';
import { SEMANTIC_NEUTRAL_COMMANDS, walkCommandSegments } from 'src/platform/bash/segments.js';

// Search commands for collapsible display (grep, find, etc.)
const BASH_SEARCH_COMMANDS = new Set(['find', 'grep', 'rg', 'ag', 'ack', 'locate', 'which', 'whereis']);

// Read/view commands for collapsible display (cat, head, etc.)
const BASH_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'less', 'more',
// Analysis commands
'wc', 'stat', 'file', 'strings',
// Data processing — commonly used to parse/transform file content in pipes
'jq', 'awk', 'cut', 'sort', 'uniq', 'tr']);

// Directory-listing commands for collapsible display (ls, tree, du).
// Split from BASH_READ_COMMANDS so the summary says "Listed N directories"
// instead of the misleading "Read N files".
const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du']);

// Commands that typically produce no stdout on success
const BASH_SILENT_COMMANDS = new Set(['mv', 'cp', 'rm', 'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp', 'touch', 'ln', 'cd', 'export', 'unset', 'wait']);

/**
 * Checks if a bash command is a search or read operation.
 * Used to determine if the command should be collapsed in the UI.
 * Returns an object indicating whether it's a search or read operation.
 *
 * For pipelines (e.g., `cat file | bq`), ALL parts must be search/read commands
 * for the whole command to be considered collapsible.
 *
 * Semantic-neutral commands (echo, printf, true, false, :) are skipped in any
 * position, as they're pure output/status commands that don't affect the read/search
 * nature of the pipeline (e.g. `ls dir && echo "---" && ls dir2` is still a read).
 */
export function isSearchOrReadBashCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
  isList: boolean;
} {
  const NOT_COLLAPSIBLE = {
    isSearch: false,
    isRead: false,
    isList: false
  };
  const walked = walkCommandSegments(command);
  // null covers malformed syntax, an empty command, and a command that is only
  // operators — none of them collapsible.
  if (!walked) {
    return NOT_COLLAPSIBLE;
  }
  let hasSearch = false;
  let hasRead = false;
  let hasList = false;
  let hasNonNeutralCommand = false;
  for (const segment of walked.segments) {
    if (segment.isNeutral) {
      continue;
    }
    hasNonNeutralCommand = true;
    const isPartSearch = BASH_SEARCH_COMMANDS.has(segment.name);
    const isPartRead = BASH_READ_COMMANDS.has(segment.name);
    const isPartList = BASH_LIST_COMMANDS.has(segment.name);
    if (!isPartSearch && !isPartRead && !isPartList) {
      return NOT_COLLAPSIBLE;
    }
    if (isPartSearch) hasSearch = true;
    if (isPartRead) hasRead = true;
    if (isPartList) hasList = true;
  }

  // Only neutral commands (e.g., just "echo foo") -- not collapsible
  if (!hasNonNeutralCommand) {
    return NOT_COLLAPSIBLE;
  }
  return {
    isSearch: hasSearch,
    isRead: hasRead,
    isList: hasList
  };
}

/**
 * Checks if a bash command is expected to produce no stdout on success.
 * Used to show "Done" instead of "(No output)" in the UI.
 */
export function isSilentBashCommand(command: string): boolean {
  let partsWithOperators: string[];
  try {
    partsWithOperators = splitCommandWithOperators(command);
  } catch {
    return false;
  }
  if (partsWithOperators.length === 0) {
    return false;
  }
  let hasNonFallbackCommand = false;
  let lastOperator: string | null = null;
  let skipNextAsRedirectTarget = false;
  for (const part of partsWithOperators) {
    if (skipNextAsRedirectTarget) {
      skipNextAsRedirectTarget = false;
      continue;
    }
    if (part === '>' || part === '>>' || part === '>&') {
      skipNextAsRedirectTarget = true;
      continue;
    }
    if (part === '||' || part === '&&' || part === '|' || part === ';') {
      lastOperator = part;
      continue;
    }
    const baseCommand = part.trim().split(/\s+/)[0];
    if (!baseCommand) {
      continue;
    }
    if (lastOperator === '||' && SEMANTIC_NEUTRAL_COMMANDS.has(baseCommand)) {
      continue;
    }
    hasNonFallbackCommand = true;
    if (!BASH_SILENT_COMMANDS.has(baseCommand)) {
      return false;
    }
  }
  return hasNonFallbackCommand;
}

// Commands that should not be auto-backgrounded
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ['sleep' // Sleep should run in foreground unless explicitly backgrounded by user
];

/**
 * Checks if a command is allowed to be automatically backgrounded
 * @param command The command to check
 * @returns false for commands that should not be auto-backgrounded (like sleep)
 */
export function isAutobackgroundingAllowed(command: string): boolean {
  const parts = splitCommand_DEPRECATED(command);
  if (parts.length === 0) return true;

  // Get the first part which should be the base command
  const baseCommand = parts[0]?.trim();
  if (!baseCommand) return true;
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(baseCommand);
}

/**
 * Detect standalone or leading `sleep N` patterns that should use Monitor
 * instead. Catches `sleep 5`, `sleep 5 && check`, `sleep 5; check` — but
 * not sleep inside pipelines, subshells, or scripts (those are fine).
 */
export function detectBlockedSleepPattern(command: string): string | null {
  const parts = splitCommand_DEPRECATED(command);
  if (parts.length === 0) return null;
  const first = parts[0]?.trim() ?? '';
  // Bare `sleep N` or `sleep N.N` as the first subcommand.
  // Float durations (sleep 0.5) are allowed — those are legit pacing, not polls.
  const m = /^sleep\s+(\d+)\s*$/.exec(first);
  if (!m) return null;
  const secs = parseInt(m[1]!, 10);
  if (secs < 2) return null; // sub-2s sleeps are fine (rate limiting, pacing)

  // `sleep N` alone → "what are you waiting for?"
  // `sleep N && check` → "use Monitor { command: check }"
  const rest = parts.slice(1).join(' ').trim();
  return rest ? `sleep ${secs} followed by: ${rest}` : `standalone sleep ${secs}`;
}
