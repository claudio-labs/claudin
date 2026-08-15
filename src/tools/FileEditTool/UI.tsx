import { c as _c } from "react-compiler-runtime";
import type { ToolResultBlockParam, ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import type { StructuredPatchHunk } from 'diff';
import * as React from 'react';
import { Suspense, use, useState } from 'react';
import { FileEditToolUseRejectedMessage } from 'src/components/FileEditToolUseRejectedMessage.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { extractTag } from 'src/agent/messages/messages.js';
import { FallbackToolUseErrorMessage } from 'src/components/FallbackToolUseErrorMessage.js';
import { FileEditToolUpdatedMessage } from 'src/components/FileEditToolUpdatedMessage.js';
import { FilePathLink } from 'src/terminal/FilePathLink.js';
import { Box, Text } from 'src/terminal/ink.js';
import { ToolUseLoader } from 'src/components/ToolUseLoader.js';
import type { Tools } from 'src/Tool.js';
import type { Message, ProgressMessage } from 'src/types/message.js';
import { adjustHunkLineNumbers, CONTEXT_LINES } from 'src/services/git/diff.js';
import { FILE_NOT_FOUND_CWD_NOTE, getDisplayPath } from 'src/shared/fs/file.js';
import { logError } from 'src/shared/log.js';
import { getPlansDirectory } from 'src/agent/plans/plans.js';
import { readEditContext } from 'src/shared/fs/readEditContext.js';
import { firstLineOf } from 'src/shared/text/stringUtils.js';
import type { ThemeName } from 'src/terminal/theme/theme.js';
import { FILE_CLIPPED_VIEW_ERROR, FILE_NOT_READ_ERROR, FILE_PARTIAL_VIEW_ERROR } from 'src/tools/FileEditTool/constants.js';
import { inputSchema } from 'src/tools/FileEditTool/types.js';
import type { FileEditInput, FileEditOutput } from 'src/tools/FileEditTool/types.js';
import { findActualString, getPatchForEdit, groupEditsByFile, preserveQuoteStyle } from 'src/tools/FileEditTool/utils.js';
export function userFacingName(input: Partial<{
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
  edits: unknown[];
}> | undefined): string {
  if (!input) {
    return 'Update';
  }
  if (input.file_path?.startsWith(getPlansDirectory())) {
    return 'Updated plan';
  }
  // Hashline edits always modify an existing file (line-ref based)
  if (input.edits != null) {
    return 'Update';
  }
  if (input.old_string === '') {
    return 'Create';
  }
  return 'Update';
}
export function getToolUseSummary(input: Partial<{
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}> | undefined): string | null {
  if (!input?.file_path) {
    return null;
  }
  return getDisplayPath(input.file_path);
}
export function renderToolUseMessage({
  file_path
}: {
  file_path?: string;
}, {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  if (!file_path) {
    return null;
  }
  // For plan files, path is already in userFacingName
  if (file_path.startsWith(getPlansDirectory())) {
    return '';
  }
  return <FilePathLink filePath={file_path}>
      {verbose ? file_path : getDisplayPath(file_path)}
    </FilePathLink>;
}
export function renderToolResultMessage({
  filePath,
  structuredPatch,
  originalFile
}: FileEditOutput, _progressMessagesForMessage: ProgressMessage[], {
  style,
  verbose
}: {
  style?: 'condensed';
  verbose: boolean;
}): React.ReactNode {
  // For plan files, show /plan hint above the diff
  const isPlanFile = filePath.startsWith(getPlansDirectory());
  return <FileEditToolUpdatedMessage filePath={filePath} structuredPatch={structuredPatch} firstLine={originalFile.split('\n')[0] ?? null} fileContent={originalFile} style={style} verbose={verbose} previewHint={isPlanFile ? '/plan to preview' : undefined} />;
}
export function renderToolUseRejectedMessage(input: {
  file_path: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  edits?: unknown[];
}, options: {
  columns: number;
  messages: Message[];
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  theme: ThemeName;
  tools: Tools;
  verbose: boolean;
}): React.ReactElement {
  const {
    style,
    verbose
  } = options;
  const filePath = input.file_path;
  const oldString = input.old_string ?? '';
  const newString = input.new_string ?? '';
  const replaceAll = input.replace_all ?? false;

  // Defensive: if input has an unexpected shape, show a simple rejection message
  if ('edits' in input && input.edits != null) {
    return <FileEditToolUseRejectedMessage file_path={filePath} operation="update" firstLine={null} verbose={verbose} />;
  }
  const isNewFile = oldString === '';

  // For new file creation, show content preview instead of diff
  if (isNewFile) {
    return <FileEditToolUseRejectedMessage file_path={filePath} operation="write" content={newString} firstLine={firstLineOf(newString)} verbose={verbose} />;
  }
  return <EditRejectionDiff filePath={filePath} oldString={oldString} newString={newString} replaceAll={replaceAll} style={style} verbose={verbose} />;
}
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], options: {
  progressMessagesForMessage: ProgressMessage[];
  tools: Tools;
  verbose: boolean;
}): React.ReactElement {
  const {
    verbose
  } = options;
  if (!verbose && typeof result === 'string' && extractTag(result, 'tool_use_error')) {
    const errorMessage = extractTag(result, 'tool_use_error');
    // Show a less scary message for intended behavior
    if (errorMessage?.includes(FILE_NOT_READ_ERROR)) {
      return <MessageResponse>
          <Text dimColor>File must be read first</Text>
        </MessageResponse>;
    }
    if (errorMessage?.includes(FILE_PARTIAL_VIEW_ERROR) || errorMessage?.includes(FILE_CLIPPED_VIEW_ERROR)) {
      return <MessageResponse>
          <Text dimColor>File must be re-read in full</Text>
        </MessageResponse>;
    }
    if (errorMessage?.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return <MessageResponse>
          <Text color="error">File not found</Text>
        </MessageResponse>;
    }
    return <MessageResponse>
        <Text color="error">Error editing file</Text>
      </MessageResponse>;
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />;
}
type RejectionDiffData = {
  patch: StructuredPatchHunk[];
  firstLine: string | null;
  fileContent: string | undefined;
};
function EditRejectionDiff(t0: {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
  style?: 'condensed';
  verbose: boolean;
}) {
  const $ = _c(16);
  const {
    filePath,
    oldString,
    newString,
    replaceAll,
    style,
    verbose
  } = t0;
  let t1;
  if ($[0] !== filePath || $[1] !== newString || $[2] !== oldString || $[3] !== replaceAll) {
    t1 = () => loadRejectionDiff(filePath, oldString, newString, replaceAll);
    $[0] = filePath;
    $[1] = newString;
    $[2] = oldString;
    $[3] = replaceAll;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const [dataPromise] = useState(t1);
  let t2;
  if ($[5] !== filePath || $[6] !== verbose) {
    t2 = <FileEditToolUseRejectedMessage file_path={filePath} operation="update" firstLine={null} verbose={verbose} />;
    $[5] = filePath;
    $[6] = verbose;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  let t3;
  if ($[8] !== dataPromise || $[9] !== filePath || $[10] !== style || $[11] !== verbose) {
    t3 = <EditRejectionBody promise={dataPromise} filePath={filePath} style={style} verbose={verbose} />;
    $[8] = dataPromise;
    $[9] = filePath;
    $[10] = style;
    $[11] = verbose;
    $[12] = t3;
  } else {
    t3 = $[12];
  }
  let t4;
  if ($[13] !== t2 || $[14] !== t3) {
    t4 = <Suspense fallback={t2}>{t3}</Suspense>;
    $[13] = t2;
    $[14] = t3;
    $[15] = t4;
  } else {
    t4 = $[15];
  }
  return t4;
}
function EditRejectionBody(t0: {
  promise: Promise<RejectionDiffData>;
  filePath: string;
  style?: 'condensed';
  verbose: boolean;
}) {
  const $ = _c(7);
  const {
    promise,
    filePath,
    style,
    verbose
  } = t0;
  const {
    patch,
    firstLine,
    fileContent
  } = use(promise);
  let t1;
  if ($[0] !== fileContent || $[1] !== filePath || $[2] !== firstLine || $[3] !== patch || $[4] !== style || $[5] !== verbose) {
    t1 = <FileEditToolUseRejectedMessage file_path={filePath} operation="update" patch={patch} firstLine={firstLine} fileContent={fileContent} style={style} verbose={verbose} />;
    $[0] = fileContent;
    $[1] = filePath;
    $[2] = firstLine;
    $[3] = patch;
    $[4] = style;
    $[5] = verbose;
    $[6] = t1;
  } else {
    t1 = $[6];
  }
  return t1;
}
async function loadRejectionDiff(filePath: string, oldString: string, newString: string, replaceAll: boolean): Promise<RejectionDiffData> {
  try {
    // Chunked read — context window around the first occurrence. replaceAll
    // still shows matches *within* the window via getPatchForEdit; we accept
    // losing the all-occurrences view to keep the read bounded.
    const ctx = await readEditContext(filePath, oldString, CONTEXT_LINES);
    if (ctx === null || ctx.truncated || ctx.content === '') {
      // ENOENT / not found / truncated — diff just the tool inputs.
      const {
        patch
      } = getPatchForEdit({
        filePath,
        fileContents: oldString,
        oldString,
        newString
      });
      return {
        patch,
        firstLine: null,
        fileContent: undefined
      };
    }
    const actualOld = findActualString(ctx.content, oldString) || oldString;
    const actualNew = preserveQuoteStyle(oldString, actualOld, newString);
    const {
      patch
    } = getPatchForEdit({
      filePath,
      fileContents: ctx.content,
      oldString: actualOld,
      newString: actualNew,
      replaceAll
    });
    return {
      patch: adjustHunkLineNumbers(patch, ctx.lineOffset - 1),
      firstLine: ctx.lineOffset === 1 ? firstLineOf(ctx.content) : null,
      fileContent: ctx.content
    };
  } catch (e) {
    // User may have manually applied the change while the diff was shown.
    logError(e as Error);
    return {
      patch: [],
      firstLine: null,
      fileContent: undefined
    };
  }
}

// One edit resolved into the data the grouped renderer needs.
type GroupedEditItem = {
  filePath: string;
  param: ToolUseBlockParam;
  input: FileEditInput | undefined;
  output: FileEditOutput | undefined;
  isError: boolean;
  isInProgress: boolean;
  errorContent: ToolResultBlockParam['content'] | undefined;
};

// Renders the diff body for a single edit: the diff when resolved, a short
// error line when it failed, or nothing while it's still in progress (the
// header spinner already signals the pending state).
function renderGroupedEditBody(item: GroupedEditItem, isPlan: boolean, tools: Tools): React.ReactNode {
  if (item.isError) {
    return renderToolUseErrorMessage(item.errorContent, {
      progressMessagesForMessage: [],
      tools,
      verbose: false
    });
  }
  if (!item.output) {
    return null;
  }
  return <FileEditToolUpdatedMessage filePath={item.output.filePath} structuredPatch={item.output.structuredPatch} firstLine={item.output.originalFile.split('\n')[0] ?? null} fileContent={item.output.originalFile} verbose={false} previewHint={isPlan ? '/plan to preview' : undefined} />;
}

// Renders the bold "Update" / "Updated plan" header followed by "(path)",
// matching the single-block header in AssistantToolUseMessage.
function GroupedEditHeader({
  input,
  filePath,
  isPlan,
  isUnresolved,
  isError,
  shouldAnimate
}: {
  input: FileEditInput | undefined;
  filePath: string;
  isPlan: boolean;
  isUnresolved: boolean;
  isError: boolean;
  shouldAnimate: boolean;
}): React.ReactNode {
  return <Box flexDirection="row">
      <ToolUseLoader shouldAnimate={shouldAnimate && isUnresolved} isUnresolved={isUnresolved} isError={isError} />
      <Box flexShrink={0}><Text bold>{userFacingName(input)}</Text></Box>
      {filePath !== '' && !isPlan && <Box flexWrap="nowrap"><Text>(<FilePathLink filePath={filePath}>{getDisplayPath(filePath)}</FilePathLink>)</Text></Box>}
    </Box>;
}

/**
 * Collapses several parallel Edit tool uses (same API response) so the same
 * file shows a single "Update(path)" header with its diffs stacked underneath,
 * instead of one header per edit. Sub-groups by file path (one header per
 * file); a file with a single edit renders as one header + one body, visually
 * identical to the per-block path, while 2+ edits to a file collapse under a
 * shared header. Plan files keep today's per-edit rendering.
 *
 * Always renders (never returns null): applyGrouping only routes here for 2+
 * Edit blocks from one response and has already removed the individual
 * messages, so a null return would hide them (Message.tsx draws a null
 * grouped_tool_use as nothing). Skipped entirely in verbose mode, where
 * applyGrouping does not group. Display-only: does not affect the
 * tool_use/tool_result sent to the model.
 */
export function renderGroupedFileEditToolUse(toolUses: Array<{
  param: ToolUseBlockParam;
  isResolved: boolean;
  isError: boolean;
  isInProgress: boolean;
  progressMessages: ProgressMessage[];
  result?: {
    param: ToolResultBlockParam;
    output: unknown;
  };
}>, options: {
  shouldAnimate: boolean;
  tools: Tools;
}): React.ReactNode | null {
  const {
    shouldAnimate,
    tools
  } = options;
  const items: GroupedEditItem[] = toolUses.map(tu => {
    const parsed = inputSchema().safeParse(tu.param.input);
    const input = parsed.success ? parsed.data : undefined;
    const output = tu.result?.output as FileEditOutput | undefined;
    return {
      filePath: input?.file_path ?? output?.filePath ?? '',
      param: tu.param,
      input,
      output,
      isError: tu.isError,
      isInProgress: tu.isInProgress,
      errorContent: tu.result?.param.content
    };
  });
  const groups = groupEditsByFile(items);

  // Always render every edit here: applyGrouping has already removed the
  // individual tool_use/tool_result messages, so returning null would hide
  // them (Message.tsx renders a null grouped_tool_use as nothing). A file with
  // a single edit renders as one header + one body, visually identical to the
  // per-block path; only a file with 2+ edits collapses under a shared header.
  return <Box flexDirection="column">
      {groups.map((group, groupIndex) => {
        const isPlan = group.filePath.startsWith(getPlansDirectory());
        // Plan files keep today's behavior: each edit renders as its own
        // header + body (not collapsed under a shared header).
        if (isPlan) {
          return group.items.map(item => <Box key={item.param.id} flexDirection="column" marginTop={1}>
                <GroupedEditHeader input={item.input} filePath={group.filePath} isPlan={isPlan} isUnresolved={item.isInProgress} isError={item.isError} shouldAnimate={shouldAnimate} />
                {renderGroupedEditBody(item, isPlan, tools)}
              </Box>);
        }
        const anyInProgress = group.items.some(i => i.isInProgress);
        const anyError = group.items.some(i => i.isError);
        return <Box key={group.filePath || groupIndex} flexDirection="column" marginTop={1}>
            <GroupedEditHeader input={group.items[0]?.input} filePath={group.filePath} isPlan={isPlan} isUnresolved={anyInProgress} isError={anyError} shouldAnimate={shouldAnimate} />
            {group.items.map(item => <React.Fragment key={item.param.id}>{renderGroupedEditBody(item, isPlan, tools)}</React.Fragment>)}
          </Box>;
      })}
    </Box>;
}
