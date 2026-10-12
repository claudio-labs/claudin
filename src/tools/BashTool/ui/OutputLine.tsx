import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useMemo } from 'react';
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js';
import { Ansi, Text } from 'src/terminal/ink.js';
import { createHyperlink } from 'src/shared/text/hyperlink.js';
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js';
import { renderTruncatedContent } from 'src/terminal/terminal.js';
import { useTheme } from 'src/terminal/design-system/ThemeProvider.js';
import { getTheme } from 'src/terminal/theme/theme.js';
import { highlightLogText } from 'src/terminal/theme/logHighlight.js';
import { MessageResponse } from 'src/agent/ui/MessageResponse.js';
import { InVirtualListContext } from 'src/agent/ui/messageActions.js';
import { useExpandShellOutput } from 'src/tools/BashTool/ui/ExpandShellOutputContext.js';
export function tryFormatJson(line: string): string {
  try {
    const parsed = jsonParse(line);
    const stringified = jsonStringify(parsed);

    // Check if precision was lost during JSON round-trip
    // This happens when large integers exceed Number.MAX_SAFE_INTEGER
    // We normalize both strings by removing whitespace and unnecessary
    // escapes (\/ is valid but optional in JSON) for comparison
    const normalizedOriginal = line.replace(/\\\//g, '/').replace(/\s+/g, '');
    const normalizedStringified = stringified.replace(/\s+/g, '');
    if (normalizedOriginal !== normalizedStringified) {
      // Precision loss detected - return original line unformatted
      return line;
    }
    return jsonStringify(parsed, null, 2);
  } catch {
    return line;
  }
}
const MAX_JSON_FORMAT_LENGTH = 10_000;
export function tryJsonFormatContent(content: string): string {
  if (content.length > MAX_JSON_FORMAT_LENGTH) {
    return content;
  }
  const allLines = content.split('\n');
  return allLines.map(tryFormatJson).join('\n');
}

// Match http(s) URLs inside JSON string values. Conservative: no quotes,
// no whitespace, no trailing comma/brace that'd be JSON structure.
const URL_IN_JSON = /https?:\/\/[^\s"'<>\\]+/g;
export function linkifyUrlsInText(content: string): string {
  return content.replace(URL_IN_JSON, url => createHyperlink(url));
}
type OutputLineProps = {
  content: string;
  verbose?: boolean;
  isError?: boolean;
  isWarning?: boolean;
  linkifyUrls?: boolean;
  /** Show JSON as it arrived instead of pretty-printing it, one key per row. */
  rawJson?: boolean;
  /** Color log levels, timestamps and compose prefixes with the theme. Shell
   * output only: MCP results go through here too and are left plain. */
  highlightLogs?: boolean;
};
export function OutputLine(t0: OutputLineProps) {
  const $ = _c(14);
  const {
    content,
    verbose,
    isError,
    isWarning,
    linkifyUrls,
    rawJson,
    highlightLogs
  } = t0;
  const {
    columns
  } = useTerminalSize();
  const [themeName] = useTheme();
  const expandShellOutput = useExpandShellOutput();
  const inVirtualList = React.useContext(InVirtualListContext);
  const shouldShowFull = verbose || expandShellOutput;
  let t1;
  if ($[0] !== columns || $[1] !== content || $[2] !== inVirtualList || $[3] !== linkifyUrls || $[4] !== shouldShowFull || $[11] !== rawJson || $[12] !== highlightLogs || $[13] !== themeName) {
    bb0: {
      let formatted = rawJson ? content : tryJsonFormatContent(content);
      if (linkifyUrls) {
        formatted = linkifyUrlsInText(formatted);
      }
      // After truncation, so only the rows on screen are scanned.
      const highlight = (text: string) => highlightLogs ? highlightLogText(text, getTheme(themeName)) : text;
      if (shouldShowFull) {
        t1 = highlight(stripUnderlineAnsi(formatted));
        break bb0;
      }
      t1 = highlight(stripUnderlineAnsi(renderTruncatedContent(formatted, columns, inVirtualList)));
    }
    $[0] = columns;
    $[1] = content;
    $[2] = inVirtualList;
    $[3] = linkifyUrls;
    $[4] = shouldShowFull;
    $[5] = t1;
    $[11] = rawJson;
    $[12] = highlightLogs;
    $[13] = themeName;
  } else {
    t1 = $[5];
  }
  const formattedContent = t1;
  const color = isError ? "error" : isWarning ? "warning" : undefined;
  let t2;
  if ($[6] !== formattedContent) {
    t2 = <Ansi>{formattedContent}</Ansi>;
    $[6] = formattedContent;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  let t3;
  if ($[8] !== color || $[9] !== t2) {
    t3 = <MessageResponse><Text color={color}>{t2}</Text></MessageResponse>;
    $[8] = color;
    $[9] = t2;
    $[10] = t3;
  } else {
    t3 = $[10];
  }
  return t3;
}

/**
 * Underline ANSI codes in particular tend to leak out for some reason. I wasn't
 * able to figure out why, or why emitting a reset ANSI code wasn't enough to
 * prevent them from leaking. I also didn't want to strip all ANSI codes with
 * stripAnsi(), because we used to do that and people complained about losing
 * all formatting. So we just strip the underline ANSI codes specifically.
 */
export function stripUnderlineAnsi(content: string): string {
  return content.replace(
  // eslint-disable-next-line no-control-regex
  /\u001b\[([0-9]+;)*4(;[0-9]+)*m|\u001b\[4(;[0-9]+)*m|\u001b\[([0-9]+;)*4m/g, '');
}
